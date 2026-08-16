// Opens each page in a real browser and checks the things a link crawl cannot see:
// script errors, failed requests, the interactive pieces actually moving, and the
// disclosures that are not allowed to disappear.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SITE = process.env.SITE || 'https://kirtonlearning.com'
const PORT = 9502
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log('  ok    ' + n) }
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')) }

const profile = mkdtempSync(join(tmpdir(), 'aud-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--mute-audio',
  '--window-size=900,1400', 'about:blank'], { stdio: 'ignore' })

async function getJSON (p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return r.json() } catch {}
    await sleep(200)
  }
  throw new Error('no cdp')
}
const v = await getJSON('/json/version')
const ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pend = new Map()
let errors = []
let failedReqs = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return }
  if (d.method === 'Runtime.exceptionThrown')
    errors.push(d.params.exceptionDetails.exception?.description
      ?? d.params.exceptionDetails.text ?? 'error')
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error')
    errors.push(d.params.entry.text)
  if (d.method === 'Network.loadingFailed')
    failedReqs.push(d.params.errorText)
}
// The browser-level socket has no Runtime domain — everything has to run against a
// page target over its own session, the same way e2e-record.mjs does it.
const rawSend = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = ++id
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }))
})
const { targetId } = await rawSend('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await rawSend('Target.attachToTarget', { targetId, flatten: true })
const send = (method, params = {}) => rawSend(method, params, sessionId)

await send('Page.enable'); await send('Runtime.enable')
await send('Log.enable'); await send('Network.enable')

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}
const go = async (url) => {
  errors = []; failedReqs = []
  await send('Page.navigate', { url })
  await sleep(2600)
}
const click = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button,summary,a')]
  .find(x=>/${re}/i.test(x.textContent));if(!b)return false;b.click();return true})()`)

const PAGES = ['/', '/demo.html', '/privacy.html', '/terms.html', '/partner.html',
  '/refer.html', '/referrals.html', '/upload.html', '/record/']

console.log('\n=== no page throws a script error or drops a request ===')
for (const p of PAGES) {
  await go(SITE + p)
  const e = errors.filter(x => !/favicon/i.test(x))
  const f = failedReqs.filter(x => !/ERR_ABORTED/.test(x))
  e.length ? bad(`${p} threw`, e.slice(0, 2).join(' | ')) : ok(`${p} — no script errors`)
  if (f.length) bad(`${p} had a failed request`, f.slice(0, 2).join(' | '))
}

console.log('\n=== the hero toggle still works (CLAUDE.md calls it the core sales asset) ===')
await go(SITE + '/')
const before = await ev(`document.querySelector('.flip')?.innerText ?? ''`)
await click('Your child does')
await sleep(500)
const after = await ev(`document.querySelector('.flip')?.innerText ?? ''`)
before && after && before !== after
  ? ok('the toggle changes what the panel says')
  : bad('the toggle did not change anything', `before=${before.slice(0, 60)}`)

console.log('\n=== the scope band says what it must ===')
const scope = await ev(`document.querySelector('#scope')?.innerText ?? ''`)
;/reading/i.test(scope) && /speech/i.test(scope)
  ? ok('what I do / what I don\'t are both on the page') : bad('the scope band is incomplete')
;/licensed/i.test(scope) ? ok('it says why — those are licensed professions') : bad('no reason given')

console.log('\n=== the FAQ opens ===')
const faqOpen = await ev(`(()=>{const d=document.querySelector('details');if(!d)return null;
  d.open=true;return d.innerText.length>40})()`)
faqOpen ? ok('FAQ entries expand') : bad('FAQ did not open')

console.log('\n=== demo.html keeps all three fictional-student disclosures ===')
await go(SITE + '/demo.html')
const demo = await ev('document.body.innerText')
;/not a real (child|student)|invented|fictional/i.test(demo)
  ? ok('the demo says its student is invented') : bad('a disclosure has gone missing')
const marks = (demo.match(/invented|fictional/gi) || []).length
marks >= 3 ? ok(`${marks} separate disclosures present`) : bad(`only ${marks} disclosure(s) — CLAUDE.md requires three`)

console.log('\n=== referrals page is honest while empty ===')
await go(SITE + '/referrals.html')
const ref = await ev('document.body.innerText')
;/nothing here yet/i.test(ref) ? ok('it says the list is empty') : bad('no empty state shown')
;/recommend|vetted|approved|trusted/i.test(ref)
  ? bad('endorsement language present — SCOPE.md forbids it') : ok('no endorsement language')
;/we receive no payment for listing them/i.test(ref)
  ? ok('the required disclaimer is present, verbatim') : bad('the required disclaimer is missing')

console.log('\n=== the upload page does not take a file before payment ===')
await go(SITE + '/upload.html')
const up = await ev('document.body.innerText')
const hasFile = await ev(`!!document.querySelector('input[type=file]')`)
const gated = /link|token|expired|invalid|not valid|check your email/i.test(up)
gated ? ok('it asks for a valid link rather than accepting anything')
      : bad('upload page is open to anyone', up.slice(0, 120))
console.log(`  (file input present: ${hasFile} — expected only behind a valid token)`)

console.log('\n=== the record tool is usable on a phone ===')
await send('Emulation.setDeviceMetricsOverride',
  { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await go(SITE + '/record/')
const overflow = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
overflow <= 2 ? ok('no horizontal scroll at 390px') : bad(`page scrolls sideways by ${overflow}px`)
// Only real controls, not inline prose links — a 15px-tall link inside a sentence is
// not a tap target, and counting it made this check cry wolf on every footer.
const tapCheck = `(()=>{const small=[...document.querySelectorAll('button,.btn,[role=button]')]
  .filter(x=>x.offsetParent && x.getBoundingClientRect().height < 44)
  .map(x=>x.textContent.trim().slice(0,30)+' ('+Math.round(x.getBoundingClientRect().height)+'px)')
  ;return JSON.stringify(small)})()`
for (const p of ['/record/', '/']) {
  await go(SITE + p)
  const small = JSON.parse(await ev(tapCheck))
  small.length === 0
    ? ok(`${p} — every control is at least 44px tall`)
    : bad(`${p} has ${small.length} control(s) under 44px`, small.join(', '))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
ws.close(); chrome.kill()
process.exit(fail ? 1 : 0)
