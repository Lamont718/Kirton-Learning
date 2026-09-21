// The back office, driven in a real browser with the API stubbed out.
//
//     node verify/admin-desk.mjs
//
// WHY THIS EXISTS. Every other suite here tests the server: the webhook
// signature, the token rules, the emails, the pages. Nothing has ever pressed a
// button on /admin.html. It is one file of hand-written vanilla JS, it is the
// only screen in this business with a key on it, and the newest thing on it
// hands over a child's IEP goals. A typo in a selector there is invisible until
// the moment it is being used, on a family's data, by the only person who can
// use it at all.
//
// ⛔ The API is STUBBED, deliberately and completely. This asks one question:
// does the PAGE do the right thing? What it sends, what it does with each
// answer it can get back, and what it leaves on the screen afterwards. The
// server's own behavior is tested by verify/setup-handoff.mjs and the token
// suites, against the real thing.
//
// ★★ The stub is installed before the page's own script runs, so nothing here
// depends on timing, and every call the page makes is recorded — including the
// ones it should NOT make.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 9571
const CDP = 9572
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log('  ok    ' + n) }
  else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')) }
}

const server = createServer(async (req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  try {
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('not found') }
})
await new Promise((r) => server.listen(PORT, r))

const profile = mkdtempSync(join(tmpdir(), 'kl-admin-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--mute-audio',
  '--window-size=1100,1400', 'about:blank'], { stdio: 'ignore' })

async function gj (path) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}${path}`); if (r.ok) return r.json() } catch {}
    await sleep(200)
  }
  throw new Error('no cdp')
}
const v = await gj('/json/version')
const ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pend = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? 'error')
  }
}
const raw = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = ++id
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }))
})
const { targetId } = await raw('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true })
const send = (m, p = {}) => raw(m, p, sessionId)
await send('Page.enable'); await send('Runtime.enable')
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}
const setVal = (sel, val) => ev(`(()=>{const el=document.querySelector('${sel}')
  el.value=${JSON.stringify(val)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`)

// ---------------------------------------------------------------------------
// The stub. Installed before the page's script, records every call, and answers
// whatever the current scenario says to answer.
// ---------------------------------------------------------------------------
const STUB = `
window.__calls = []
window.__reply = { ok: true }
window.fetch = function (url, opts) {
  const body = opts && opts.body ? JSON.parse(opts.body) : {}
  window.__calls.push({ url: String(url), key: opts && opts.headers && opts.headers['x-admin-key'], body })
  const r = (typeof window.__reply === 'function') ? window.__reply(body) : window.__reply
  return Promise.resolve({ status: r.status || 200, json: () => Promise.resolve(r.json || { ok: true, rows: [] }) })
}`
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/admin.html` })
await sleep(1200)

console.log('\nThe back office, driven\n')
console.log('=== the gate ===')
check('it opens locked', await ev(`!document.querySelector('#gate').hidden && document.querySelector('#desk').hidden`))
// ⛔ A wrong key must not open the desk, and the page must say so rather than
// showing an empty back office and letting him wonder.
await ev(`window.__reply = { status: 401, json: { ok: false, message: 'Not authorized.' } }`)
await setVal('#key', 'wrong-key')
await ev(`document.querySelector('#unlock').click()`); await sleep(400)
check('⛔ a refused key does not open the desk, and says so',
  (await ev(`document.querySelector('#desk').hidden`)) === true
  && /not right/i.test(await ev(`document.querySelector('#gate-err').textContent`)))

await ev(`window.__reply = (b) => b.action === 'status'
  ? { json: { ok: true, supabase: true, migrated: true, migrated3: true, migrated5: false,
      stripeWebhookSecret: true, resendKey: true, mailFrom: 'lamont@kirtonlearning.com',
      mailReady: true, apexMx: ['mx.example'], origin: 'https://kirtonlearning.com' } }
  : { json: { ok: true, rows: [] } }`)
await setVal('#key', 'right-key')
await ev(`document.querySelector('#unlock').click()`); await sleep(600)
check('★ the right key opens the desk', (await ev(`document.querySelector('#desk').hidden`)) === false)
check('★ and every call carries the key as a header, never in the body',
  await ev(`window.__calls.every(c => c.key === 'right-key' || c.key === 'wrong-key')
    && window.__calls.every(c => !('key' in c.body))`))

console.log('\n=== ⛔ the migration that has not been run says so, in amber, with the filename ===')
{
  const panel = await ev(`document.querySelector('#setup').textContent`)
  check('⛔ it names supabase-setup-5.sql when part 5 is missing',
    /supabase-setup-5\.sql/.test(panel), panel.slice(0, 200))
  check('★ and it is the warning style, not a green tick',
    await ev(`[...document.querySelectorAll('#setup .msg')].some(d =>
      /supabase-setup-5/.test(d.textContent) && d.className.includes('warn'))`))
}

console.log('\n=== ★★★ sending a setup ===')
{
  // ⛔ Nothing may be sent without an address or without a code — the two ways
  // this form can be half-filled, and both of them would be a family waiting.
  await ev(`window.__calls = []`)
  await setVal('#s-email', '')
  await setVal('#s-code', 'KL1.c.abc.deadbeef')
  await ev(`document.querySelector('#send-setup').click()`); await sleep(300)
  check('⛔ no address, nothing sent', (await ev(`window.__calls.length`)) === 0
    && /email address is needed/i.test(await ev(`document.querySelector('#flash').textContent`)))

  await setVal('#s-email', 'parent@example.com')
  await setVal('#s-code', '   ')
  await ev(`document.querySelector('#send-setup').click()`); await sleep(300)
  check('⛔ no code, nothing sent', (await ev(`window.__calls.length`)) === 0
    && /paste the setup link/i.test(await ev(`document.querySelector('#flash').textContent`)))

  // The real thing.
  await ev(`window.__reply = (b) => b.action === 'setup'
    ? { json: { ok: true, sent: true, goals: 3, madeOn: '2026-09-21',
        row: { token: 't1', link: 'https://kirtonlearning.com/setup?t=t1', status: 'live',
               kind: 'setup', parent_email: 'parent@example.com', issued_by: 'admin',
               created_at: '2026-09-21T10:00:00Z' } } }
    : { json: { ok: true, rows: [] } }`)
  await ev(`window.__calls = []`)
  await setVal('#s-email', 'parent@example.com')
  await setVal('#s-name', 'Rose')
  await setVal('#s-child', 'Ada')
  await setVal('#s-code', 'https://kirton-learn.vercel.app/#join=KL1.c.PAYLOAD.deadbeef')
  await ev(`document.querySelector('#send-setup').click()`); await sleep(500)

  const sent = JSON.parse(await ev(`JSON.stringify(window.__calls.find(c => c.body.action === 'setup') ?? null)`))
  check('★★★ it posts the setup, with the pasted link whole', Boolean(sent)
    && sent.body.email === 'parent@example.com' && sent.body.name === 'Rose'
    && sent.body.childLabel === 'Ada' && sent.body.send === true
    && sent.body.code.includes('KL1.c.PAYLOAD.deadbeef'), JSON.stringify(sent?.body ?? null))

  // ★★★ The goal count is the only thing on this screen that catches him
  // pasting the LAST child's setup out of a clipboard still holding it.
  const flash = await ev(`document.querySelector('#flash').textContent`)
  check('★★★ it reads the number of goals back, so the wrong child is catchable',
    /3 goals in that setup/i.test(flash), flash.slice(0, 160))
  check('★ and says where it went', /parent@example\.com/.test(flash))

  // ⛔ A child's IEP goals do not stay in a textarea on an unlocked laptop.
  const left = await ev(`JSON.stringify(['s-email','s-name','s-child','s-code']
    .map(id => document.getElementById(id).value))`)
  check('⛔⛔ the pasted code and the address are cleared afterwards',
    JSON.parse(left).every((x) => x === ''), left)
  check('★ and the list is reloaded, so the new row is on screen',
    await ev(`window.__calls.some(c => c.body.action === 'list')`))
}

console.log('\n=== ⛔ when it does not work, the screen says so rather than looking successful ===')
{
  // A code the server refuses: the desk must show the server's own sentence.
  await ev(`window.__reply = (b) => b.action === 'setup'
    ? { status: 400, json: { ok: false, message: 'That code is incomplete — it was cut short when it was copied. Nothing was stored.' } }
    : { json: { ok: true, rows: [] } }`)
  await setVal('#s-email', 'parent@example.com')
  await setVal('#s-code', 'KL1.c.CUT')
  await ev(`document.querySelector('#send-setup').click()`); await sleep(400)
  const bad = await ev(`document.querySelector('#flash').textContent`)
  check('⛔ a refused code shows the reason it was refused', /cut short/i.test(bad), bad.slice(0, 140))
  check('★★ and the code is still in the box, because he needs it to try again',
    (await ev(`document.querySelector('#s-code').value`)) === 'KL1.c.CUT')

  // Stored, but the email did not go. The worst possible outcome is a green
  // message here: the row exists, so the desk looks like it worked, and the
  // family is sitting there with nothing.
  await ev(`window.__reply = (b) => b.action === 'setup'
    ? { json: { ok: true, sent: false, goals: 2, row: { token: 't2', status: 'unsent',
        link: 'https://kirtonlearning.com/setup?t=t2', kind: 'setup',
        parent_email: 'parent@example.com', issued_by: 'admin', created_at: '2026-09-21T10:00:00Z' },
        sendError: 'Resend answered 403.' } }
    : { json: { ok: true, rows: [] } }`)
  await setVal('#s-email', 'parent@example.com')
  await setVal('#s-code', 'KL1.c.OK.deadbeef')
  await ev(`document.querySelector('#send-setup').click()`); await sleep(400)
  const warn = await ev(`document.querySelector('#flash').innerHTML`)
  check('⛔⛔ stored-but-not-emailed says the email did NOT go',
    /did NOT go/i.test(warn) && /Resend answered 403/.test(warn), warn.replace(/<[^>]*>/g, '').slice(0, 160))
  check('★★ and hands over the link so he can send it another way',
    /setup\?t=t2/.test(warn))
  check('★ it is not dressed as a success', !/msg--ok/.test(await ev(`document.querySelector('#flash').innerHTML`))
    || /msg--warn/.test(await ev(`document.querySelector('#flash').innerHTML`)))
}

console.log('\n=== the list, and the one status that is alive despite being used ===')
{
  await ev(`window.__reply = (b) => b.action === 'list'
    ? { json: { ok: true, rows: [
        { token: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', parent_email: 'a@example.com',
          child_label: 'Ada', kind: 'setup', status: 'collected', issued_by: 'admin',
          created_at: '2026-09-20T10:00:00Z', sent_at: '2026-09-20T10:01:00Z',
          used_at: '2026-09-20T18:00:00Z', send_count: 1,
          link: 'https://kirtonlearning.com/setup?t=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
        { token: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', parent_email: 'b@example.com',
          child_label: null, kind: 'iep', status: 'used', issued_by: 'stripe',
          created_at: '2026-09-19T10:00:00Z', sent_at: '2026-09-19T10:01:00Z',
          used_at: '2026-09-19T12:00:00Z', send_count: 1,
          link: 'https://kirtonlearning.com/upload.html?t=bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' }] } }
    : { json: { ok: true } }`)
  await ev(`document.querySelector('#refresh').click()`); await sleep(500)
  const table = await ev(`document.querySelector('#list').textContent`)
  check('★ a setup row is labeled as one', /Setup/.test(table), table.slice(0, 200))
  check('★★ collected is shown as its own status, not as used', /collected/.test(table))

  // ★★ The whole point of `collected`: the link still works, because she may
  // set up a second device. A row that hid the link would say the opposite.
  const cells = await ev(`JSON.stringify([...document.querySelectorAll('tbody tr')].map(tr => ({
    status: tr.querySelector('.pill').textContent,
    hasLink: !!tr.querySelector('[data-copy]'),
    acts: [...tr.querySelectorAll('[data-act]')].map(b => b.dataset.act) })))`)
  const rows = JSON.parse(cells)
  const collected = rows.find((r) => r.status === 'collected')
  const used = rows.find((r) => r.status === 'used')
  check('★★★ a collected setup still shows its link — she may need a second device',
    collected?.hasLink === true, JSON.stringify(collected))
  check('★★ and can still be resent and revoked',
    collected?.acts.includes('resend') && collected?.acts.includes('revoke'), JSON.stringify(collected?.acts))
  check('★ while a used IEP link is spent, and shows neither', used?.hasLink === false
    && !used?.acts.includes('resend'), JSON.stringify(used))
  check('★ every row can still be deleted, which is how "delete my child\'s document" is kept',
    rows.every((r) => r.acts.includes('delete')))
}

check('no script errors on any of it', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n  ${pass} passed, ${fail} failed\n`)
ws.close(); chrome.kill(); server.close()
process.exitCode = fail ? 1 : 0
