// POST /api/upload-url
// Body: { token, filename, size, type }
// Returns a short-lived signed upload URL, or an error. Never trusts the client:
// every check here is repeated by Supabase Storage itself (bucket-level size and
// MIME limits), so a forged request cannot land a file we did not intend to accept.

const BUCKET = 'ieps';
const MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

// Same shape for every rejection, so this endpoint can't be used to probe
// which tokens exist.
function reject(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail closed. Until Lamont wires the env vars, intake is simply not open.
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return reject(res, 503, 'IEP intake is not open yet. Nothing has been sent or stored.');
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { token, filename, size, type } = body;

  // ---- validate the request shape before touching the database ----
  if (!token || !/^[0-9a-f-]{36}$/i.test(String(token))) {
    return reject(res, 400, 'That upload link is not valid.');
  }
  if (!filename || typeof filename !== 'string' || filename.length > 200) {
    return reject(res, 400, 'That file name is not something we can accept.');
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    return reject(res, 400, 'That file is larger than 25MB. Send a smaller copy or email me.');
  }
  const ext = ALLOWED[type];
  if (!ext) {
    return reject(res, 400, 'We can take a PDF, a Word document, or a photo (JPG or PNG).');
  }

  const rest = (path, init) =>
    fetch(`${SUPABASE_URL}${path}`, {
      ...init,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(init && init.headers),
      },
    });

  try {
    // ---- the token must exist, be unused, unrevoked, and unexpired ----
    //
    // `revoked_at` and `kind` arrive with supabase-setup-2.sql. Until that has
    // been run they do not exist, and PostgREST answers 400 for the whole SELECT
    // — which would take THIS endpoint down, the one path that already works, on
    // a deploy that was supposed to be additive. So: ask for them, and if the
    // schema is still the old one, fall back to the columns part 1 shipped.
    //
    // ⚠️ This fallback is a bridge, not a mode. In it there is no revoke check
    // and every token reads as an IEP. It is not silent: /api/admin answers the
    // very first list with "run supabase-setup-2.sql", so the state announces
    // itself on the page he opens to do anything at all.
    let lookup = await rest(
      `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}` +
        `&select=token,used_at,expires_at,revoked_at,kind`,
      { method: 'GET' }
    );
    if (lookup.status === 400) {
      lookup = await rest(
        `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}` +
          `&select=token,used_at,expires_at`,
        { method: 'GET' }
      );
    }
    if (!lookup.ok) return reject(res, 502, 'Something went wrong on my end. Try again shortly.');

    const rows = await lookup.json();
    const row = Array.isArray(rows) ? rows[0] : null;

    if (!row) return reject(res, 403, 'That upload link is not valid.');
    if (row.used_at) {
      return reject(res, 403, 'That link has already been used. Email me and I will send a fresh one.');
    }
    // A link Lamont killed on purpose — forwarded to the wrong person, or a lost
    // laptop. Same sentence as an expired one: a parent does not need to know
    // which, and a difference in wording here tells anyone holding the link why
    // it stopped working.
    if (row.revoked_at) {
      return reject(res, 403, 'That link has expired. Email me and I will send a fresh one.');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return reject(res, 403, 'That link has expired. Email me and I will send a fresh one.');
    }

    // ---- name the object ourselves; never reuse the client's filename ----
    // The parent's original name can carry the child's full name, so it is
    // deliberately discarded. The token already tells us whose file this is.
    //
    // The kind comes off the ROW, never off the URL. upload.html reads a `k`
    // parameter to choose its wording, and a parent who edits it should change
    // what she reads and nothing about where the file goes.
    const objectPath = `${token}/${row.kind === 'record' ? 'record' : 'iep'}.${ext}`;

    const signed = await rest(`/storage/v1/object/upload/sign/${BUCKET}/${objectPath}`, {
      method: 'POST',
      body: JSON.stringify({ expiresIn: 600 }), // 10 minutes is plenty to pick a file
    });
    if (!signed.ok) return reject(res, 502, 'Could not open a secure slot. Try again shortly.');

    const { url } = await signed.json();

    return res.status(200).json({
      ok: true,
      uploadUrl: `${SUPABASE_URL}/storage/v1${url}`,
      objectPath,
      contentType: type,
    });
  } catch (err) {
    // Never leak internals to the page.
    return reject(res, 500, 'Something went wrong on my end. Try again shortly.');
  }
};
