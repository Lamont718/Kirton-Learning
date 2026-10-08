// POST /api/share   Body: { key, record } | { key, stop: true }
//
// ★★★ THE ONE ROUTE BY WHICH A CHILD'S WORK COMES BACK, AND ONLY IF SHE ASKED.
//
// The work app (kirton-learn) keeps everything on the family's device. That was
// the promise, and it had a cost Lamont named on 2026-10-08: he could not see a
// child's progress, so he could not correct a setup that was going wrong. He
// asked for an opt-in. This is the receiving end of it.
//
// What makes it opt-in is on the other side and is asserted there: the app
// sends nothing until a parent switches "Share this child's work with Kirton
// Learning" on, the switch starts OFF, and switching it off sends `stop`, which
// deletes what we hold. This file's job is to accept only what that switch
// can send, from only the family it belongs to.
//
// ★★ THE KEY IS DERIVED FROM THE FAMILY'S SETUP TOKEN (shareKeyFor in
// _common.js), never the token itself — the token is in an email, and a key that
// was an email away from anybody would let them overwrite or delete a family's
// record. The row is the one Lamont made when he sent their setup, so the desk
// knows the parent and the child label without the app ever sending the
// child's name. The key arrives in the setup link's fragment and nowhere else.
//
// ⚠️ IT IGNORES THE 7-DAY EXPIRY, ON PURPOSE. The expiry is on COLLECTING the
// goals, which is a link sitting in an inbox. Sharing is a year of work from a
// device that already has them. Revoke still ends it: a revoked row is refused,
// which is how Lamont stops a family's sharing from his side.
//
// ★ STORED IN ITS OWN PRIVATE BUCKET, `shared`, one file per family, replaced
// on every send. Not the `ieps` bucket, which only accepts documents, and not a
// table, so this needs no SQL migration to run. The bucket is created on first
// use, private, JSON only, 1 MB a file.

const { reject, supabase, parseJson, appOrigin, shareKeyFor, secretEquals } = require('./_common');

const KEY_RE = /^[0-9a-f]{40}$/;
const BUCKET = 'shared';
const KIND = 'kirton-learn-share';
// A year of checks on a whole IEP is tens of kilobytes. A megabyte is not a record.
const MAX_BYTES = 1024 * 1024;

// ⛔ One answer for every reason a key does not work, like api/setup.js — a
// different message per case would make this a way to find out which exist.
const NO = 'This device is not set up to share. Ask for a fresh setup link.';

// ★ The work app moved to learn.kirtonlearning.com on 2026-10-08. A device that
// opened it at the old vercel.app address keeps its record THERE (storage is per
// address), so that origin is still allowed to share, and nothing else is.
const LEGACY_APP_ORIGIN = 'https://kirton-learn.vercel.app';

function cors(req, res) {
  // Only the work app. A page anywhere else cannot post a child's record here
  // from a parent's browser, even if it somehow had her key.
  const origin = String(req.headers?.origin || '');
  res.setHeader('Access-Control-Allow-Origin', origin === LEGACY_APP_ORIGIN ? LEGACY_APP_ORIGIN : appOrigin());
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// What a record has to look like before it is kept. Shape only — the words in
// it are the family's and are not read here.
function checkRecord(r) {
  if (!r || typeof r !== 'object') return 'There is nothing to keep.';
  if (r.kind !== KIND) return 'That is not a record from the work app.';
  if (!Array.isArray(r.goals) || !Array.isArray(r.attempts)) return 'That record is incomplete.';
  if (r.goals.length > 60 || r.attempts.length > 10000) return 'That record is too large.';
  // ⛔ The app never sends the child's name. If one turns up, something upstream
  // changed, and refusing is how that gets noticed rather than stored.
  if ('name' in r || 'learners' in r) return 'That record carries more than it should.';
  return null;
}

async function ensureBucket(rest) {
  const r = await rest('/storage/v1/bucket', {
    method: 'POST',
    body: JSON.stringify({
      id: BUCKET, name: BUCKET, public: false,
      allowed_mime_types: ['application/json'], file_size_limit: MAX_BYTES,
    }),
  });
  // 200 made it; 400/409 "already exists" is the normal case after the first time.
  return r.ok || r.status === 400 || r.status === 409;
}

module.exports = async (req, res) => {
  cors(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const rest = supabase();
  if (!rest) return reject(res, 503, 'Sharing is not open yet. Nothing was sent or stored.');

  const body = parseJson(req);
  const key = String((body && body.key) || '').toLowerCase();
  if (!KEY_RE.test(key)) return reject(res, 400, NO);

  try {
    // The key is one-way, so the family is found by deriving every live setup
    // row's key and comparing. That is a short list (one row per family sent a
    // setup), and the compare is constant-time.
    const r = await rest(
      '/rest/v1/upload_tokens?kind=eq.setup&revoked_at=is.null&select=token&limit=5000',
      { method: 'GET' }
    );
    if (!r.ok) return reject(res, 502, 'Something went wrong on my end. It will try again.');
    const rows = await r.json();
    const row = (Array.isArray(rows) ? rows : []).find((x) => secretEquals(shareKeyFor(x.token) || '', key));
    if (!row) return reject(res, 403, NO);

    // Stored under the TOKEN, which only the server and the desk know.
    const object = `/storage/v1/object/${BUCKET}/${encodeURIComponent(row.token)}.json`;

    // Switching sharing off deletes what we hold. Answered ok when there was
    // nothing to delete: the family's request was "hold nothing", and nothing is held.
    if (body.stop === true) {
      await rest(object, { method: 'DELETE' }).catch(() => {});
      return res.status(200).json({ ok: true, stopped: true });
    }

    const why = checkRecord(body.record);
    if (why) return reject(res, 400, why);
    const text = JSON.stringify({ ...body.record, receivedAt: new Date().toISOString() });
    if (Buffer.byteLength(text) > MAX_BYTES) return reject(res, 413, 'That record is too large.');

    const put = () => rest(object, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: text,
    });
    let s = await put();
    // First share ever: the bucket does not exist yet. Make it and try once more.
    if (!s.ok && (s.status === 404 || s.status === 400)) {
      if (await ensureBucket(rest)) s = await put();
    }
    if (!s.ok) return reject(res, 502, `It was not kept (${s.status}). It will try again.`);
    return res.status(200).json({ ok: true, at: new Date().toISOString() });
  } catch (err) {
    return reject(res, 500, 'Something went wrong on my end. It will try again.');
  }
};

module.exports.checkRecord = checkRecord;
module.exports.KIND = KIND;
