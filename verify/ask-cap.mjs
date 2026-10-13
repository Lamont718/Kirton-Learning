// The /ask cap. Every accepted POST is a stored row and an email to Lamont's
// inbox, and until 2026-10-13 nothing stood in front of either. Offline:
// Supabase and Resend are replaced by a recording fetch.
//     node verify/ask-cap.mjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
let rows = [], calls = []
globalThis.fetch = async (url, init = {}) => {
  calls.push([init.method || 'GET', String(url)])
  if (String(url).includes('/rest/v1/questions?select')) return rows === 'down' ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => rows }
  if (String(url).endsWith('/rest/v1/questions')) return { ok: true, status: 201, json: async () => [{ id: 'q1' }], text: async () => '' }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
}
const ask = require('../api/ask.js')
const call = (body) => new Promise((resolve) => {
  const req = { method: "POST", headers: { "content-type": "application/json" }, body }
  const res = { code: 200, headers: {}, setHeader () {}, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, b }) }, end () { resolve({ code: this.code }) } }
  ask(req, res)
})
const B = { email: 'a@b.co', message: 'hello there' }
let ok = 0, bad = 0; const t = (n, c) => { c ? ok++ : bad++; console.log((c ? 'ok   ' : 'FAIL ') + n) }
rows = []; t('a first question goes through', (await call(B)).code === 200)
rows = [{ email: 'A@B.co' }, { email: 'a@b.co' }]; t('a third from one address goes through', (await call(B)).code === 200)
rows = [{ email: 'A@B.co' }, { email: 'a@b.co' }, { email: 'a@b.co' }]; calls = []; const r = await call(B)
t('a fourth in an hour is refused 429', r.code === 429); t('and nothing is stored', !calls.some(([m, u]) => m === 'POST'))
rows = Array.from({ length: 30 }, (_, i) => ({ email: `p${i}@x.co` })); t('30 in an hour from anyone closes it', (await call(B)).code === 429)
rows = 'down'; t('if the count fails, the question still goes through', (await call(B)).code === 200)
console.log(`${ok} passed, ${bad} failed`)
