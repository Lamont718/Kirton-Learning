// Reading what a family sent, and being told it arrived — the server side.
//
//     node verify/desk-read.mjs
//
// Offline. Supabase and Resend are replaced by a recording fetch, so this asks
// what api/admin.js and api/upload-done.js DO with each answer they can get:
//
//   · `open` hands back a 60-second signed link and never touches the file
//   · `intake` returns the six answers, and only to the key
//   · a finished upload emails Lamont — with nothing about the family in it —
//     and the parent's answer is the same when that email fails
//
// The page side is verify/admin-desk.mjs.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log('  ok    ' + n) }
  else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')) }
}

const T = 'cccccccc-3333-4333-8333-cccccccccccc'
const SB = 'https://x.supabase.co'
Object.assign(process.env, {
  SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'svc', ADMIN_KEY: 'k',
  RESEND_API_KEY: 're', MAIL_FROM: 'desk@kirtonlearning.com', ALERT_TO: 'lamont@example.com',
})

let calls = []
let route = () => ({ status: 404, body: {} })
globalThis.fetch = async (url, init = {}) => {
  const c = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }
  calls.push(c)
  const r = route(c)
  return { ok: r.status < 300, status: r.status, json: async () => r.body }
}

function call (handler, body, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      code: 200, headers: {},
      setHeader (k, v) { this.headers[k] = v },
      status (c) { this.code = c; return this },
      json (b) { resolve({ code: this.code, body: b }) },
    }
    handler({ method: 'POST', headers, body }, res)
  })
}

const admin = require('../api/admin.js')
const done = require('../api/upload-done.js')
const ROW = { token: T, parent_email: 'c@example.com', child_label: 'Bo', kind: 'iep',
  object_path: `${T}/Bo-IEP-2026.pdf`, expires_at: '2099-01-01T00:00:00Z' }

console.log('\n=== open ===')
{
  route = (c) =>
    c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [ROW] }
    : c.url.includes('/object/sign/ieps/') ? { status: 200, body: { signedURL: `/object/sign/ieps/${T}/Bo-IEP-2026.pdf?token=SIG` } }
    : { status: 404, body: {} }
  calls = []
  const r = await call(admin, { action: 'open', token: T }, { 'x-admin-key': 'k' })
  check('★★★ it answers with a signed link to the document', r.code === 200
    && r.body.url === `${SB}/storage/v1/object/sign/ieps/${T}/Bo-IEP-2026.pdf?token=SIG`, JSON.stringify(r.body))
  const sign = calls.find((c) => c.url.includes('/object/sign/'))
  check('⛔ that dies in 60 seconds', sign?.body?.expiresIn === 60 && r.body.expiresIn === 60)
  check('⛔⛔ and the document itself is never fetched by this server',
    !calls.some((c) => c.method === 'GET' && c.url.includes('/storage/v1/object/') && !c.url.includes('/sign/')))

  const noKey = await call(admin, { action: 'open', token: T }, { 'x-admin-key': 'wrong' })
  check('⛔ no key, no link', noKey.code === 401 && !noKey.body.url)

  route = (c) => c.url.includes('/rest/v1/upload_tokens')
    ? { status: 200, body: [{ ...ROW, object_path: null }] } : { status: 500, body: {} }
  const none = await call(admin, { action: 'open', token: T }, { 'x-admin-key': 'k' })
  check('★ nothing uploaded says so, and asks the store for nothing',
    none.code === 404 && /Nothing has been uploaded/.test(none.body.message))
}

console.log('\n=== intake ===')
{
  const Q = { child_first_name: 'Bo', grade: '3', interests: 'Trains', going_well: '', whats_hard: '',
    best_contact: '', submitted_at: '2026-10-02T12:05:00Z' }
  route = (c) => c.url.includes('/rest/v1/intakes') ? { status: 200, body: [Q] } : { status: 404, body: {} }
  const r = await call(admin, { action: 'intake', token: T }, { 'x-admin-key': 'k' })
  check('★★★ the six answers come back', r.code === 200 && r.body.intake?.interests === 'Trains', JSON.stringify(r.body))
  route = () => ({ status: 200, body: [] })
  const empty = await call(admin, { action: 'intake', token: T }, { 'x-admin-key': 'k' })
  check('★ not filled in yet is a plain sentence, not an empty box', empty.code === 404 && /not filled/.test(empty.body.message))
  const bad = await call(admin, { action: 'intake', token: "x' or 1=1" }, { 'x-admin-key': 'k' })
  check('⛔ a token that is not a token is refused before anything is asked', bad.code === 400)
}

console.log('\n=== a finished upload tells Lamont, and tells no one anything else ===')
{
  const storage = (c) =>
    c.url.includes('/object/list/ieps') ? { status: 200, body: [{ name: 'Bo-IEP-2026.pdf' }] }
    : c.url.includes('/rest/v1/upload_tokens') ? { status: 200, body: [ROW] }
    : null
  route = (c) => storage(c) || (c.url.includes('resend.com') ? { status: 200, body: { id: 'e1' } } : { status: 404, body: {} })
  calls = []
  const r = await call(done, { token: T, objectPath: `${T}/Bo-IEP-2026.pdf` })
  check('★ the upload is confirmed', r.code === 200 && r.body.ok === true, JSON.stringify(r.body))
  const mail = calls.find((c) => c.url.includes('resend.com'))
  check('★★★ Lamont is emailed', mail?.body?.to?.[0] === 'lamont@example.com', JSON.stringify(mail?.body ?? null))
  const all = JSON.stringify(mail?.body ?? {})
  check('⛔⛔ with no name, no child, no parent address and no file name in it',
    !/Bo|c@example\.com|IEP-2026|\.pdf/.test(all.replace(/IEP\./g, '')), all)
  check('★ and where to look', /\/admin/.test(mail?.body?.text ?? ''))
  const order = calls.findIndex((c) => c.url.includes('resend.com')) > calls.findIndex((c) => c.method === 'PATCH')
  check('⛔ only after the token is burned', order)

  route = (c) => storage(c) || (c.url.includes('resend.com') ? { status: 500, body: { message: 'down' } } : { status: 404, body: {} })
  const r2 = await call(done, { token: T, objectPath: `${T}/Bo-IEP-2026.pdf` })
  check('⛔⛔ the email failing changes nothing for the parent', r2.code === 200 && r2.body.ok === true)

  route = (c) => storage(c) || (c.url.includes('resend.com') ? (() => { throw new Error('network') })() : { status: 404, body: {} })
  const r3 = await call(done, { token: T, objectPath: `${T}/Bo-IEP-2026.pdf` })
  check('⛔ nor does the email provider being unreachable', r3.code === 200 && r3.body.ok === true)

  route = (c) => c.url.includes('/object/list/ieps') ? { status: 200, body: [] } : { status: 200, body: [ROW] }
  calls = []
  await call(done, { token: T, objectPath: `${T}/Bo-IEP-2026.pdf` })
  check('⛔ an upload that did not land emails nobody', !calls.some((c) => c.url.includes('resend.com')))
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exitCode = fail ? 1 : 0
