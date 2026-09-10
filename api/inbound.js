// POST /api/inbound
//
// Mail sent TO lamont@kirtonlearning.com, forwarded into his Gmail.
//
// Resend receives it, calls this, and this re-sends it on. There is no mailbox
// anywhere in that sentence — which is the point: no second inbox to remember to
// check, and the address on the printed pages finally goes somewhere.
//
// ⛔ THIS IS UNVERIFIED UNTIL A REAL MESSAGE HAS FLOWED THROUGH IT. It cannot be
// tested end to end until the domain verifies at Resend and the apex MX points
// here. Nothing below has ever seen a real inbound email. Treat every claim in
// these comments as intent, not evidence, until that test is done.
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
    const attachments = Array.isArray(mail.attachments) ? mail.attachments : [];

    // ★★★ ATTACHMENTS ARE NOT CARRIED YET, AND THAT IS SAID OUT LOUD IN THE MAIL.
    // A parent may well attach the IEP to a reply — it is the obvious thing to
    // do — and a forwarder that silently drops it would lose the one document
    // the whole business runs on while looking like it worked. Until attachment
    // relaying is built and TESTED, every dropped file is named in the body,
    // with where to go and get it.
    const dropped = attachments.length
      ? `\n\n---\n${attachments.length} attachment${attachments.length > 1 ? 's were' : ' was'} ` +
        `NOT carried through this forward:\n` +
        attachments.map((a) => `  · ${a.filename || '(unnamed)'} (${a.content_type || 'unknown type'})`).join('\n') +
        `\n\nOpen it in the Resend dashboard under Emails → Receiving, message ${emailId}.\n` +
        `If it is an IEP, ask them to send it through the private upload link instead.`
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

    return res.status(200).json({ ok: true, forwarded: emailId, attachmentsDropped: attachments.length });
  } catch (err) {
    return reject(res, 500, 'Something went wrong forwarding that message.');
  }
};

// The Svix signature covers the raw bytes, same as Stripe's.
module.exports.config = { api: { bodyParser: false } };
