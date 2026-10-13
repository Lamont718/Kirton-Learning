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
  { token: id(1), kind: 'iep', parent_email: 'old@x.co', created_at: ago(700), used_at: ago(630), intake_at: null, object_path: `${id(1)}/iep.pdf` },
  { token: id(2), kind: 'iep', parent_email: 'young@x.co', created_at: ago(400), used_at: ago(390), intake_at: null, object_path: `${id(2)}/iep.pdf` },
  { token: id(3), kind: 'iep', parent_email: 'member@x.co', created_at: ago(700), used_at: ago(650), intake_at: null, object_path: `${id(3)}/iep.pdf` },
  { token: id(4), kind: 'setup', parent_email: 'setup@x.co', created_at: ago(300), used_at: null, intake_at: null, object_path: null },
  { token: id(5), kind: 'iep', parent_email: 'late-intake@x.co', created_at: ago(700), used_at: ago(690), intake_at: ago(500), object_path: `${id(5)}/iep.pdf` },
]

let calls = [], stripeDown = false, storageDown = false
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method || 'GET'
  let body = null; try { body = init.body ? JSON.parse(init.body) : null } catch { body = init.body }
  calls.push({ u, method, body })
  const ok = (b, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) })
  if (u.startsWith('https://api.stripe.com/')) {
    if (stripeDown) return ok({}, 500)
    if (u.includes('/customers?')) return ok({ data: u.includes('member%40x.co') ? [{ id: 'cus_m' }] : [{ id: 'cus_o' }] })
    if (u.includes('/subscriptions?')) return ok({ data: u.includes('cus_m') ? [{ status: 'active' }] : [{ status: 'canceled' }] })
  }
  if (u.includes('/rest/v1/upload_tokens?select=')) return ok(ROWS)
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
check('the family past 36 weeks + 12 months is deleted — file first, then the row',
  rowDeletes().includes(id(1)) && calls.findIndex((c) => c.method === 'DELETE' && c.body?.prefixes?.[0] === `${id(1)}/iep.pdf`) < calls.findIndex((c) => c.u.includes(`token=eq.${id(1)}`)),
  JSON.stringify(rowDeletes()))
check('★ a family inside the window is left alone', !rowDeletes().includes(id(2)))
check('⛔⛔ a family still on the monthly plan is NEVER deleted', !rowDeletes().includes(id(3)) && r.b.member === 1, JSON.stringify(r.b))
check('★ the clock starts at the LATEST thing on the row — an intake answered later moves it', !rowDeletes().includes(id(5)))
check('★ shared work goes at the end of the plan year, while the setup row stays',
  deleted().some((c) => c.u.endsWith('/storage/v1/object/shared') && c.body?.prefixes?.[0] === `${id(4)}.json`) && !rowDeletes().includes(id(4)))
check('the counts add up', r.b.deleted === 1 && r.b.sharedRemoved === 1, JSON.stringify(r.b))

console.log('\n=== when something cannot be checked or fails ===')
stripeDown = true; calls = []
r = await run()
check('⛔ Stripe unreachable = skipped, not deleted', rowDeletes().length === 0 && r.b.unknown >= 1, JSON.stringify(r.b))
stripeDown = false; storageDown = true; calls = []
r = await run()
check('⛔⛔ a file that will not delete keeps its row — never an orphaned IEP', rowDeletes().length === 0 && r.b.errors >= 1, JSON.stringify(r.b))
storageDown = false

console.log('\n=== by hand ===')
calls = []
r = await run({ headers: { 'x-admin-key': 'admin-key-for-tests' }, url: '/api/purge?dry=1' })
check('?dry=1 with the admin key lists what would go and deletes nothing', r.code === 200 && r.b.dry && r.b.deleted === 1 && deleted().length === 0, JSON.stringify(r.b))
calls = []
r = await run({ url: '/api/purge?dry=1' })
check('?dry=1 from the cron is ignored — cron runs are real', !r.b.dry)

console.log('\n=== it is scheduled ===')
const vercel = JSON.parse(require('node:fs').readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
check('vercel.json runs /api/purge daily', (vercel.crons || []).some((c) => c.path === '/api/purge'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
