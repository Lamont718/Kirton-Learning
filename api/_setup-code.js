// Reading a setup code well enough to refuse a bad one.
//
// The code is made in the OTHER app (kirton-learn, `lib/handoff.js`): the goals
// from a child's IEP, deflated and base64url'd, with a checksum on the end.
// This side never makes one and never changes one. It takes what was pasted
// into the admin desk, and answers one question: **would the work app accept
// this?**
//
// ★★★ WHY VALIDATE AT ALL, HERE, WHERE NOTHING READS THE GOALS.
// Because this is the moment the code is pasted, and the failure it is pasted
// into is silent. A code that got cut short — dragged past the end of a
// selection, wrapped by the app it was copied out of — still looks like a code.
// Stored unchecked, the next person to find out is a mother whose link opens on
// a refusal, days later, with nothing she can do about it. Refusing at the desk
// costs one paste; refusing at her phone costs a week.
//
// ⛔ It decompresses ONLY to check the checksum and the kind, and it keeps
// nothing: no goal text is returned, logged or stored by this file. The count
// of goals goes back to the desk so the person pasting can see it is the right
// child's setup, and that count is not written to the database.
//
// ⚠️ THE ONE RULE THIS FILE MUST KEEP: it is a second implementation of a
// format defined somewhere else, so it may only ever get STRICTER than the work
// app, never looser. A code this refuses and the app would have taken is a loud
// failure at the desk. A code this accepts and the app refuses is a family
// holding a dead link.

const zlib = require('zlib');

const TAG = 'KL1';
const SETUP_KIND = 'kirton-learn-setup';
// A setup for a whole IEP is around 1KB of code. Ten times that is not a setup.
const MAX_CODE = 12000;

// Same hash as lib/handoff.js. Thirty-two bits, over the JSON text.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ★★ Found by its SHAPE inside whatever was pasted — a bare code, a whole link,
// or a link with "here you go" typed around it. Whitespace comes out first,
// because a wrapped link arrives with a newline sitting in the payload and
// reading up to the first space would quietly drop half of it.
function codeFrom(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, '');
  if (!t) return '';
  const shaped = t.match(new RegExp(`${TAG}\\.[cr]\\.[A-Za-z0-9_-]+\\.[0-9a-f]{8}`));
  if (shaped) return shaped[0];
  const inLink = t.match(/[#&?]join=([^&]+)/);
  return inLink ? inLink[1] : t;
}

/**
 * @returns {{ok:true, code:string, goals:number, madeOn:string|null}
 *          | {ok:false, why:string}}
 */
function readSetupCode(pasted) {
  const code = codeFrom(pasted);
  if (!code) return { ok: false, why: 'Paste the setup link from the work app.' };
  if (code.length > MAX_CODE) {
    return { ok: false, why: 'That is far longer than a setup code. Nothing was stored.' };
  }

  const parts = code.split('.');
  if (parts[0] !== TAG) {
    return {
      ok: false,
      why: 'That is not a setup link. Make one in the work app: Goals, then ' +
        '"Set another device up the same way".',
    };
  }
  // ★★ Opens like ours and is the wrong shape ⇒ it was CUT, not mistyped. The
  // checksum is the last thing on the end, so truncation takes the fourth part
  // with it. Saying "that is not a setup link" would send him hunting the wrong
  // problem — the same sentence the work app is careful not to use here.
  if (parts.length !== 4) {
    return { ok: false, why: 'That code is incomplete — it was cut short when it was copied. Nothing was stored.' };
  }
  const [, mode, payload, sum] = parts;
  if (mode !== 'c' && mode !== 'r') return { ok: false, why: 'That is not a setup link.' };

  let json;
  try {
    const bytes = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    json = (mode === 'c' ? zlib.inflateRawSync(bytes) : bytes).toString('utf8');
  } catch (err) {
    return { ok: false, why: 'That code is incomplete or damaged — copy it again. Nothing was stored.' };
  }
  if (fnv1a(json) !== sum) {
    return { ok: false, why: 'That code is incomplete — the end of it is missing. Nothing was stored.' };
  }

  let data;
  try { data = JSON.parse(json); } catch (err) { data = null; }
  if (!data || data.kind !== SETUP_KIND || !Array.isArray(data.goals) || !data.goals.length) {
    return { ok: false, why: 'That code does not hold a setup. Nothing was stored.' };
  }
  // ⛔⛔ The rule the work app enforces at the other end, enforced here too, so
  // a code carrying checks is stopped before it is stored rather than after it
  // is opened: a check that arrives with a setup is a check nobody did.
  const carriesChecks = (Array.isArray(data.attempts) && data.attempts.length) ||
    data.goals.some((g) => g && Array.isArray(g.attempts) && g.attempts.length);
  if (carriesChecks) {
    return { ok: false, why: 'That code carries checks, and a setup never should. Nothing was stored.' };
  }
  // A name has no business in a setup code — the work app does not put one in.
  if (typeof data.name === 'string' && data.name.trim()) {
    return { ok: false, why: "That code has a child's name in it, which a setup code never carries. Nothing was stored." };
  }

  return {
    ok: true,
    code,
    goals: data.goals.length,
    madeOn: typeof data.madeOn === 'string' ? data.madeOn : null,
  };
}

module.exports = { readSetupCode, codeFrom, fnv1a, TAG, SETUP_KIND, MAX_CODE };
