// Does the Stripe webhook accept exactly the deliveries it should, and nothing else?
//
// Why this exists as a test and not a live probe: a webhook that rejects every
// genuine event looks IDENTICAL from outside to one that is simply not receiving
// any — a quiet endpoint, no errors on the site, and a parent who paid and heard
// nothing. The only way to see the difference is to sign a delivery yourself and
// watch whether it is let through.
//
// It runs the real handler in-process. Every case here stops before Supabase is
// touched: an unhandled event type returns 200 immediately after the signature
// check, so a correct signature proves itself without writing a row.
//
//   node verify/webhook-signature.mjs

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SECRET = 'whsec_test_' + crypto.randomBytes(16).toString('hex');
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
// Never dialed in any case below — but the handler fails closed on a missing
// Supabase config before it reads the body, so they have to be present.
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key';

const handler = require('../api/stripe-webhook.js');

// One of the two live Kirton payment links, so a fixture reads as OUR sale and
// reaches the checks that come after the brand gate. Kept in step with
// KIRTON_PAYMENT_LINKS in the handler.
const KIRTON_LINK = 'plink_1UCLO81pO3j9etUd9FVhdDCa'; // Kirton Learning Blueprint

// If that id ever stops being one of ours, every fixture below quietly falls
// through the brand gate and starts testing nothing — which is exactly what
// happened to the no-email case for two days.
if (!require('node:fs').readFileSync(new URL('../api/stripe-webhook.js', import.meta.url), 'utf8')
  .includes(KIRTON_LINK)) {
  console.log(`
  FAIL  the fixture's payment link is still one of ours
        ${KIRTON_LINK} is not in KIRTON_PAYMENT_LINKS
`);
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ok    ' + n); };
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

function sign(body, secret, timestamp) {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex');
  return `t=${t},v1=${mac}`;
}

// A request the handler can read exactly once, like the real thing.
function mockReq(body, signature) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.headers = signature ? { 'stripe-signature': signature } : {};
  return req;
}

function mockRes() {
  const out = { code: 0, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
  };
}

async function call(body, signature) {
  const res = mockRes();
  await handler(mockReq(body, signature), res);
  return res.out;
}

const event = (type) => JSON.stringify({
  id: 'evt_test', type,
  data: { object: { id: 'cs_test_123', payment_status: 'paid', amount_total: 34900, currency: 'usd' } },
});

console.log('\nStripe webhook — signature\n');

// ---------------------------------------------------------------------------
{
  const body = event('invoice.paid'); // handled=false, so it stops before Supabase
  const r = await call(body, sign(body, SECRET));
  r.code === 200 && r.body.ignored === 'invoice.paid'
    ? ok('a correctly signed delivery is accepted')
    : bad('a correctly signed delivery is accepted', `got ${r.code} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------------------
{
  const body = event('invoice.paid');
  const r = await call(body, sign(body, 'whsec_the_wrong_secret'));
  r.code === 400 ? ok('a delivery signed with the wrong secret is refused')
    : bad('a delivery signed with the wrong secret is refused', `got ${r.code}`);
}

// ---------------------------------------------------------------------------
// ★ The one that matters most. The signature covers the exact bytes Stripe sent.
// Re-serialized JSON means the same thing and hashes differently, so a body that
// has been parsed and stringified on the way in must NOT verify — if it did, the
// signature would be checking nothing.
{
  const body = event('invoice.paid');
  const reserialized = JSON.stringify(JSON.parse(body).data ? JSON.parse(body) : {});
  const tampered = reserialized.replace('cs_test_123', 'cs_test_456');
  const r = await call(tampered, sign(body, SECRET));
  r.code === 400 ? ok('a body altered after signing is refused')
    : bad('a body altered after signing is refused', `got ${r.code}`);
}

// ---------------------------------------------------------------------------
{
  const body = event('invoice.paid');
  const old = Math.floor(Date.now() / 1000) - 3600;
  const r = await call(body, sign(body, SECRET, old));
  r.code === 400 ? ok('a replay of an hour-old delivery is refused')
    : bad('a replay of an hour-old delivery is refused', `got ${r.code}`);
}

// ---------------------------------------------------------------------------
{
  const body = event('invoice.paid');
  const r = await call(body, null);
  r.code === 400 ? ok('a delivery with no signature header is refused')
    : bad('a delivery with no signature header is refused', `got ${r.code}`);
}

// ---------------------------------------------------------------------------
// Rotation: Stripe sends every valid v1 while two secrets are live. Checking
// only the first would break the endpoint silently in the middle of a rotation.
{
  const body = event('invoice.paid');
  const t = Math.floor(Date.now() / 1000);
  const wrong = crypto.createHmac('sha256', 'whsec_old').update(`${t}.${body}`).digest('hex');
  const right = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const r = await call(body, `t=${t},v1=${wrong},v1=${right}`);
  r.code === 200 ? ok('a second v1 is checked, not just the first (secret rotation)')
    : bad('a second v1 is checked, not just the first (secret rotation)', `got ${r.code}`);
}

// ---------------------------------------------------------------------------
// A completed-but-unpaid session must not produce a link.
{
  const body = JSON.stringify({
    id: 'evt_x', type: 'checkout.session.completed',
    data: { object: { id: 'cs_unpaid', payment_status: 'unpaid' } },
  });
  const r = await call(body, sign(body, SECRET));
  r.code === 200 && r.body.ignored === 'unpaid session'
    ? ok('a completed but unpaid session issues nothing')
    : bad('a completed but unpaid session issues nothing', `got ${r.code} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------------------
// A real payment with nowhere to send the link must be LOUD. A 200 here would
// file the problem away in silence and the family would wait forever.
//
// ⛔ This case was RED from 2026-09-16 to 2026-09-18 and the product was fine.
// The fix that day ("only issue a link for a sale that was actually ours")
// added a payment-link check AHEAD of this one, and the fixture below carried
// no payment_link — so it stopped being a Kirton sale with no email and became
// an unrecognized sale, which correctly answers 200. The assertion still read
// like it was about the email. ★★ A fixture that predates a new gate does not
// fail at the gate; it quietly starts testing a different thing.
{
  const body = JSON.stringify({
    id: 'evt_y', type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_noemail',
        payment_status: 'paid',
        payment_link: KIRTON_LINK,
        customer_details: {},
      },
    },
  });
  const r = await call(body, sign(body, SECRET));
  r.code >= 500 ? ok('a paid session with no email address fails loudly, not quietly')
    : bad('a paid session with no email address fails loudly, not quietly', `got ${r.code}`);
}

// ---------------------------------------------------------------------------
// And the gate itself, pinned, so the case above cannot silently turn back
// into this one. Seven webhooks share one Stripe account; a book sale must
// never issue somebody an IEP link.
{
  const body = JSON.stringify({
    id: 'evt_z', type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_notours',
        payment_status: 'paid',
        payment_link: 'plink_someoneElsesProduct',
        customer_details: { email: 'buyer@example.com' },
      },
    },
  });
  const r = await call(body, sign(body, SECRET));
  r.code === 200 && r.body.ignored === 'unrecognized payment link'
    ? ok('a sale that was not ours issues nothing')
    : bad('a sale that was not ours issues nothing', `got ${r.code} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------------------
{
  const res = mockRes();
  const req = Readable.from([Buffer.from('{}')]);
  req.method = 'GET';
  req.headers = {};
  await handler(req, res);
  res.out.code === 405 ? ok('GET is refused') : bad('GET is refused', `got ${res.out.code}`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
