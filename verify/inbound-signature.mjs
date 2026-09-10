// Does the inbound forwarder accept exactly the deliveries Resend signs, and
// nothing else?
//
// This endpoint stands in front of a parent's reply. If it rejects genuine
// deliveries, mail to lamont@kirtonlearning.com silently stops arriving and
// looks exactly like nobody wrote — the same shape of failure as the Stripe
// webhook, on the other side of the conversation.
//
//   node verify/inbound-signature.mjs

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ok    ' + n); };
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

console.log('\nInbound forwarder — Svix signatures\n');

// ---------------------------------------------------------------------------
// 1. The algorithm itself, against Svix's own published worked example.
//
// ★★ This vector is SOURCED (docs.svix.com/receiving/verifying-payloads/how-manual),
// not remembered. An earlier version of this check used a vector recalled from
// memory, it did not match, and the mismatch said nothing about the code — a
// test whose expected value is a guess cannot fail usefully or pass honestly.
// ---------------------------------------------------------------------------
{
  const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
  const payload = '{"event_type":"ping","data":{"success":true}}';
  const id = 'msg_loFOjxBNrRLzqYUf';
  const ts = '1731705121';
  const expected = 'rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=';

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), Buffer.from(payload, 'utf8')]))
    .digest('base64');

  sig === expected
    ? ok('the signing scheme matches Svix\'s published worked example')
    : bad('the signing scheme matches Svix\'s published worked example', `got ${sig}`);

  // ⛔ The specific way to get this wrong: HMAC the ASCII of the secret rather
  // than its base64-decoded bytes. It produces a stable, plausible signature
  // that never matches anything, which reads as "Resend is misconfigured".
  const wrong = crypto.createHmac('sha256', secret.replace(/^whsec_/, ''))
    .update(`${id}.${ts}.${payload}`).digest('base64');
  wrong !== expected
    ? ok('HMAC-ing the undecoded secret does NOT match (the classic mistake stays caught)')
    : bad('HMAC-ing the undecoded secret does NOT match');
}

// ---------------------------------------------------------------------------
// 2. The handler, driven the way Resend will drive it.
// ---------------------------------------------------------------------------
const SECRET = 'whsec_' + crypto.randomBytes(24).toString('base64');
process.env.RESEND_INBOUND_SECRET = SECRET;
process.env.RESEND_API_KEY = 'not-a-real-key';
process.env.MAIL_FROM = 'Lamont Kirton <lamont@kirtonlearning.com>';
process.env.FORWARD_TO = 'somebody@example.com';

const handler = require('../api/inbound.js');

function sign(body, secret, id = 'msg_test', timestamp = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const mac = crypto.createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${mac}` };
}

function mockRes() {
  const out = { code: 0, body: null };
  return { out, setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
}

async function call(body, headers) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.headers = headers || {};
  const res = mockRes();
  await handler(req, res);
  return res.out;
}

// An event type we do not handle returns before any network call, so a correct
// signature proves itself without needing Resend to exist.
const ping = JSON.stringify({ type: 'email.delivered', data: {} });

{
  const r = await call(ping, sign(ping, SECRET));
  r.code === 200 && r.body.ignored === 'email.delivered'
    ? ok('a correctly signed delivery is accepted')
    : bad('a correctly signed delivery is accepted', `got ${r.code} ${JSON.stringify(r.body)}`);
}
{
  const r = await call(ping, sign(ping, 'whsec_' + Buffer.from('wrong-key-entirely').toString('base64')));
  r.code === 400 ? ok('a delivery signed with the wrong secret is refused')
    : bad('a delivery signed with the wrong secret is refused', `got ${r.code}`);
}
{
  const h = sign(ping, SECRET);
  const r = await call(ping.replace('delivered', 'received'), h);
  r.code === 400 ? ok('a body altered after signing is refused')
    : bad('a body altered after signing is refused', `got ${r.code}`);
}
{
  const r = await call(ping, sign(ping, SECRET, 'msg_test', Math.floor(Date.now() / 1000) - 3600));
  r.code === 400 ? ok('an hour-old replay is refused')
    : bad('an hour-old replay is refused', `got ${r.code}`);
}
{
  const r = await call(ping, {});
  r.code === 400 ? ok('a delivery with no signature headers is refused')
    : bad('a delivery with no signature headers is refused', `got ${r.code}`);
}
{
  // Rotation: Svix sends every valid signature while two secrets are live.
  const h = sign(ping, SECRET);
  h['svix-signature'] = 'v1,AAAAdefinitelynotvalidAAAAAAAAAAAAAAAAAAAAA= ' + h['svix-signature'];
  const r = await call(ping, h);
  r.code === 200 ? ok('a second signature is checked, not just the first (rotation)')
    : bad('a second signature is checked, not just the first (rotation)', `got ${r.code}`);
}
{
  const req = Readable.from([Buffer.from('{}')]);
  req.method = 'GET'; req.headers = {};
  const res = mockRes();
  await handler(req, res);
  res.out.code === 405 ? ok('GET is refused') : bad('GET is refused', `got ${res.out.code}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('
  This file covers the SIGNATURE only. The rest of the path was proven on');
console.log('  2026-09-10 with real messages — plain, and with a 40KB PDF attachment — sent');
console.log('  to lamont@kirtonlearning.com and confirmed delivered onward to Gmail.
');
process.exitCode = fail ? 1 : 0;
