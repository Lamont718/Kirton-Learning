// One table holds three kinds of link — iep, record, setup — and each opens one
// door. Until 2026-10-13 a SETUP link (the one that carries a child's goals to the
// work app) could also get an IEP upload slot and submit the six intake questions.
// Offline: Supabase is replaced by a recording fetch.
//     node verify/token-kinds.mjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.SUPABASE_URL = 'https://x.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'

const T = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const future = new Date(Date.now() + 864e5).toISOString()
let kind = 'iep'
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/rest/v1/upload_tokens')) {
    const row = { token: T, kind, used_at: null, revoked_at: null, expires_at: future, intake_at: null, child_label: 'Sam' }
    return { ok: true, status: 200, json: async () => [row], text: async () => '' }
  }
  if (u.includes('/object/upload/sign/')) return { ok: true, status: 200, json: async () => ({ url: '/object/upload/sign/x?token=y' }), text: async () => '' }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
}
const call = (h, body) => new Promise((resolve) => {
  const res = { code: 200, setHeader () {}, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, b }) }, end () { resolve({ code: this.code }) } }
  h({ method: 'POST', headers: {}, body }, res)
})
const uploadUrl = require('../api/upload-url.js')
const intake = require('../api/intake.js')
const FILE = { token: T, filename: 'iep.pdf', size: 1000, type: 'application/pdf' }

let pass = 0, fail = 0
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok    ' : '  FAIL  ') + n + (ok || !d ? '' : '\n        ' + d)) }

kind = 'iep'
const a = await call(uploadUrl, FILE)
check('an IEP link gets an upload slot', a.code === 200, JSON.stringify(a))
const b = await call(intake, { action: 'check', token: T })
check('an IEP link opens the six questions', b.code === 200, JSON.stringify(b))
kind = 'setup'
check('⛔⛔ a SETUP link gets no upload slot', (await call(uploadUrl, FILE)).code === 403)
check('⛔⛔ a SETUP link does not open the six questions', (await call(intake, { action: 'check', token: T })).code === 403)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
