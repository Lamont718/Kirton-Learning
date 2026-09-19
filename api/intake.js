// POST /api/intake
// Body: { action: 'check' | 'submit', token, ...answers }
//
// The six questions privacy.html has promised since launch. It names them
// verbatim under "Information you give me": the child's first name, grade,
// what's going well, what's hard, what they're into, and how best to reach
// you. This is the endpoint behind that sentence.
//
// SCOPE.md governs the field list. Reading, writing, math. There is no
// behavior field, no regulation field, no sensory field, no communication
// field, and adding one would be a claim about what this business does, not a
// form change. If a parent volunteers something clinical in her own words we
// keep her words — we do not filter a mother's sentences — but we never ask.
//
// Nothing a parent types here goes to any third party. Not to email, not to
// analytics. `analytics.js` already refuses to load a beacon on any URL
// carrying `t=`, and /intake is on its NEVER list as well.

const { reject, supabase, parseJson } = require('./_common');

const UUID_RE = /^[0-9a-f-]{36}$/i;

// Caps, not validation theater. A phone keyboard and a tired parent at 10pm:
// long enough to say the real thing, short enough that a paste of the whole
// IEP is refused here rather than silently stored in the wrong place.
const LIMITS = {
  childFirstName: 40,
  grade: 24,
  goingWell: 1200,
  whatsHard: 1200,
  interests: 600,
  bestContact: 120,
};

// Same sentence for every dead link, so this endpoint cannot be used to find
// out which tokens exist. Matches upload-url.js word for word on purpose.
const DEAD = 'That link has expired. Email me and I will send a fresh one.';
const BAD = 'That link is not valid.';

function clean(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\r\n/g, '\n').trim().slice(0, max);
  return s.length ? s : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const rest = supabase();
  // Fail closed. Until the env vars are wired, the form is simply not open and
  // says so — it does not collect six answers into nowhere.
  if (!rest) {
    return reject(res, 503, 'This form is not open yet. Nothing has been sent or stored.');
  }

  const body = parseJson(req);
  if (!body) return reject(res, 400, 'That did not come through. Try once more.');

  const action = String(body.action || '');
  const token = String(body.token || '');
  if (!UUID_RE.test(token)) return reject(res, 400, BAD);

  // ---- the token must be real, unrevoked and unexpired ----
  //
  // `used_at` is deliberately NOT a bar here, and this is the whole design.
  // The upload burns `used_at` the moment the IEP lands, and the IEP is the
  // thing the email asks for first. If intake also died on that flag, the form
  // would be closed for every parent who did the main task — the normal path
  // would be the broken one. One link, two independent one-time uses: the
  // upload is guarded by `used_at`, the intake by the primary key on `intakes`.
  async function loadToken() {
    const r = await rest(
      `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}` +
        `&select=token,child_label,expires_at,revoked_at,intake_at`,
      { method: 'GET' }
    );
    // `intake_at` arrives with supabase-setup-3.sql. Until that has been run
    // PostgREST answers 400 for the whole SELECT. Say so plainly rather than
    // showing a parent a 500 — and name the file, for whoever is reading the
    // response at the other end.
    if (r.status === 400) return { setup: true };
    if (!r.ok) return { error: 502 };

    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { dead: BAD, status: 403 };
    if (row.revoked_at) return { dead: DEAD, status: 403 };
    if (new Date(row.expires_at).getTime() < Date.now()) return { dead: DEAD, status: 403 };
    return { row };
  }

  try {
    const got = await loadToken();

    if (got.setup) {
      return res.status(503).json({
        ok: false,
        message: 'This form is not open yet. Nothing has been sent or stored.',
        setup: 'supabase-setup-3.sql',
      });
    }
    if (got.error) return reject(res, 502, 'Something went wrong on my end. Try again shortly.');
    if (got.dead) return reject(res, got.status, got.dead);

    const row = got.row;

    // -----------------------------------------------------------------
    // check — what should the page show?
    // -----------------------------------------------------------------
    if (action === 'check') {
      return res.status(200).json({
        ok: true,
        state: row.intake_at ? 'done' : 'open',
        // First name only, and only so the page can name her child instead of
        // making her type it twice. Never a full name: see the column comment
        // in supabase-setup.sql.
        childLabel: row.child_label || null,
      });
    }

    // -----------------------------------------------------------------
    // submit — store the answers, then stamp the token
    // -----------------------------------------------------------------
    if (action === 'submit') {
      const a = {
        child_first_name: clean(body.childFirstName, LIMITS.childFirstName),
        grade: clean(body.grade, LIMITS.grade),
        going_well: clean(body.goingWell, LIMITS.goingWell),
        whats_hard: clean(body.whatsHard, LIMITS.whatsHard),
        interests: clean(body.interests, LIMITS.interests),
        best_contact: clean(body.bestContact, LIMITS.bestContact),
      };

      // Two required fields and no more. Everything else is optional because a
      // blank answer is information too, and because a form that refuses to
      // submit at 10pm is a form that does not get submitted.
      if (!a.child_first_name) {
        return reject(res, 400, 'I need your child’s first name to start.');
      }
      if (!a.grade) {
        return reject(res, 400, 'Tell me what grade they are in.');
      }

      const insert = await rest('/rest/v1/intakes', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ token, ...a }),
      });

      // The primary key already rejected a second submit. That is not an error
      // the parent needs to see as one: her answers are in, which is the thing
      // she was trying to make true.
      if (insert.status === 409) {
        return res.status(200).json({ ok: true, state: 'done', already: true });
      }
      if (!insert.ok) {
        return reject(res, 502, 'That did not save. Try once more, and email me if it keeps failing.');
      }

      // The mirror on the token row. Best effort on purpose: the answers are
      // already stored and the primary key is what stops a duplicate, so a
      // failure here costs a line on the admin list and nothing a family owns.
      let stamped = true;
      try {
        const patch = await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}`, {
          method: 'PATCH',
          body: JSON.stringify({ intake_at: new Date().toISOString() }),
        });
        stamped = patch.ok;
      } catch {
        stamped = false;
      }

      return res.status(200).json({ ok: true, state: 'done', stamped });
    }

    return reject(res, 400, 'That did not come through. Try once more.');
  } catch (err) {
    // Never leak internals to the page.
    return reject(res, 500, 'Something went wrong on my end. Try again shortly.');
  }
};
