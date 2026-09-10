// Shared by the endpoints added for issuing links. Vercel does not route a file
// in api/ whose name starts with an underscore, so this is a module and not an
// endpoint.
//
// api/upload-url.js and api/upload-done.js deliberately do NOT import this. They
// are the path a paying family is already standing in, they work, and they are
// each readable end to end in one screen. Nothing here is worth reopening them for.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

// Same shape as the two endpoints already in production: one field for the page
// to test, one sentence a parent could read out loud.
function reject(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

// Returns a `rest` function, or null when the env vars are missing. Null means
// FAIL CLOSED — the caller answers 503 and nothing has been stored or sent.
function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return (path, init) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init && init.headers),
      },
    });
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

// The RAW bytes, before anything parses them.
//
// ★ A webhook signature covers the exact bytes Stripe sent. Re-serializing a
// parsed object gives you JSON that means the same thing and hashes differently,
// so `JSON.stringify(req.body)` verifies nothing and fails 100% of the time —
// which reads like a wrong secret and is really a wrong body.
//
// Returns null if something upstream already drained the stream, so the caller
// can fail closed and say so rather than silently comparing against empty.
async function rawBody(req) {
  if (req.readableEnded || req.readable === false) return null;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return null; }
  }
  return req.body || {};
}

// ---------------------------------------------------------------------------
// Comparing secrets
// ---------------------------------------------------------------------------

// Constant time, and safe on unequal lengths — timingSafeEqual THROWS when the
// buffers differ in size, and a throw is itself a signal about the length of the
// real key. Hash both sides first so the compared buffers are always 32 bytes.
function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

// Resend. Returns { ok, status, error }.
//
// ⛔ What is allowed through here: an email address, a first name, a link, and
// the fixed copy in the template. NEVER anything read out of an IEP or a record.
// CLAUDE.md forbids sending IEP contents to any third-party API, and an email
// provider is a third-party API.
async function sendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  // Fail closed, and say which half is missing. A link that is generated and
  // never sent is worse than one that was never generated: the row says the
  // family was served and the family is sitting there with nothing.
  if (!key) return { ok: false, status: 0, error: 'RESEND_API_KEY is not set.' };
  if (!from) return { ok: false, status: 0, error: 'MAIL_FROM is not set.' };

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(replyTo || process.env.MAIL_REPLY_TO
          ? { reply_to: replyTo || process.env.MAIL_REPLY_TO }
          : {}),
      }),
    });

    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).message || ''; } catch { /* body not json */ }
      return { ok: false, status: r.status, error: detail || `Resend answered ${r.status}.` };
    }
    return { ok: true, status: r.status };
  } catch (err) {
    return { ok: false, status: 0, error: 'Could not reach the email provider.' };
  }
}

// ---------------------------------------------------------------------------
// Where the site lives
// ---------------------------------------------------------------------------

// The link in the email has to be absolute and it has to be right. Derived from
// an env var so a preview deployment cannot email somebody a preview URL that
// dies in a week.
function siteOrigin() {
  return (process.env.PUBLIC_ORIGIN || 'https://kirtonlearning.com').replace(/\/+$/, '');
}

function uploadLink(token, kind) {
  const base = `${siteOrigin()}/upload.html?t=${encodeURIComponent(token)}`;
  return kind === 'record' ? `${base}&k=record` : base;
}

module.exports = {
  reject,
  supabase,
  rawBody,
  parseJson,
  secretEquals,
  sendEmail,
  siteOrigin,
  uploadLink,
};
