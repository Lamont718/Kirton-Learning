// The retention run (api/purge.js) against what privacy.html promises:
// the IEP and intake answers go 12 months after the plan year (36 weeks) ends,
// shared work goes when the plan year ends, and a family still on the monthly
// plan is never touched. Offline: Supabase, Stripe and Resend are a recording fetch.
//     node verify/purge.mjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.SUPABASE_URL = 'https://x.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
process.env.CRON_SECRET = 'cron-secret-for-tests'
process.env.ADMIN_KEY = 'admin-key-for-tests'
process.env.RESEND_API_KEY = 're_test'
process.env.MAIL_FROM = 'x@kirtonlearning.com'
process.env.FORWARD_TO = 'y@example.com'

const DAY = 864e5
const ago = (d) => new Date(Date.now() - d * DAY).toISOString()
const id = (n) => `0000000${n}-0000-4000-8000-000000000000`

// 36 weeks = 252 days; +365 = 617; +7 margin = 624.
const ROWS = [
  // A Blueprint buyer: their own checkout session, one-time, long past the window.
  { token: id(1), kind: 'iep', parent_email: 'old@x.co', stripe_session_id: 'cs_blueprint', created_at: ago(700), used_at: ago(630), intake_at: null, object_path: `${id(1)}/iep.pdf` },
  { token: id(2), kind: 'iep', parent_email: 'young@x.co', stripe_session_id: 'cs_young', created_at: ago(400), used_at: ago(390), intake_at: null, object_path: `${id(2)}/iep.pdf` },
  // ⛔ Pays monthly — and the email on the row is NOT the one on their Stripe customer.
  { token: id(3), kind: 'iep', parent_email: 'Member@X.co', stripe_session_id: 'cs_member', created_at: ago(700), used_at: ago(650), intake_at: null, object_path: `${id(3)}/iep.pdf` },
  { token: id(4), kind: 'setup', parent_email: 'old@x.co', stripe_session_id: null, created_at: ago(300), used_at: null, intake_at: null, object_path: null },
  { token: id(5), kind: 'iep', parent_email: 'late-intake@x.co', stripe_session_id: 'cs_late', created_at: ago(700), used_at: ago(690), intake_at: ago(500), object_path: `${id(5)}/iep.pdf` },
  // Issued by hand at the desk: no session, and no Stripe customer under this address.
  { token: id(6), kind: 'iep', parent_email: 'hand@x.co', stripe_session_id: null, created_at: ago(700), used_at: ago(690), intake_at: null, object_path: `${id(6)}/iep.pdf` },
  // An upload that landed but was never confirmed: a file in the bucket, no path on the row.
  { token: id(7), kind: 'iep', parent_email: 'old@x.co', stripe_session_id: 'cs_unconfirmed', created_at: ago(700), used_at: null, intake_at: null, object_path: null },
  // A subscription that never got paid ('incomplete') is not a member.
  { token: id(8), kind: 'iep', parent_email: 'never-paid@x.co', stripe_session_id: 'cs_incomplete', created_at: ago(700), used_at: ago(690), intake_at: null, object_path: `${id(8)}/iep.pdf` },
]
const SESSIONS = {
  cs_blueprint: { customer: null, subscription: null },
  cs_young: { customer: null, subscription: null },
  cs_member: { customer: 'cus_member', subscription: 'sub_member' },
  cs_late: { customer: null, subscription: null },
  cs_unconfirmed: { customer: null, subscription: null },
  cs_incomplete: { customer: 'cus_np', subscription: 'sub_np' },
}
const SUBS = { cus_member: [{ status: 'active' }], cus_np: [{ status: 'incomplete' }], cus_old: [{ status: 'canceled' }] }
const SUB_BY_ID = { sub_member: { status: 'active' }, sub_np: { status: 'incomplete' } }
// Stripe matches email EXACTLY. member@x.co's customer is under a different address.
const CUSTOMERS = { 'old@x.co': [{ id: 'cus_old' }] }

let calls = [], stripeDown = false, storageDown = false, shared400 = false
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method || 'GET'
  let body = null; try { body = init.body ? JSON.parse(init.body) : null } catch { body = init.body }
  calls.push({ u, method, body })
  const ok = (b, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) })
  if (u.startsWith('https://api.stripe.com/')) {
    if (stripeDown) return ok({}, 500)
    const m = u.match(/checkout\/sessions\/([^?]+)/); if (m) return SESSIONS[m[1]] ? ok(SESSIONS[m[1]]) : ok({}, 404)
    const e = u.match(/customers\?.*email=([^&]+)/); if (e) return ok({ data: CUSTOMERS[decodeURIComponent(e[1])] || [] })
    const c = u.match(/subscriptions\?.*customer=([^&]+)/); if (c) return ok({ data: SUBS[decodeURIComponent(c[1])] || [] })
    const s1 = u.match(/subscriptions\/([^?]+)/); if (s1) return ok(SUB_BY_ID[s1[1]] || {})
  }
  if (u.includes('/rest/v1/upload_tokens?select=')) return ok(ROWS)
  if (u.endsWith('/storage/v1/object/list/ieps')) return ok(body.prefix === id(7) ? [{ name: 'iep.pdf' }] : [])
  if (method === 'DELETE' && u.endsWith('/storage/v1/object/shared') && shared400) return ok({ error: 'Invalid request' }, 400)
  if (method === 'DELETE' && u.includes('/storage/v1/object/')) return storageDown ? ok({}, 500) : ok(body?.prefixes?.map((p) => ({ name: p })) || [])
  if (method === 'DELETE' && u.includes('/rest/v1/upload_tokens?token=eq.')) return ok([], 204)
  if (u.includes('api.resend.com')) return ok({ id: 'em' })
  return ok({}, 404)
}

const purge = require('../api/purge.js')
const run = ({ headers = { authorization: 'Bearer cron-secret-for-tests' }, url = '/api/purge', method = 'GET' } = {}) =>
  new Promise((resolve) => {
    const res = { code: 200, setHeader () {}, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, b }) }, end () { resolve({ code: this.code }) } }
    purge({ method, headers, url }, res)
  })
const deleted = () => calls.filter((c) => c.method === 'DELETE')
const rowDeletes = () => deleted().filter((c) => c.u.includes('/rest/v1/upload_tokens?token=eq.')).map((c) => decodeURIComponent(c.u.split('token=eq.')[1]))

let pass = 0, fail = 0
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok    ' : '  FAIL  ') + n + (ok || !d ? '' : '\n        ' + d)) }

console.log('\n=== who may run it ===')
check('nobody without the cron secret or the admin key', (await run({ headers: {} })).code === 401)
check('a wrong secret is refused', (await run({ headers: { authorization: 'Bearer nope' } })).code === 401)
check('POST is refused', (await run({ method: 'POST' })).code === 405)

console.log('\n=== ⛔ without the Stripe key, NOTHING is deleted ===')
delete process.env.STRIPE_READ_KEY
calls = []
let r = await run()
check('it runs and says what it needs', r.code === 200 && r.b.needs === 'STRIPE_READ_KEY', JSON.stringify(r.b))
check('⛔⛔ no file and no row was deleted', deleted().length === 0)
check('and he is emailed that families are being held', calls.some((c) => c.u.includes('resend')))

console.log('\n=== with it ===')
process.env.STRIPE_READ_KEY = 'rk_test'
calls = []
r = await run()
const fileDeletes = () => deleted().filter((c) => c.u.endsWith('/storage/v1/object/ieps')).flatMap((c) => c.body.prefixes)
check('a Blueprint family past 36 weeks + 12 months is deleted — file first, then the row',
  rowDeletes().includes(id(1)) && calls.findIndex((c) => c.method === 'DELETE' && c.body?.prefixes?.includes(`${id(1)}/iep.pdf`)) < calls.findIndex((c) => c.u.includes(`token=eq.${id(1)}`)),
  JSON.stringify(rowDeletes()))
check('★ a family inside the window is left alone', !rowDeletes().includes(id(2)))
check('⛔⛔ a family still paying monthly is NEVER deleted — found through their own checkout, though the email differs', !rowDeletes().includes(id(3)), JSON.stringify(r.b))
check('★ the clock starts at the LATEST thing on the row — an intake answered later moves it', !rowDeletes().includes(id(5)))
check('⛔⛔ no session and no customer under that address = we do not know = kept', !rowDeletes().includes(id(6)) && r.b.unknown >= 1)
check('⛔⛔ an upload never confirmed still has its file deleted — no orphaned IEP', rowDeletes().includes(id(7)) && fileDeletes().includes(`${id(7)}/iep.pdf`), JSON.stringify(fileDeletes()))
check('★ an "incomplete" subscription that never paid is not a member', rowDeletes().includes(id(8)))
check('★ shared work goes at the end of the plan year, while the setup row stays',
  deleted().some((c) => c.u.endsWith('/storage/v1/object/shared') && c.body?.prefixes?.[0] === `${id(4)}.json`) && !rowDeletes().includes(id(4)))
check('the counts add up', r.b.deleted === 3 && r.b.sharedRemoved === 1 && r.b.member === 1 && r.b.unknown === 1, JSON.stringify(r.b))

console.log('\n=== when something cannot be checked or fails ===')
stripeDown = true; calls = []
r = await run()
check('⛔ Stripe unreachable = skipped, not deleted', rowDeletes().length === 0 && r.b.unknown >= 1, JSON.stringify(r.b))
stripeDown = false; storageDown = true; calls = []
r = await run()
check('⛔⛔ a file that will not delete keeps its row — never an orphaned IEP', rowDeletes().length === 0 && r.b.errors >= 1, JSON.stringify(r.b))
storageDown = false; shared400 = true; calls = []
ROWS[3].created_at = ago(700)
r = await run()
check('⛔ a 400 from the shared bucket is a failure, not "nothing there" — the setup row stays', !rowDeletes().includes(id(4)))
shared400 = false; ROWS[3].created_at = ago(300)

console.log('\n=== by hand ===')
calls = []
r = await run({ headers: { 'x-admin-key': 'admin-key-for-tests' }, url: '/api/purge' })
check('⛔ with the admin key it is ALWAYS a dry run — lists what would go, deletes nothing', r.code === 200 && r.b.dry && r.b.deleted === 3 && deleted().length === 0, JSON.stringify(r.b))
calls = []
r = await run({ url: '/api/purge?dry=1' })
check('the schedule deletes for real', !r.b.dry)

console.log('\n=== it is scheduled ===')
const vercel = JSON.parse(require('node:fs').readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
check('vercel.json runs /api/purge daily', (vercel.crons || []).some((c) => c.path === '/api/purge'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
