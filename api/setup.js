// POST /api/setup   Body: { token }
//
// Hands a family the setup we built from their child's IEP: the goals, the
// engine chosen for each, the criterion in the document's own words, the
// cadence, the accommodations. It is the only route out of this database that
// returns anything read out of an IEP, and it exists because the alternative
// was emailing it.
//
// ⛔⛔ WHY NOT JUST EMAIL THE LINK. It holds the goals verbatim. CLAUDE.md:
// never send IEP contents to a third-party API without Lamont approving it,
// and an email provider is a third-party API. So the email carries a token and
// this endpoint carries the goals, over TLS, to the one person entitled to
// them. ★ It also means the 700-character link never has to survive an inbox.
//
// ⚠️ NOT ONE-TIME, ON PURPOSE. The IEP link burns on use because the upload is
// the event. Here the event is a mother adding the goals on her device, which
// no server can see — and she may well do it twice, once on the phone and once
// on the tablet, which the work app is built to allow. Burning this on first
// open would take the second device away from her and look, from here, exactly
// like success. It expires, and it can be revoked.

const { reject, supabase, parseJson, appOrigin, joinLink } = require('./_common');

const UUID_RE = /^[0-9a-f-]{36}$/i;

// ⛔ One sentence for every reason a token does not work. A different message
// per case would turn this into a way to find out which tokens exist.
const NO =
  'That setup link is not valid, or it has expired. Reply to the email I sent ' +
  'and I will send you a fresh one — it costs you nothing.';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const rest = supabase();
  // Fail closed, and say nothing about the schema to a parent. The admin desk's
  // `status` action is where a missing migration announces itself.
  if (!rest) return reject(res, 503, 'This is not open yet. Nothing has been sent or stored.');

  const body = parseJson(req);
  const token = String((body && body.token) || '');
  if (!UUID_RE.test(token)) return reject(res, 400, NO);

  try {
    const r = await rest(
      `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}` +
        '&select=token,kind,setup_code,child_label,expires_at,revoked_at,used_at',
      { method: 'GET' }
    );
    // ⚠️ PostgREST answers 400 for the WHOLE select when setup_code does not
    // exist — i.e. supabase-setup-5.sql has not been run. There is no useful
    // fallback here, because the column IS the feature; what matters is that
    // this reads as "not open yet" rather than as a broken link the family
    // will keep retrying.
    if (r.status === 400) {
      return reject(res, 503, 'This is not open yet. Nothing has been sent or stored.');
    }
    if (!r.ok) return reject(res, 502, 'Something went wrong on my end. Try again shortly.');

    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.kind !== 'setup' || !row.setup_code) return reject(res, 403, NO);
    if (row.revoked_at) return reject(res, 403, NO);
    if (new Date(row.expires_at).getTime() < Date.now()) return reject(res, 403, NO);

    // "She has collected it", not "this is spent". Written once, never read
    // back as a reason to refuse — see the note at the top — so the desk can
    // answer "did she ever get it?" without the link dying to answer it.
    if (!row.used_at) {
      await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: 'PATCH',
        body: JSON.stringify({ used_at: new Date().toISOString() }),
      }).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      // Built here so the page cannot be talked into pointing the goals at
      // somebody else's origin by a query parameter.
      link: joinLink(row.setup_code, appOrigin()),
      app: appOrigin(),
      name: row.child_label || null,
    });
  } catch (err) {
    return reject(res, 500, 'Something went wrong on my end.');
  }
};
