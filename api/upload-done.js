// POST /api/upload-done
// Body: { token, objectPath }
// Confirms the object actually landed, then burns the token so the link is dead.
// The client saying "I uploaded it" is not evidence — we check storage ourselves.

const BUCKET = 'ieps';

function reject(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return reject(res, 503, 'IEP intake is not open yet. Nothing has been sent or stored.');
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { token, objectPath } = body;

  if (!token || !/^[0-9a-f-]{36}$/i.test(String(token))) {
    return reject(res, 400, 'That upload link is not valid.');
  }
  // The path is derived from the token server-side, so it must match exactly.
  // This stops a caller from marking someone else's token as complete.
  if (!objectPath || !String(objectPath).startsWith(`${token}/`)) {
    return reject(res, 400, 'That upload could not be confirmed.');
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
    // ---- prove the file is really there before burning the token ----
    const dir = String(objectPath).split('/')[0];
    const list = await rest(`/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      body: JSON.stringify({ prefix: dir, limit: 10 }),
    });
    if (!list.ok) return reject(res, 502, 'Could not confirm the upload. Email me and I will check.');

    const objects = await list.json();
    const landed = Array.isArray(objects) && objects.some((o) => `${dir}/${o.name}` === objectPath);
    if (!landed) {
      return reject(res, 409, 'That upload did not finish. Try once more.');
    }

    // ---- burn the token: one use, then dead ----
    const burn = await rest(
      `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}&used_at=is.null`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ used_at: new Date().toISOString(), object_path: objectPath }),
      }
    );
    if (!burn.ok) return reject(res, 502, 'Could not confirm the upload. Email me and I will check.');

    return res.status(200).json({ ok: true });
  } catch (err) {
    return reject(res, 500, 'Something went wrong on my end. Try again shortly.');
  }
};
