// Checks the parts of the money path that do NOT live in this repo.
//
//     STRIPE_SECRET_KEY=sk_live_… node verify/stripe-config.mjs
//
// Why this file exists. On 2026-09-11 both Payment Links were still redirecting a
// paying parent to `https://kirtonlearning.com/start.html`, which with cleanUrls on
// 308s to `/start` — the FREE HANDBOOK INDEX. `verify/publish-gate.mjs` asserts in so
// many words that "the post-payment page is /welcome", and it passed every single run,
// because the wrong URL was never in a file. It was on Stripe's dashboard.
//
// ★ A green local suite says nothing about a value stored on someone else's server.
//   Read it back from their API.
//
// This never prints the key and never writes anything. Read-only.

const KEY = process.env.STRIPE_SECRET_KEY;
const ORIGIN = 'https://kirtonlearning.com';
const WEBHOOK = `${ORIGIN}/api/stripe-webhook`;
const AFTER_PAYMENT = `${ORIGIN}/welcome`;

// The code in api/stripe-webhook.js handles both of these. The second one is a bank
// transfer that completes the session before the money lands; without it enabled,
// that payment issues nothing and nobody is told.
const WANTED_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

let failures = 0, checks = 0;
const fail = (what, detail) => { failures++; console.log(`  FAIL  ${what}\n        ${detail}`); };
const pass = (what, detail) => { checks++; console.log(`  ok    ${what}${detail ? `\n        ${detail}` : ''}`); };

if (!KEY) {
  console.log('\n  STRIPE_SECRET_KEY is not set — nothing was checked.\n');
  console.log('  This is the one suite that cannot run offline, and skipping it quietly is');
  console.log('  exactly how the /start.html redirect survived. Set the key and run it.\n');
  process.exit(2);
}

const get = async (path) => {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${body.error?.message || ''}`);
  return body;
};

console.log('\nstripe — the config that is not in this repo\n');

// ---------------------------------------------------------------- the account
const account = await get('account');
pass('the key reaches an account', `${account.id} — ${account.settings?.dashboard?.display_name || 'no display name'}`);

// --------------------------------------------------------- the webhook endpoint
console.log('\nwebhook endpoint');
const endpoints = await get('webhook_endpoints?limit=100');
const ours = (endpoints.data || []).filter((e) => e.url === WEBHOOK);

if (!ours.length) {
  fail('no endpoint points at this site', `nothing on the account posts to ${WEBHOOK} — a payment issues NOTHING`);
} else if (ours.length > 1) {
  // Two endpoints means two deliveries of the same event. The UNIQUE index on
  // stripe_session_id absorbs it, but nobody should be relying on that quietly.
  fail(`${ours.length} endpoints point at the same URL`, 'every event is delivered more than once — delete the spares');
} else {
  const ep = ours[0];
  ep.status === 'enabled'
    ? pass('the endpoint is enabled', ep.id)
    : fail('the endpoint is disabled', `${ep.id} is "${ep.status}" — Stripe disables an endpoint that keeps failing`);

  const missing = WANTED_EVENTS.filter((e) => !(ep.enabled_events || []).includes(e) && !(ep.enabled_events || []).includes('*'));
  missing.length
    ? fail('events the handler expects are not enabled', missing.join(', '))
    : pass('both events the handler expects are enabled', WANTED_EVENTS.join(' + '));
}

// ------------------------------------------------------------- payment links
console.log('\npayment links');
const links = (await get('payment_links?limit=100')).data || [];
const live = links.filter((l) => l.active && /kirtonlearning\.com/.test(JSON.stringify(l.after_completion || {})));

if (!live.length) {
  fail('no active payment link sends anyone to this site', 'checked after_completion on every active link');
} else {
  for (const l of live) {
    const to = l.after_completion?.redirect?.url;
    to === AFTER_PAYMENT
      ? pass(`${l.id} lands a paying parent on ${AFTER_PAYMENT}`)
      : fail(`${l.id} sends a paying parent to the wrong page`, `after_completion is ${to} — it must be ${AFTER_PAYMENT}`);
  }
}

// -------------------------------------------------------------------- verdict
console.log(`\n${checks} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
