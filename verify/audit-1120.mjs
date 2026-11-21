// The fixes from the 2026-11-20 audit, each pinned so it cannot quietly come back.
//
//     node verify/audit-1120.mjs
//
// Offline. Supabase, Storage, Stripe and Resend are all a recording fetch.
//
//   1. the desk's Delete removes EVERY file under the token, not just object_path
//   2. revoke / reissue of a setup removes what the family shared (their key is dead)
//   3. sharing is refused after the plan year, only when the retention run would delete it
//   4. /ask questions are deleted 24 months after the last contact (privacy.html)
//   5. the desk's Delete no longer waves a real 400 on the shared bucket through
//   6. inbound mail is forwarded as text only
//   7. upload-url: own-key allowlist, a bad body is a 400, an earlier try is cleared
//   8. upload-done: a burn that matched nothing is not an upload
//   9. a paid Kirton sale that cannot be saved emails Lamont

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import crypto from 'node:crypto'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log('  ok    ' + n) }
  else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')) }
}

const T = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const SB = 'https://x.supabase.co'
Object.assign(process.env, {
  SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'svc', ADMIN_KEY: 'k',
  RESEND_API_KEY: 're', MAIL_FROM: 'Test <t@example.com>', ALERT_TO: 'alert@example.com',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
})
delete process.env.STRIPE_READ_KEY
delete process.env.APP_ORIGIN

let calls = []
let route = () => ({ status: 404, body: {} })
globalThis.fetch = async (url, init = {}) => {
  let body = null
  try { body = init.body ? JSON.parse(init.body) : null } catch { body = init.body }
  const c = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body }
  calls.push(c)
  const r = route(c)
  if (r === 'throw') throw new TypeError('fetch failed')
  return { ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) }
}

function call (handler, body, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      code: 200, headers: {},
      setHeader (k, v) { this.headers[k] = v },
      status (c) { this.code = c; return this },
      json (b) { resolve({ code: this.code, body: b }) },
      end () { resolve({ code: this.code, body: null }) },
    }
    handler({ method, headers, body }, res)
  })
}
const desk = (body) => call(admin, body, { headers: { 'x-admin-key': 'k' } })
const resend = () => calls.filter((c) => c.url === 'https://api.resend.com/emails')

const admin = require('../api/admin.js')
const share = require('../api/share.js')
const purge = require('../api/purge.js')
const uploadUrl = require('../api/upload-url.js')
const uploadDone = require('../api/upload-done.js')
const inbound = require('../api/inbound.js')
const webhook = require('../api/stripe-webhook.js')
const { shareKeyFor } = require('../api/_common.js')

const SETUP = { token: T, kind: 'setup', parent_email: 'p@example.com', revoked_at: null, object_path: null }

console.log('\n=== 1 + 5. the desk\'s Delete ===')
{
  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') && c.method === 'GET'
    ? { status: 200, body: [{ ...SETUP, kind: 'iep', object_path: `${T}/iep.jpg` }] }
    : c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 200, body: [{ name: 'iep.pdf' }, { name: 'iep.jpg' }] }
    : { status: 200, body: [] }
  const d = await desk({ action: 'delete', token: T })
  const del = calls.find((c) => c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/ieps'))
  const p = del?.body?.prefixes || []
  check('★★ the unconfirmed file is deleted too, not only the one object_path points at',
    d.body.ok && p.includes(`${T}/iep.pdf`) && p.includes(`${T}/iep.jpg`), JSON.stringify(p))

  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') && c.method === 'GET' ? { status: 200, body: [SETUP] }
    : c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 200, body: [] }
    : c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/shared') ? { status: 400, body: { error: 'Invalid request' } }
    : { status: 200, body: [] }
  const bad = await desk({ action: 'delete', token: T })
  const rowGone = calls.some((c) => c.method === 'DELETE' && c.url.includes('/rest/v1/upload_tokens'))
  check('⛔⛔ a real 400 deleting the shared copy stops the Delete — the row (the only handle) stays',
    bad.code === 502 && !rowGone, `${bad.code} rowDeleted=${rowGone}`)

  route = (c) => c.url.includes('/rest/v1/upload_tokens') && c.method === 'GET' ? { status: 200, body: [SETUP] }
    : c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 200, body: [] }
    : c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/shared') ? { status: 400, body: { statusCode: '404', error: 'Bucket not found' } }
    : { status: 200, body: [] }
  check('★ but "Bucket not found" is nothing held, and the Delete goes ahead', (await desk({ action: 'delete', token: T })).code === 200)

  route = (c) => c.url.includes('/rest/v1/upload_tokens') && c.method === 'GET' ? { status: 200, body: [SETUP] }
    : c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 500, body: {} }
    : { status: 200, body: [] }
  calls = []
  const nolist = await desk({ action: 'delete', token: T })
  check('⛔ if the folder cannot be listed, nothing is deleted', nolist.code === 502
    && !calls.some((c) => c.method === 'DELETE'))
}

console.log('\n=== 2. revoke / reissue end the shared copy ===')
{
  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [{ ...SETUP, revoked_at: '2026-11-20T00:00:00Z' }] }
    : { status: 200, body: [] }
  const r = await desk({ action: 'revoke', token: T })
  const sh = calls.find((c) => c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/shared'))
  check('★★ revoking a setup deletes what they shared — their dead key could never switch it off',
    r.body.ok && r.body.sharedRemoved === true && JSON.stringify(sh?.body?.prefixes) === JSON.stringify([`${T}.json`]))

  route = (c) => c.method === 'DELETE' ? { status: 500, body: {} }
    : c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [{ ...SETUP, revoked_at: '2026-11-20T00:00:00Z' }] }
    : { status: 200, body: [] }
  const r2 = await desk({ action: 'revoke', token: T })
  check('★ a failed delete never undoes the revoke, and says so', r2.body.ok && r2.body.sharedRemoved === false && /Delete/.test(r2.body.warning || ''))

  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') && c.method === 'GET'
    ? { status: 200, body: [{ ...SETUP, setup_code: 'KL1abc' }] }
    : c.url.includes('/rest/v1/upload_tokens') && c.method === 'POST' ? { status: 201, body: [{ ...SETUP, token: 'ffffffff-6666-4666-8666-ffffffffffff' }] }
    : { status: 200, body: [] }
  await desk({ action: 'reissue', token: T })
  check('★ reissuing a setup deletes the old one\'s shared copy too',
    calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/shared') && c.body?.prefixes?.[0] === `${T}.json`))

  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [{ ...SETUP, kind: 'iep', revoked_at: 'x' }] } : { status: 200, body: [] }
  await desk({ action: 'revoke', token: T })
  check('and an IEP link\'s revoke touches no shared bucket', !calls.some((c) => c.url.includes('/object/shared')))
}

console.log('\n=== 3. sharing after the plan year ===')
{
  const K = shareKeyFor(T)
  const REC = { kind: 'kirton-learn-share', goals: [], attempts: [] }
  const OLD = { ...SETUP, stripe_session_id: 'cs_1', created_at: '2025-01-01T00:00:00Z' }
  const base = (member) => (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [OLD] }
    : c.url.includes('api.stripe.com/v1/checkout/sessions/') ? { status: 200, body: { id: 'cs_1', customer: 'cus_1' } }
    : c.url.includes('api.stripe.com/v1/customers') ? { status: 200, body: { data: [] } }
    : c.url.includes('api.stripe.com/v1/subscriptions') ? { status: 200, body: { data: member ? [{ status: 'active' }] : [] } }
    : c.url.includes('/storage/v1/object/shared') ? { status: 200, body: [{ name: 'x' }] }
    : { status: 404, body: {} }

  route = base(false)
  check('★ without STRIPE_READ_KEY nothing is purged, so sharing still works (an unknown is not a no)',
    (await call(share, { key: K, record: REC })).code === 200)
  process.env.STRIPE_READ_KEY = 'rk_test'
  const ended = await call(share, { key: K, record: REC })
  check('★★ past the plan year, not a member: refused, and told it is still on the device',
    ended.code === 410 && /still on this device/.test(ended.body.message || ''), JSON.stringify(ended))
  check('★ switching off still works after the plan year', (await call(share, { key: K, stop: true })).code === 200)
  route = base(true)
  check('★ a family still on the monthly plan keeps sharing', (await call(share, { key: K, record: REC })).code === 200)
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [{ ...OLD, created_at: new Date().toISOString() }] }
    : c.url.includes('/storage/v1/object/shared') ? { status: 200, body: {} } : { status: 404, body: {} }
  calls = []
  check('and inside the plan year Stripe is not even asked', (await call(share, { key: K, record: REC })).code === 200
    && !calls.some((c) => c.url.includes('stripe.com')))
  delete process.env.STRIPE_READ_KEY
}

console.log('\n=== 4. questions from /ask ===')
{
  const now = Date.parse('2026-11-20T00:00:00Z')
  const yrs = (n) => new Date(now - n * 365 * 864e5).toISOString()
  const due = purge.questionsDue([
    { id: 'a', email: 'old@example.com', asked_at: yrs(3) },
    { id: 'b', email: 'Back@example.com', asked_at: yrs(3) },
    { id: 'c', email: 'back@example.com', asked_at: yrs(0.1) },
    { id: 'd', email: 'answered@example.com', asked_at: yrs(3), answered_at: yrs(1) },
    { id: 'e', email: 'edge@example.com', asked_at: yrs(2) },
  ], now)
  check('★★ an address not heard from in 24 months is deleted', due.includes('a'))
  check('★ one recent question keeps that person\'s older ones (any letter case)', !due.includes('b') && !due.includes('c'))
  check('★ an answer counts as contact', !due.includes('d'))
  check('★ exactly 24 months is not yet past the week of margin', !due.includes('e'))

  process.env.CRON_SECRET = 'cron'
  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [] }
    : c.url.includes('/rest/v1/questions') && c.method === 'GET' ? { status: 200, body: [{ id: 'q1', email: 'x@example.com', asked_at: '2020-01-01T00:00:00Z' }] }
    : { status: 200, body: [] }
  const run = await call(purge, null, { method: 'GET', headers: { authorization: 'Bearer cron' } })
  const qdel = calls.find((c) => c.method === 'DELETE' && c.url.includes('/rest/v1/questions'))
  check('★★ the daily run deletes them', run.body.questionsDeleted === 1 && /id=in\.\(q1\)/.test(qdel?.url || ''), JSON.stringify(run.body))
  calls = []
  const dry = await call(purge, null, { method: 'GET', headers: { 'x-admin-key': 'k' } })
  check('⛔ by hand it only counts, never deletes', dry.body.questionsDeleted === 1
    && !calls.some((c) => c.method === 'DELETE'))
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [] }
    : c.url.includes('/rest/v1/questions') ? { status: 404, body: {} } : { status: 200, body: [] }
  const none = await call(purge, null, { method: 'GET', headers: { authorization: 'Bearer cron' } })
  check('no questions table yet is not an error', none.body.errors === 0)
}

console.log('\n=== 6. inbound mail is text only ===')
{
  const t = inbound.htmlToText('<style>p{}</style><p>Hi &amp; <b>bye</b></p><a href="https://e.example/x">link</a><img src="http://t.example/p.gif">')
  check('★ HTML is flattened: no tags, no style, the link kept as text', t === 'Hi & bye\nlink [https://e.example/x]', JSON.stringify(t))
  const src = readFileSync(new URL('../api/inbound.js', import.meta.url), 'utf8')
  check('⛔⛔ nothing forwards the sender\'s HTML any more', !/\bhtml:\s*`/.test(src) && !/mail\.html\s*\+/.test(src))
}

console.log('\n=== 7. upload-url ===')
{
  const row = [{ token: T, used_at: null, expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null, kind: 'iep' }]
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: row }
    : c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 200, body: [{ name: 'iep.pdf' }] }
    : c.url.includes('/object/upload/sign/') ? { status: 200, body: { url: '/object/upload/sign/ieps/x?token=y' } }
    : { status: 200, body: [] }
  const ask = { token: T, filename: 'a.pdf', size: 1000 }
  check('⛔ "constructor" is not an allowed file type', (await call(uploadUrl, { ...ask, type: 'constructor' })).code === 400)
  check('⛔ nor "__proto__"', (await call(uploadUrl, { ...ask, type: '__proto__' })).code === 400)
  check('⛔ a body that is not JSON is a 400, not a crash', (await call(uploadUrl, '{nope')).code === 400)
  calls = []
  const ok = await call(uploadUrl, { ...ask, type: 'application/pdf' })
  const cleared = calls.findIndex((c) => c.method === 'DELETE' && c.url.endsWith('/storage/v1/object/ieps')
    && c.body?.prefixes?.[0] === `${T}/iep.pdf`)
  const signed = calls.findIndex((c) => c.url.includes('/object/upload/sign/'))
  check('★★ an earlier unconfirmed try is cleared BEFORE the new slot is signed', ok.code === 200 && cleared >= 0 && cleared < signed)
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: row }
    : c.url.endsWith('/storage/v1/object/list/ieps') ? 'throw'
    : c.url.includes('/object/upload/sign/') ? { status: 200, body: { url: '/x' } } : { status: 200, body: [] }
  check('★ and if that cleanup fails, the parent can still upload', (await call(uploadUrl, { ...ask, type: 'application/pdf' })).code === 200)
}

console.log('\n=== 8. upload-done ===')
{
  const P = `${T}/iep.pdf`
  route = (c) => c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 200, body: [{ name: 'iep.pdf' }] }
    : c.method === 'PATCH' ? { status: 200, body: [] } : { status: 200, body: [] }
  calls = []
  const r = await call(uploadDone, { token: T, objectPath: P })
  check('⛔⛔ a burn that matched no live row is refused, and nobody is emailed', r.code === 403 && resend().length === 0, JSON.stringify(r))
  const patch = calls.find((c) => c.method === 'PATCH')
  check('★ the burn only matches an unused, unrevoked, non-setup row',
    /used_at=is\.null/.test(patch?.url) && /revoked_at=is\.null/.test(patch?.url) && /kind=neq\.setup/.test(patch?.url))
  route = (c) => c.url.endsWith('/storage/v1/object/list/ieps') ? { status: 200, body: [{ name: 'iep.pdf' }] }
    : c.method === 'PATCH' ? { status: 200, body: [{ token: T, kind: 'iep' }] } : { status: 200, body: {} }
  calls = []
  const good = await call(uploadDone, { token: T, objectPath: P })
  check('★ a real burn still confirms and tells Lamont', good.code === 200 && resend().length === 1)
  check('⛔ a body that is not JSON is a 400, not a crash', (await call(uploadDone, '{nope')).code === 400)
}

console.log('\n=== 9. a paid sale the site cannot save ===')
{
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_stuck', payment_status: 'paid', amount_total: 34900, payment_link: 'plink_1UCLO81pO3j9etUd9FVhdDCa',
    success_url: 'https://kirtonlearning.com/welcome', customer_details: { email: 'parent@example.com', name: 'Pat Parent' },
  } } })
  const t = Math.floor(Date.now() / 1000)
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${event}`).digest('hex')}`
  const hit = async () => {
    const req = Readable.from([Buffer.from(event)]); req.method = 'POST'; req.headers = { 'stripe-signature': sig }
    return new Promise((resolve) => {
      const res = { code: 0, setHeader () {}, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, body: b }); return this } }
      webhook(req, res)
    })
  }
  calls = []
  route = (c) => c.url.startsWith(SB) ? 'throw' : { status: 200, body: { id: 'em_1' } }
  const r = await hit()
  const alert = resend().find((c) => c.body?.to?.includes?.('alert@example.com') || c.body?.to === 'alert@example.com')
  check('★ the delivery still fails, so Stripe retries', r.code === 500, JSON.stringify(r))
  check('★★★ and Lamont is emailed that a family paid and has no link', !!alert && /did NOT get their link/.test(alert.body.subject)
    && /\$349\.00/.test(alert.body.subject), JSON.stringify(alert?.body?.subject))
  check('⛔ the alert carries no child, only the buyer and the session', alert && !/Pat Parent/.test(alert.body.text) && /cs_stuck/.test(alert.body.text))

  calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 503, body: {} } : { status: 200, body: { id: 'em_1' } }
  const r2 = await hit()
  check('★ a refused insert alerts too', r2.code === 502 && resend().length === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
