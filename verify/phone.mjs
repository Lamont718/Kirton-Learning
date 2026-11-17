// Opens every public page as a PHONE (390px, touch, mobile viewport) and checks
// what a parent on a phone actually hits: content wider than the screen (the
// page slides sideways), tap targets too small to hit, and text too small to read.
// Most of this site's families will only ever see it on a phone.
//   node verify/phone.mjs            → prod
//   SITE=http://localhost:3000 node verify/phone.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SITE = process.env.SITE || 'https://kirtonlearning.com'
const PORT = 9507
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const PAGES = ['/', '/demo', '/ask', '/partner', '/refer', '/privacy', '/terms',
  '/record/', '/clear-path', '/handbook', '/welcome', '/upload', '/intake', '/setup', '/404']

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'phone-'))}`, '--no-first-run',
  '--disable-gpu', '--mute-audio', 'about:blank'], { stdio: 'ignore' })
let v
for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(200) } }
const ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pend = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } }
const raw = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }))
})
const { targetId } = await raw('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true })
const send = (m, p) => raw(m, p, sessionId)
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true })

const PROBE = `(() => {
  const W = document.documentElement.clientWidth, out = { sw: document.documentElement.scrollWidth, W, wide: [], tap: [], tiny: [] }
  const seen = new Set()
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue
    // an element inside a deliberately scrollable box (a table wrapper) is fine
    let p = e.parentElement, scroller = false
    while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break } p = p.parentElement }
    if (!scroller && r.right > W + 1 && !seen.has(e.parentElement)) { seen.add(e); out.wide.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ' → ' + Math.round(r.right) + 'px "' + (e.textContent || '').trim().slice(0, 40) + '"') }
  }
  for (const e of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab]')) {
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue
    // links inside a sentence are exempt (WCAG 2.5.8 inline exception)
    if (e.tagName === 'A' && cs.display === 'inline' && e.parentElement && /^(P|LI|TD|SPAN|EM|STRONG|SMALL|DD|FIGCAPTION|LABEL|B|DIV)$/.test(e.parentElement.tagName) && e.parentElement.textContent.trim().length > e.textContent.trim().length + 3) continue
    // a checkbox inside its label is hit by tapping the whole label
    if (e.tagName === 'INPUT' && e.closest('label')) { const lr = e.closest('label').getBoundingClientRect(); if (lr.height >= 24 && lr.width >= 24) continue }
    // a ::after overlay that widens the hit area counts as the target
    const af = getComputedStyle(e, '::after'); const afh = parseFloat(af.height) || 0
    if (af.content !== 'none' && af.position === 'absolute' && afh >= 24) continue
    if (r.height < 24 || r.width < 24) out.tap.push(e.tagName.toLowerCase() + ' "' + (e.textContent || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 30) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height))
  }
  for (const e of document.querySelectorAll('p,li,a,button,label,td,th,span,small,dd,dt,figcaption')) {
    const t = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(); if (t.length < 3) continue
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = e.getBoundingClientRect(); if (!r.width) continue
    const s = parseFloat(cs.fontSize); if (s < 12) out.tiny.push(s + 'px "' + t.slice(0, 40) + '"')
  }
  return out })()`

let fails = 0, warns = 0
for (const p of PAGES) {
  await send('Page.navigate', { url: SITE + p }); await sleep(2500)
  const r = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value
  const lines = []
  if (r.sw > r.W + 1) { fails++; lines.push(`FAIL  page is ${r.sw}px wide on a ${r.W}px screen — it slides sideways`) }
  for (const w of r.wide.slice(0, 6)) lines.push('        wide: ' + w)
  if (r.tap.length) { warns++; lines.push(`warn  ${r.tap.length} tap target(s) under 24px`); for (const t of r.tap.slice(0, 6)) lines.push('        ' + t) }
  if (r.tiny.length) { warns++; lines.push(`warn  ${r.tiny.length} text block(s) under 12px`); for (const t of r.tiny.slice(0, 4)) lines.push('        ' + t) }
  console.log((lines.length ? '' : 'ok    ') + p + (lines.length ? '\n  ' + lines.join('\n  ') : ''))
}
console.log(`\n${PAGES.length} pages, ${fails} failures, ${warns} warnings`)
chrome.kill(); process.exit(fails ? 1 : 0)
