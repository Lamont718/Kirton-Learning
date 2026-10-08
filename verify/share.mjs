// The receiving end of the opt-in share — api/share.js, and the desk's two
// actions that read it back.
//
//     node verify/share.mjs
//
// Offline. Supabase is replaced by a recording fetch, so this asks what the
// server DOES with each request it can get:
//
//   · only a live SETUP token is a key, and a revoked one is refused
//   · a record carrying a name is refused outright — the app never sends one
//   · `stop` deletes the family's copy
//   · only the work app's origin is allowed to post here from a browser
//   · the desk lists who is sharing and reads one record, behind its key
//
// The app side (off by default, never the name, one address) is asserted in
// kirton-learn/verify/e2e.mjs.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log('  ok    ' + n) }
  else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')) }
}

const T = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const SB = 'https://x.supabase.co'
Object.assign(process.env, { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'svc', ADMIN_KEY: 'k' })
delete process.env.APP_ORIGIN

let calls = []
let route = () => ({ status: 404, body: {} })
globalThis.fetch = async (url, init = {}) => {
  let body = null
  try { body = init.body ? JSON.parse(init.body) : null } catch { body = init.body }
  const c = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body }
  calls.push(c)
  const r = route(c)
  return { ok: r.status < 300, status: r.status, json: async () => r.body }
}

function call (handler, body, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      code: 200, headers: {},
      setHeader (k, v) { this.headers[k] = v },
      status (c) { this.code = c; return this },
      json (b) { resolve({ code: this.code, body: b, headers: this.headers }) },
      end () { resolve({ code: this.code, body: null, headers: this.headers }) },
    }
    handler({ method, headers, body }, res)
  })
}

const share = require('../api/share.js')
const admin = require('../api/admin.js')
const SETUP = { token: T, kind: 'setup', revoked_at: null }
const REC = { kind: 'kirton-learn-share', version: 1, sentOn: '2026-10-08', accommodations: {},
  goals: [{ id: 'g1', text: 'A goal.', engineId: 'main-idea', criterion: { accuracy: 0.8, of: 4, outOf: 5 } }],
  attempts: [{ id: 'a1', goalId: 'g1', dateISO: '2026-10-08', score: 3, outOf: 3 }] }
const tokens = (row) => (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: row ? [row] : [] }
  : c.url.includes('/storage/v1/object/shared/') ? { status: 200, body: { Key: 'ok' } }
  : { status: 404, body: {} }

console.log('\n=== who may post here ===')
{
  const pre = await call(share, null, { method: 'OPTIONS' })
  check('★ a browser preflight is answered', pre.code === 204)
  check('★★ and only the work app is allowed to post from a browser',
    pre.headers['Access-Control-Allow-Origin'] === 'https://kirton-learn.vercel.app', pre.headers['Access-Control-Allow-Origin'])
  check('anything but POST is refused', (await call(share, {}, { method: 'GET' })).code === 405)
}

console.log('\n=== the key ===')
{
  route = tokens(SETUP); calls = []
  const bad = await call(share, { key: 'nope', record: REC })
  check('⛔ a malformed key is refused before the database is asked', bad.code === 400 && calls.length === 0)

  route = tokens(null)
  check('⛔ a key that is no token is refused', (await call(share, { key: T, record: REC })).code === 403)

  route = tokens({ ...SETUP, kind: 'iep' })
  check('⛔⛔ an IEP upload token is NOT a share key — only a setup token is',
    (await call(share, { key: T, record: REC })).code === 403)

  route = tokens({ ...SETUP, revoked_at: '2026-10-01T00:00:00Z' })
  const rev = await call(share, { key: T, record: REC })
  check('★★ a revoked setup is refused — revoke is how Lamont ends a family\'s sharing', rev.code === 403)

  route = tokens({ ...SETUP, expires_at: '2020-01-01T00:00:00Z' })
  check('★ an EXPIRED setup still shares: the expiry is on collecting the goals, not on a year of work',
    (await call(share, { key: T, record: REC })).code === 200)
}

console.log('\n=== what it will keep ===')
{
  route = tokens(SETUP)
  check('⛔⛔ a record carrying a name is refused, not stored',
    (await call(share, { key: T, record: { ...REC, name: 'Ada' } })).code === 400)
  check('⛔ so is a whole device (learners), which would carry every child on it',
    (await call(share, { key: T, record: { ...REC, learners: [] } })).code === 400)
  check('something that is not a work-app record is refused',
    (await call(share, { key: T, record: { ...REC, kind: 'kirton-learn-backup' } })).code === 400)

  calls = []
  const ok = await call(share, { key: T, record: REC })
  const put = calls.find((c) => c.url.includes('/storage/v1/object/shared/'))
  check('★ a good record is kept', ok.code === 200 && ok.body.ok === true)
  check('★★ in the private `shared` bucket, one file per family, named by the key',
    put && put.url === `${SB}/storage/v1/object/shared/${T}.json`, put?.url)
  check('★ replacing the last one, not piling up copies', put?.headers['x-upsert'] === 'true')
  check('and stamped with when it arrived', typeof put?.body?.receivedAt === 'string')

  // First share ever: no bucket yet.
  let made = false; calls = []
  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [SETUP] }
    : c.url.endsWith('/storage/v1/bucket') ? (made = true, { status: 200, body: {} })
    : c.url.includes('/storage/v1/object/shared/') ? (made ? { status: 200, body: {} } : { status: 404, body: {} })
    : { status: 404, body: {} }
  const first = await call(share, { key: T, record: REC })
  const bucket = calls.find((c) => c.url.endsWith('/storage/v1/bucket'))
  check('★★ the first share ever makes the bucket, and the record still lands', first.code === 200 && made)
  check('★★★ and the bucket it makes is PRIVATE, JSON only', bucket?.body?.public === false
    && JSON.stringify(bucket?.body?.allowed_mime_types) === '["application/json"]')
}

console.log('\n=== ★★★ switching it off deletes what we hold ===')
{
  route = tokens(SETUP); calls = []
  const off = await call(share, { key: T, stop: true })
  const del = calls.find((c) => c.method === 'DELETE')
  check('★★★ stop DELETES the family\'s copy', off.code === 200 && del?.url === `${SB}/storage/v1/object/shared/${T}.json`)
  route = tokens({ ...SETUP, revoked_at: '2026-10-01T00:00:00Z' })
  check('⛔ and a stranger cannot delete it with a dead key', (await call(share, { key: T, stop: true })).code === 403)
}

console.log('\n=== the desk ===')
{
  route = (c) => c.url.includes('/storage/v1/object/list/shared')
    ? { status: 200, body: [{ name: `${T}.json`, updated_at: '2026-10-08T12:00:00Z' }, { name: '.emptyFolderPlaceholder' }] }
    : { status: 404, body: {} }
  const nokey = await call(admin, { action: 'shared-list' }, { headers: {} })
  check('⛔ the list needs the admin key', nokey.code === 401)
  const list = await call(admin, { action: 'shared-list' }, { headers: { 'x-admin-key': 'k' } })
  check('★ it lists which families are sharing, and when', list.body.ok && list.body.shared[T] === '2026-10-08T12:00:00Z'
    && Object.keys(list.body.shared).length === 1, JSON.stringify(list.body))

  route = () => ({ status: 400, body: {} })
  const none = await call(admin, { action: 'shared-list' }, { headers: { 'x-admin-key': 'k' } })
  check('★ no bucket yet means nobody shares — an answer, not an error', none.code === 200 && Object.keys(none.body.shared).length === 0)

  route = (c) => c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [{ ...SETUP, child_label: 'Ada' }] }
    : c.url.includes(`/storage/v1/object/shared/${T}.json`) ? { status: 200, body: REC }
    : { status: 404, body: {} }
  const one = await call(admin, { action: 'shared', token: T }, { headers: { 'x-admin-key': 'k' } })
  check('★ one family\'s record reads back, named from the desk\'s own label', one.body.ok
    && one.body.record.goals.length === 1 && one.body.child === 'Ada')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
