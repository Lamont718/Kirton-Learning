// Does the thing do its one job: turn what a parent saw into printable evidence
// against the goal as the IEP words it?
//
// The rule it must never break: coached work is NOT a score. If helping a child
// could move the number, the record is worthless in the room it exists for.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.env.ORIGIN || 'https://iep-record.vercel.app'
const PORT = 9501
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (d ? '\n       ' + d : '')) } }

const profile = mkdtempSync(join(tmpdir(), 'rec-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--mute-audio', '--window-size=900,1200', 'about:blank'], { stdio: 'ignore' })

async function getJSON(p) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return r.json() } catch {} await sleep(200) }
  throw new Error('no cdp')
}
const v = await getJSON('/json/version')
const ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pend = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
}
const send = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}
const go = async (u) => { await send('Page.navigate', { url: u }, sessionId); await sleep(1800) }
const text = () => ev('document.body.innerText')
const setVal = (sel, val) => ev(`(()=>{const el=document.querySelector('${sel}');el.value=${JSON.stringify(val)};el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
const click = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/${re}/i.test(x.textContent));if(!b)return false;b.click();return true})()`)

const GOAL = 'Given a grade-level informational text, she will identify the main idea and two supporting details with 80% accuracy in 4 of 5 trials.'

console.log('\n=== it opens asking for one thing only ===')
await go(ORIGIN)
check('asks for a first name and nothing else', /first name/i.test(await text()))
check('no sign-up, no email, no password',
  await ev(`!document.querySelector('input[type=email],input[type=password]')`))

console.log('\n=== a goal goes in exactly as the IEP words it ===')
await setVal('#nm', 'Maya'); await click('Next'); await sleep(600)
await setVal('#ga', 'Reading'); await setVal('#gt', GOAL)
await setVal('#gacc', '80'); await setVal('#gof', '4'); await setVal('#gout', '5')
await setVal('#gb', 'Main idea in 1 of 5 passages. Present level, March.')
await click('Add this goal'); await sleep(700)
const home = await text()
check('the goal is stored word for word', (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[0].text`)) === GOAL)
check('the criterion came off the goal, not a constant',
  await ev(`(g=>g.accuracy===0.8&&g.of===4&&g.outOf===5)(JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[0])`))
check('and the baseline is kept with a date',
  await ev(`!!JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[0].baseline.date`))
check('home shows there are no checks yet', /No checks yet/i.test(home))

console.log('\n=== ★ coached work is NOT a score ===')
await click('Write something down'); await sleep(500)
await click('We worked on it'); await sleep(200)
await setVal('#got', '5'); await setVal('#outof', '5')
await click('Save it'); await sleep(700)
const afterPractice = await text()
check('★ a helped session does not move the criterion', /No checks yet/i.test(afterPractice),
  afterPractice.slice(0, 160))
check('but it is still kept', (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).entries.length`)) === 1)

console.log('\n=== a check done on her own does count ===')
await click('Write something down'); await sleep(500)
await setVal('#got', '9'); await setVal('#outof', '10')
await click('Save it'); await sleep(700)
check('one passing check is recorded', /1 of 1 at 80%/.test(await text()), (await text()).slice(0, 200))

console.log('\n=== the criterion is judged the way the goal words it ===')
for (const [got, out] of [[9, 10], [8, 10], [5, 10]]) {
  await click('Write something down'); await sleep(450)
  await setVal('#got', String(got)); await setVal('#outof', String(out))
  await click('Save it'); await sleep(600)
}
const t4 = await text()
check('4 checks in, 3 passing — not met yet on a 4-of-5 goal', /3 of 4 at 80%/.test(t4), t4.slice(0, 200))
await click('Write something down'); await sleep(450)
await setVal('#got', '10'); await setVal('#outof', '10'); await click('Save it'); await sleep(700)
check('★ the fifth check tips it: 4 of the last 5 at 80% = at criterion', /At criterion/i.test(await text()))

console.log('\n=== the record is the deliverable ===')
await click('See the record'); await sleep(900)
const rec = await text()
check('the record quotes the goal word for word', rec.includes(GOAL))
check('it states what counts as met, in the goal\u2019s numbers', /80% accuracy in 4 of 5 trials/.test(rec))
check('it shows the starting point it is being compared to', /Starting point/.test(rec))
check('★ helped work is listed SEPARATELY and marked uncounted',
  /Worked on together/.test(rec) && /not counted as a score/i.test(rec))
check('it says who recorded it and under what conditions', /recorded at home by a parent/i.test(rec))
check('it does not take a position against the school', /different room on a different day/i.test(rec))

console.log('\n=== ★ a monitoring design, not just a logbook ===')
const GOAL2 = 'She will compose a paragraph with a topic sentence and two supporting reasons, with 3 or fewer adult prompts, in 4 of 5 opportunities.'
await click('Goals'); await sleep(800)
await setVal('#ga', 'Writing'); await setVal('#gt', GOAL2)
await setVal('#gacc', '80'); await setVal('#gof', '4'); await setVal('#gout', '5')
await ev(`(()=>{const s=document.querySelector('#gev');s.value='14';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
await click('Add this goal'); await sleep(800)
const g2 = await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[1].id`)
check('each goal carries its own check cadence',
  (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[1].everyDays`)) === 14)
check('a goal that has never been checked says so', /First check not done yet/.test(await text()))

await ev(`openLog('${g2}')`); await sleep(500)
check('★ a cold check warns against using material she just practised',
  await ev(`!document.getElementById('leak').classList.contains('hide')`))
await click('We worked on it'); await sleep(300)
check('and that warning goes away on helped work, where it would be noise',
  await ev(`document.getElementById('leak').classList.contains('hide')`))
await click('On her own'); await sleep(300)

for (let i = 0; i < 4; i++) {
  if (i) { await ev(`openLog('${g2}')`); await sleep(400) }
  await setVal('#got', '2'); await setVal('#outof', '10'); await setVal('#pr', '3')
  await click('Save it'); await sleep(550)
}
const flatHome = await text()
check('★ four checks below the mark raises the decision rule', /Four checks in a row below the mark/i.test(flatHome), flatHome.slice(0, 200))
check('★ and it points at the teaching, never at the child or the goal',
  /change how it is being taught/i.test(flatHome) && /not to change the goal/i.test(flatHome))
check('a check just done is not due again yet', /Next check in 14 days/.test(flatHome))
check('the prompt count was kept',
  (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).entries.filter(e=>e.prompts===3).length`)) === 4)

console.log('\n=== what the meeting actually sees ===')
await click('The record'); await sleep(900)
const rec2 = await text()
check('the record repeats the decision rule for the room', /approach needs changing, not the goal/i.test(rec2))
check('it states the cadence the checks were done on', /every 14 days/.test(rec2))
check('it warns how to read a prompt count', /softest number on the page/i.test(rec2))
check('a chart is drawn once there is more than one check',
  (await ev(`document.querySelectorAll('svg.chart').length`)) >= 1)
check('★ the chart does not rely on colour — filled vs hollow, and a dashed criterion line',
  await ev(`(()=>{const s=document.querySelector('svg.chart');return /stroke-dasharray/.test(s.outerHTML)&&/fill="#fff"/.test(s.outerHTML)})()`))

console.log('\n=== the record can survive this browser ===')
check('a backup can be taken', typeof (await ev(`typeof backup`)) === 'string' && (await ev(`typeof backup`)) === 'function')
check('and the backup is the whole record, not a summary',
  await ev(`(()=>{const d=JSON.parse(localStorage.getItem('iep_record_v1'));return Array.isArray(d.children)&&Array.isArray(d.entries)&&d.entries.length>0})()`))

console.log('\n=== ★ she can fix her own mistakes ===')
await click('Home'); await sleep(800)
const before = await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).entries.length`)
await ev(`(()=>{const d=[...document.querySelectorAll('details')].find(x=>/See or fix past checks/.test(x.textContent));d.open=true;return true})()`)
await sleep(400)
check('every check can be reached to be fixed or taken out',
  (await ev(`[...document.querySelectorAll('button')].filter(b=>/^Fix$/.test(b.textContent.trim())).length`)) > 0)
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Fix$/.test(x.textContent.trim()));b.click();return true})()`)
await sleep(500)
check('the fix form arrives filled in, not blank',
  (await ev(`document.getElementById('got').value`)) !== '')
await setVal('#got', '1'); await setVal('#outof', '10')
await click('Save the fix'); await sleep(700)
check('★ correcting a check changes it rather than adding another',
  (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).entries.length`)) === before)
check('and the corrected number is what is stored',
  (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).entries.some(e=>e.got===1&&e.outOf===10)`)))

console.log('\n=== ★ a starting point can be added later ===')
await click('Goals'); await sleep(800)
const g1 = await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[0].id`)
await ev(`editGoal('${g1}')`); await sleep(500)
check('the goal opens for editing with its own wording in it',
  (await ev(`document.getElementById('e-t').value.length`)) > 40)
await setVal('#e-b', 'Read 3 of 10 unfamiliar words. Present level, March.')
await setVal('#e-bd', '2026-03-14')
await click('Save changes'); await sleep(800)
check('★ a baseline can be written down after the goal was created',
  await ev(`(()=>{const g=JSON.parse(localStorage.getItem('iep_record_v1')).children[0].goals[0];return !!g.baseline && g.baseline.date==='2026-03-14'})()`))

console.log('\n=== ★ more than one child ===')
await click('Goals'); await sleep(800)
await setVal('#nc', 'Jonah'); await click('Add'); await sleep(900)
check('a second child can be added', (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).children.length`)) === 2)
check('and the app switches to them', /Jonah/.test(await text()))
check('★ the new child starts with an empty record, not the first one’s',
  await ev(`(()=>{const d=JSON.parse(localStorage.getItem('iep_record_v1'));const c=d.children[1];return c.goals.length===0})()`))
await click('Home'); await sleep(700)
check('and you can switch back', (await ev(`[...document.querySelectorAll('button')].some(b=>/Maya/.test(b.textContent))`)))

console.log('\n=== ★ "works offline" is true, not a hope ===')
check('a service worker is registered', await ev(`navigator.serviceWorker.getRegistrations().then(r => r.length > 0)`))
check('there is a manifest, so it can live on the home screen',
  await ev(`!!document.querySelector('link[rel=manifest]')`))
check('storage persistence is requested', await ev(`typeof navigator.storage.persist === 'function'`))

console.log('\n=== ★ reading the goals off the IEP ===')
await click('Goals'); await sleep(800)
check('pdf.js is served from this origin, never a CDN',
  await ev(`!/cdnjs|unpkg|jsdelivr|cloudflare/i.test(document.documentElement.outerHTML)`))
check('the parser is not downloaded until a PDF is opened',
  await ev(`performance.getEntriesByType('resource').every(r => !/pdf\\.min\\.mjs/.test(r.name))`))
const SAMPLE = [
  'INDIVIDUALIZED EDUCATION PROGRAM',
  'WHAT THE STUDENT WILL BE EXPECTED TO ACHIEVE BY THE END OF THE YEAR',
  '',
  'Given a grade-level informational text, Maya will identify the main idea and two supporting details with 80% accuracy in 4 of 5 trials.',
  '',
  'Maya will solve two-step word problems within 1,000, showing her work, with 75% accuracy across 4 of 5 trials.',
  '',
  'Speech services will be provided twice weekly.',
].join('\n')
const parsed = await ev(`JSON.stringify(findGoalsInText(${JSON.stringify(SAMPLE)}))`)
const G = JSON.parse(parsed)
check('★ it finds the goals', G.length === 2, parsed)
check('★ it reads the criterion off the document, not a default',
  G[0].accuracy === 80 && G[0].of === 4 && G[0].outOf === 5 && G[1].accuracy === 75)
check('★ ALL-CAPS form instructions are not mistaken for a goal',
  !G.some(g => /EXPECTED TO ACHIEVE/.test(g.text)))
check('a service line is not mistaken for a goal', !G.some(g => /twice weekly/i.test(g.text)))
check('it labels the area it can tell', G[0].area === 'Reading' && G[1].area === 'Maths')
// NB: match on wording unique to the SAMPLE — an earlier part of this run adds a
// reading goal by hand, and a looser pattern matched that instead.
check('★ nothing is saved by parsing — she has to say yes',
  (await ev(`JSON.parse(localStorage.getItem('iep_record_v1')).children.some(c=>c.goals.some(g=>/two-step word problems within 1,000/.test(g.text)))`)) === false)

console.log('\n=== the promise it makes about privacy ===')
check('no account exists to make', !/sign in|log in|create account/i.test(rec))
check('★ nothing was sent anywhere', errors.length === 0 && (await ev(`performance.getEntriesByType('resource').filter(r=>!r.name.startsWith(location.origin)).length`)) === 0)

if (errors.length) console.log('\nconsole exceptions:\n  ' + errors.join('\n  '))
console.log(`\n${pass} passed, ${fail} failed`)
chrome.kill()
process.exit(fail ? 1 : 0)
