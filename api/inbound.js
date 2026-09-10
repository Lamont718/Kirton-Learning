// POST /api/inbound
//
// Mail sent TO lamont@kirtonlearning.com, forwarded into his Gmail.
//
// Resend receives it, calls this, and this re-sends it on. There is no mailbox
// anywhere in that sentence — which is the point: no second inbox to remember to
// check, and the address on the printed pages finally goes somewhere.
//
// ✅ Proven on 2026-09-10 with real messages, both with and without an attachment:
// mail reached the address, Resend called this, and it arrived in his Gmail.
//
// ⛔ Attachments are either CARRIED or NAMED — never silently dropped. A parent
// replying with the IEP attached is the obvious thing for her to do, and losing
// it while the forward looks fine is worse than not forwarding at all.
//
// Env: RESEND_INBOUND_SECRET (the webhook's signing secret, whsec_…)
//      RESEND_API_KEY · MAIL_FROM · FORWARD_TO (his Gmail)

const crypto = require('crypto');
const { reject, rawBody } = require('./_common');

const TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Svix signatures — what Resend signs its webhooks with
// ---------------------------------------------------------------------------
//
// Signed content: `${svix-id}.${svix-timestamp}.${raw body}`
// Secret: `whsec_<base64>` — the base64 half decodes to the RAW KEY BYTES.
//   ⛔ HMAC-ing the ASCII of the secret instead of its decoded bytes is the
//   classic way to get this wrong: it produces a stable, plausible-looking
//   signature that never matches, which reads as "Resend is misconfigured".
// Header: space-separated `v1,<base64sig>` — more than one during rotation.
function verifySvix(raw, headers, secret) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!raw || !id || !ts || !sigHeader || !secret) return false;

  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (!Number.isFinite(age) || Math.abs(age) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw]))
    .digest();

  for (const part of String(sigHeader).split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    let given;
    try { given = Buffer.from(value, 'base64'); } catch { continue; }
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
  }
  return false;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const SECRET = process.env.RESEND_INBOUND_SECRET;
  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.MAIL_FROM;
  const TO = process.env.FORWARD_TO;

  // Fail closed and name the missing piece. A forwarder that quietly drops mail
  // is worse than an address that bounces: a bounce tells the sender, and this
  // would tell nobody at all.
  if (!SECRET) return reject(res, 503, 'RESEND_INBOUND_SECRET is not set.');
  if (!KEY || !FROM || !TO) return reject(res, 503, 'RESEND_API_KEY / MAIL_FROM / FORWARD_TO are not all set.');

  const raw = await rawBody(req);
  if (!raw) return reject(res, 500, 'Could not read the raw request body.');
  if (!verifySvix(raw, req.headers, SECRET)) return reject(res, 400, 'Signature verification failed.');

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return reject(res, 400, 'Body is not JSON.'); }
  if (event.type !== 'email.received') {
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  const d = event.data || {};
  const emailId = d.email_id;
  if (!emailId) return reject(res, 400, 'No email_id on the event.');

  try {
    // The webhook carries metadata only — no body, no headers, no attachments.
    // The content has to be fetched.
    const got = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!got.ok) return reject(res, 502, `Could not fetch the received email (${got.status}).`);
    const mail = await got.json();

    const sender = (Array.isArray(mail.from) ? mail.from[0] : mail.from) || 'unknown sender';
    const subject = mail.subject || '(no subject)';

    // ---- carry the attachments ----
    //
    // A parent replying with the IEP attached is the obvious thing for her to
    // do, so this has to work. But it must never fail SILENTLY: losing the one
    // document the business runs on, while the forward looks fine, is worse than
    // not forwarding at all.
    //
    // ⛔ Every file is either carried or NAMED. There is no third outcome.
    const MAX_TOTAL = 20 * 1024 * 1024; // base64 inflates ~33%; keep well under Resend's cap
    const carried = [];
    const skipped = [];
    let budget = MAX_TOTAL;

    let list = [];
    try {
      const r = await fetch(
        `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
        { headers: { Authorization: `Bearer ${KEY}` } }
      );
      if (r.ok) list = (await r.json()).data || [];
      else if (Array.isArray(mail.attachments)) {
        // Could not enumerate them — fall back to the metadata on the message so
        // the names still reach him. Better a list of what he is missing than
        // silence about it.
        list = mail.attachments;
      }
    } catch {
      list = Array.isArray(mail.attachments) ? mail.attachments : [];
    }

    for (const a of list) {
      const name = a.filename || '(unnamed)';
      const size = Number(a.size) || 0;
      if (!a.download_url) { skipped.push(`${name} — no download link from Resend`); continue; }
      if (size > budget) { skipped.push(`${name} — ${(size / 1048576).toFixed(1)}MB, over what one email can carry`); continue; }
      try {
        const bin = await fetch(a.download_url);
        if (!bin.ok) { skipped.push(`${name} — download failed (${bin.status})`); continue; }
        const buf = Buffer.from(await bin.arrayBuffer());
        budget -= buf.length;
        carried.push({ filename: name, content: buf.toString('base64') });
      } catch {
        skipped.push(`${name} — could not be fetched`);
      }
    }

    // ⛔⛔ THE THIRD OUTCOME I SAID DID NOT EXIST.
    // "carried or named" holds only while the ENUMERATION is right. If
    // /attachments comes back empty for a message that has them, the loop above
    // has nothing to carry AND nothing to skip — so the forward arrives looking
    // perfect with the file gone and no notice on it. Silent, and exactly the
    // failure this whole section exists to prevent.
    // The message's own metadata is a second, independent count. If the two
    // disagree, the difference is announced.
    const declared = Array.isArray(mail.attachments) ? mail.attachments.length : 0;
    const accountedFor = carried.length + skipped.length;
    if (declared > accountedFor) {
      skipped.push(
        `${declared - accountedFor} more file(s) are on the original message but could not be ` +
        `listed — open the message in Resend to get them`
      );
    }

    const dropped = skipped.length
      ? `\n\n---\n${skipped.length} attachment${skipped.length > 1 ? 's' : ''} did NOT come through:\n` +
        skipped.map((s) => `  · ${s}`).join('\n') +
        `\n\nIt is still in Resend under Emails → Receiving, message ${emailId}.\n` +
        `If it is an IEP, the private upload link is the right way to receive it anyway.`
      : '';

    const header =
      `Forwarded from ${sender}\n` +
      `To: ${(Array.isArray(mail.to) ? mail.to.join(', ') : mail.to) || ''}\n` +
      `---\n\n`;

    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject,
        // ★ reply_to is the original sender, so hitting Reply in Gmail answers
        // the parent and not himself.
        reply_to: sender,
        ...(carried.length ? { attachments: carried } : {}),
        text: header + (mail.text || '(no plain-text body)') + dropped,
        ...(mail.html
          ? { html: `<p style="color:#5A6273;font-size:13px">Forwarded from ${esc(sender)}</p><hr>` +
                    mail.html +
                    (dropped ? `<hr><pre style="white-space:pre-wrap;font-size:13px">${esc(dropped)}</pre>` : '') }
          : {}),
      }),
    });

    if (!sent.ok) {
      let detail = '';
      try { detail = (await sent.json()).message || ''; } catch { /* not json */ }
      // 5xx so Resend retries, and so the failure is visible rather than a
      // message that simply never arrived.
      return reject(res, 502, `Could not forward: ${detail || sent.status}`);
    }

    return res.status(200).json({
      ok: true, forwarded: emailId, attachmentsCarried: carried.length, attachmentsSkipped: skipped.length,
    });
  } catch (err) {
    return reject(res, 500, 'Something went wrong forwarding that message.');
  }
};

// The Svix signature covers the raw bytes, same as Stripe's.
module.exports.config = { api: { bodyParser: false } };
