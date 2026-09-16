// POST /api/stripe-webhook
//
// THE MISSING STEP. api/upload-url.js and api/upload-done.js could read a token
// and burn a token since August. Nothing in the codebase ever WROTE one — so a
// parent paid, and then nothing happened, and she sat there holding an IEP with
// nowhere to send it. This is the piece that turns a payment into a link.
//
// Stripe payment succeeds
//   -> verify the signature over the RAW bytes
//   -> insert one row in upload_tokens (unique on the Stripe session id)
//   -> email the parent the one-time link
//
// No Stripe SDK. There is no package.json in this repo and adding one to hash a
// string would be the whole dependency tree for twenty lines of crypto.

const crypto = require('crypto');
const { reject, supabase, rawBody, sendEmail, uploadLink } = require('./_common');
const { iepLinkEmail } = require('./_email');

// Stripe's own tolerance. Older than this and it is a replay, not a delivery.
const TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------
//
// Header shape: `t=1699999999,v1=abc…,v1=def…`
// Signed payload: `${t}.${raw bytes}` — HMAC-SHA256, hex, keyed by the endpoint
// secret. More than one v1 appears while a secret is being rotated, so ALL of
// them are checked, not just the first.
function verifyStripeSignature(raw, header, secret) {
  if (!raw || !header || !secret) return { ok: false, why: 'missing' };

  let timestamp = null;
  const candidates = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') candidates.push(v);
  }
  if (!timestamp || !candidates.length) return { ok: false, why: 'malformed' };

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > TOLERANCE_SECONDS) {
    return { ok: false, why: 'stale' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), raw]))
    .digest();

  for (const candidate of candidates) {
    let given;
    try { given = Buffer.from(candidate, 'hex'); } catch { continue; }
    // Unequal lengths make timingSafeEqual throw, so check the length first —
    // and the length of a SHA-256 digest is not a secret.
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, why: 'mismatch' };
}

// ---------------------------------------------------------------------------
// Whose sale is this?
// ---------------------------------------------------------------------------
//
// ⛔ THE BUG THIS EXISTS TO STOP. Every Our Rose brand bills through ONE Stripe
// account, and seven webhook endpoints are subscribed to
// `checkout.session.completed` on it. Stripe fans every sale out to all seven,
// each signed with that endpoint's own secret — so the signature check passes on
// somebody else's sale. It proves Stripe sent the event. It never proves the
// sale was ours.
//
// On 2026-09-16 the first order the account ever took was a $40 picture book,
// and this file issued that buyer a live IEP upload link and emailed it to her.
// ★ ON A SHARED ACCOUNT, `checkout.session.completed` IS NOT YOUR EVENT — IT IS
// EVERYONE'S. Checking the event TYPE is not checking that the sale is yours.
//
// The event payload carries no line items, and this deployment has no
// STRIPE_SECRET_KEY to go and fetch them, so identity has to come from what is
// already on the session: the payment link it came through, or metadata set by
// a checkout we created ourselves.
const KIRTON_PAYMENT_LINKS = [
  'plink_1UCLO91pO3j9etUdYeeIyKYr', // Kirton Learning Family
  'plink_1UCLO81pO3j9etUd9FVhdDCa', // Kirton Learning Blueprint
];

// Other brands on the same account. Known and expected, so they are ignored in
// silence — without this list every book sale would page him.
const OTHER_BRAND_PAYMENT_LINKS = [
  'plink_1U4TQS1pO3j9etUdeLT70hgT', // Emeka Books — My Crown
  'plink_1U9vVO1pO3j9etUdqnA3RSeV', // Emeka Books — The House That Smiled
];

// 'ours' | 'theirs' | 'unknown'
//
// ★ Unknown is deliberately NOT treated as ours. Guessing in that direction is
// exactly what mailed a stranger a private link. It is not treated as a silent
// no either — see the handler.
function whoseSale(session) {
  const raw = session.payment_link;
  const link = typeof raw === 'string' ? raw : (raw && raw.id) || null;

  if (link && KIRTON_PAYMENT_LINKS.includes(link)) return 'ours';
  if (link && OTHER_BRAND_PAYMENT_LINKS.includes(link)) return 'theirs';

  // A checkout this site builds itself can just say so. Nothing does yet; this
  // is here so that adding one later is not another edit to a list of ids.
  const brand = session.metadata && session.metadata.brand;
  if (brand) return brand === 'kirton' ? 'ours' : 'theirs';

  return 'unknown';
}

// Tell Lamont about a paid session this file could not place.
//
// Never throws. The alert failing must not become a Stripe retry loop over a
// sale that was not ours in the first place.
async function alertUnplaceableSale(session) {
  const to = process.env.ALERT_TO || process.env.FORWARD_TO;
  if (!to) return;

  const amount = Number.isFinite(session.amount_total)
    ? `$${(session.amount_total / 100).toFixed(2)}`
    : 'an unknown amount';
  const buyer =
    (session.customer_details && session.customer_details.email) || 'no email on the session';
  const raw = session.payment_link;
  const link = (typeof raw === 'string' ? raw : (raw && raw.id)) || '(no payment link)';

  try {
    await sendEmail({
      to,
      subject: `Payment this site could not place — ${amount}`,
      text: [
        'A paid Stripe session arrived that kirtonlearning.com does not recognise,',
        'so NO IEP link was issued and nobody was emailed.',
        '',
        `Amount:       ${amount}`,
        `Buyer:        ${buyer}`,
        `Session:      ${session.id}`,
        `Payment link: ${link}`,
        '',
        'If this WAS a Kirton purchase: add that payment link id to',
        'KIRTON_PAYMENT_LINKS in api/stripe-webhook.js, and issue this family',
        'their link by hand from /admin.html in the meantime.',
        '',
        'If it was another brand on the shared Stripe account, nothing is wrong.',
        'Add it to OTHER_BRAND_PAYMENT_LINKS and these emails stop.',
      ].join('\n'),
    });
  } catch {
    // Swallowed on purpose. See above.
  }
}

// ---------------------------------------------------------------------------
// Reading the session
// ---------------------------------------------------------------------------

// Stripe collects a full name; the rest of the system only ever uses a first
// name, and it is going into the greeting of an email. Take the first word.
function firstName(full) {
  if (!full || typeof full !== 'string') return null;
  const word = full.trim().split(/\s+/)[0];
  if (!word || word.length > 40) return null;
  return word;
}

// A short human label for the admin list, so a Blueprint can be told from a
// Family plan without opening Stripe. Amounts only — never a card number.
function planLabel(session) {
  const mode = session.mode === 'subscription' ? 'subscription' : 'one-time';
  const amount = session.amount_total;
  const currency = (session.currency || 'usd').toUpperCase();
  if (!Number.isFinite(amount)) return mode;
  return `${mode} ${(amount / 100).toFixed(2)} ${currency}`;
}

// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const rest = supabase();

  // Fail closed, loudly. A 503 here shows up in Stripe's dashboard as a failed
  // delivery, which is the only place anybody would ever look.
  if (!SECRET) return reject(res, 503, 'STRIPE_WEBHOOK_SECRET is not set.');
  if (!rest) return reject(res, 503, 'Supabase is not configured.');

  const raw = await rawBody(req);
  if (!raw) {
    // Something upstream parsed the body first, so the bytes Stripe signed are
    // gone. Never fall back to re-serializing req.body: that would compare a
    // hash of different bytes and reject every real event as a forgery.
    return reject(res, 500, 'Could not read the raw request body.');
  }

  const sig = verifyStripeSignature(raw, req.headers['stripe-signature'], SECRET);
  if (!sig.ok) return reject(res, 400, 'Signature verification failed.');

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return reject(res, 400, 'Body is not JSON.'); }

  // Everything else Stripe sends here is fine and is not ours. 200 so it does
  // not sit in the dashboard looking like a fault.
  const handled = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!handled.includes(event.type)) {
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  const session = (event.data && event.data.object) || {};
  const sessionId = session.id;
  if (!sessionId) return reject(res, 400, 'No session id on the event.');

  // A bank transfer can complete the session before the money lands. Only a paid
  // session gets a link.
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid) return res.status(200).json({ ok: true, ignored: 'unpaid session' });

  // ---- and is it even ours? ----
  const whose = whoseSale(session);

  if (whose === 'theirs') {
    return res.status(200).json({ ok: true, ignored: 'another brand on this Stripe account' });
  }

  if (whose === 'unknown') {
    // Nothing is issued — a link is not worth guessing about. But a paid session
    // this file cannot place is also exactly what a NEW Kirton payment link would
    // look like on its first sale, and staying quiet then would strand a family
    // who paid. So: issue nothing, and tell him.
    await alertUnplaceableSale(session);
    return res.status(200).json({ ok: true, ignored: 'unrecognised payment link' });
  }

  const email =
    (session.customer_details && session.customer_details.email) || session.customer_email || null;

  if (!email) {
    // ★ Deliberately a 5xx and not a quiet 200. There is a real payment here and
    // no address to send the link to, so Lamont has to issue it by hand from
    // /admin.html. A 200 would file that away silently; a failed delivery is
    // visible on Stripe's dashboard and Stripe emails him about it. A soft fail
    // nobody is told about is how a paying family ends up waiting forever.
    return reject(res, 500, `Paid session ${sessionId} carried no email address. Issue the link by hand.`);
  }

  const name = firstName(session.customer_details && session.customer_details.name);

  try {
    // ---- one row per Stripe session ----
    // Stripe retries anything it did not get a 2xx for, and it is right to. The
    // UNIQUE index on stripe_session_id is what stops a slow first answer from
    // becoming two live links in two emails. The code does not get a vote.
    let row = null;

    const insert = await rest('/rest/v1/upload_tokens', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        parent_email: email,
        kind: 'iep',
        issued_by: 'stripe',
        stripe_session_id: sessionId,
        plan: planLabel(session),
      }),
    });

    if (insert.ok) {
      const rows = await insert.json();
      row = Array.isArray(rows) ? rows[0] : rows;
    } else if (insert.status === 409) {
      // Already issued on an earlier delivery of this same event.
      const found = await rest(
        `/rest/v1/upload_tokens?stripe_session_id=eq.${encodeURIComponent(sessionId)}` +
          `&select=token,used_at,sent_at,revoked_at,kind`,
        { method: 'GET' }
      );
      if (!found.ok) return reject(res, 502, 'Could not read back the existing token.');
      const rows = await found.json();
      row = Array.isArray(rows) ? rows[0] : null;
    } else {
      return reject(res, 502, `Could not create the token (${insert.status}).`);
    }

    if (!row || !row.token) return reject(res, 502, 'Token row came back empty.');

    // Already dealt with. Do not email a second link for a document that is in,
    // and do not resend one that has already gone out — a parent holding two
    // links has to guess which one is real.
    if (row.used_at) return res.status(200).json({ ok: true, note: 'already used' });
    if (row.sent_at) return res.status(200).json({ ok: true, note: 'already sent' });
    if (row.revoked_at) return res.status(200).json({ ok: true, note: 'revoked' });

    // ---- send it ----
    const link = uploadLink(row.token, 'iep');
    const mail = iepLinkEmail({ link, name });
    const sent = await sendEmail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });

    if (!sent.ok) {
      // The row survives, so the retry finds it instead of making a second one.
      // 5xx so Stripe tries again, and so the failure is visible where he looks.
      return reject(res, 502, `Token created but the email did not send: ${sent.error}`);
    }

    await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(row.token)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sent_at: new Date().toISOString(), send_count: 1 }),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return reject(res, 500, 'Something went wrong handling the event.');
  }
};

// Vercel's Node runtime parses a JSON body before the handler runs unless it is
// told not to. The signature covers the raw bytes, so this is not a preference.
// rawBody() also fails closed if the stream is drained anyway — two guards,
// because getting this wrong rejects every genuine event as a forgery.
module.exports.config = { api: { bodyParser: false } };
