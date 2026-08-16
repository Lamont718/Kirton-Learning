// Walks every page on the live site and checks the things that quietly rot:
// dead internal links, missing assets, wrong canonicals, leaked internal docs,
// placeholders that were meant to be replaced, and mailto addresses that bounce.
//
// It reads the deployed site, not the working tree, because the working tree has
// never been what a parent sees.
import { promises as dns } from 'node:dns'

const SITE = process.env.SITE || 'https://kirtonlearning.com'
const PAGES = [
  '/', '/demo.html', '/privacy.html', '/terms.html',
  '/partner.html', '/refer.html', '/referrals.html', '/upload.html', '/record/',
]

let pass = 0, fail = 0, warn = 0
const ok = (n) => { pass++; console.log('  ok    ' + n) }
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')) }
const note = (n, d = '') => { warn++; console.log('  warn  ' + n + (d ? '\n        ' + d : '')) }

const body = new Map()
const status = new Map()

async function head (url) {
  if (status.has(url)) return status.get(url)
  let s = 0
  try { s = (await fetch(url, { redirect: 'follow' })).status } catch { s = 0 }
  status.set(url, s)
  return s
}

console.log('\n=== every page is reachable ===')
for (const p of PAGES) {
  const url = SITE + p
  let r
  try { r = await fetch(url) } catch (e) { bad(p + ' did not respond', String(e)); continue }
  const html = await r.text()
  body.set(p, html)
  r.status === 200 ? ok(`${p} → 200`) : bad(`${p} → ${r.status}`)
}

console.log('\n=== internal links and assets resolve ===')
const seen = new Set()
for (const [p, html] of body) {
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)].map(m => m[1])
  for (const ref of new Set(refs)) {
    const key = ref
    if (seen.has(key)) continue
    seen.add(key)
    const s = await head(SITE + ref)
    s === 200 ? ok(`${ref} → 200`) : bad(`${ref} → ${s}`, `linked from ${p}`)
  }
}

console.log('\n=== in-page anchors exist ===')
for (const [p, html] of body) {
  const anchors = [...html.matchAll(/href="(?:\/)?#([A-Za-z][\w-]*)"/g)].map(m => m[1])
  for (const a of new Set(anchors)) {
    // Anchors written as /#foo point at the homepage, not the current page.
    const target = html.match(/href="\/#/) && !html.includes(`id="${a}"`) ? body.get('/') : html
    ;(target && target.includes(`id="${a}"`))
      ? ok(`#${a} exists for ${p}`)
      : bad(`#${a} has no target`, `linked from ${p}`)
  }
}

console.log('\n=== canonicals point at this domain ===')
for (const [p, html] of body) {
  const m = html.match(/<link rel="canonical" href="([^"]+)"/)
  if (!m) { note(`${p} has no canonical`); continue }
  m[1].startsWith(SITE) ? ok(`${p} canonical → ${m[1]}`) : bad(`${p} canonical → ${m[1]}`)
}

console.log('\n=== no page still names the old brand or domain ===')
for (const [p, html] of body) {
  const stale = ['sparkbuilders.org', 'iep-record.vercel.app', 'spark-coach-families.vercel.app']
    .filter(s => html.includes(s))
  stale.length ? bad(`${p} still names ${stale.join(', ')}`) : ok(`${p} is clean`)
}

console.log('\n=== internal working docs are not served ===')
for (const f of ['/CLAUDE.md', '/CONTEXT.md', '/VOICE.md', '/SCOPE.md', '/supabase-setup.sql']) {
  const s = await head(SITE + f)
  s === 404 ? ok(`${f} → 404`) : bad(`${f} → ${s}, it is being served`)
}

console.log('\n=== placeholders that block taking money ===')
for (const [p, html] of body) {
  const holes = []
  if (/REPLACE_[A-Z_]+/.test(html)) holes.push('Stripe payment link')
  if (/REPLACE@/.test(html)) holes.push('contact address')
  holes.length ? bad(`${p} still has a placeholder: ${holes.join(', ')}`) : ok(`${p} has no placeholders`)
}

console.log('\n=== the contact address can actually receive mail ===')
const addrs = new Set()
for (const html of body.values())
  for (const m of html.matchAll(/mailto:([^"?]+)/g)) addrs.add(m[1])
for (const a of addrs) {
  const domain = a.split('@')[1]
  let mx = []
  try { mx = await dns.resolveMx(domain) } catch {}
  mx.length ? ok(`${a} → ${mx.length} MX record(s)`)
            : bad(`${a} has NO MX record — every one of these links bounces`)
}
console.log(`  (${addrs.size} distinct address(es) across the site)`)

console.log('\n=== robots and sitemap agree with the pages ===')
const sitemap = await (await fetch(SITE + '/sitemap.xml')).text()
for (const [p, html] of body) {
  const noindex = /name="robots" content="noindex/.test(html)
  const listed = sitemap.includes(SITE + (p === '/' ? '/' : p))
  if (noindex && listed) bad(`${p} is noindex but IS in the sitemap`)
  else if (!noindex && !listed) note(`${p} is indexable but not in the sitemap`)
  else ok(`${p} — ${noindex ? 'noindex, not listed' : 'indexable and listed'}`)
}

console.log('\n=== the free tool still promises what it claims ===')
const rec = body.get('/record/') || ''
;/noindex/.test(rec) ? ok('/record/ is noindex (it is a tool, not a landing page)') : note('/record/ is indexable')
rec.includes('/#start') ? ok('/record/ leads somewhere — links to the paid work') : bad('/record/ is a dead end again')
;(await head(SITE + '/record/sw.js')) === 200 ? ok('service worker is served') : bad('service worker is missing — "works offline" is false')
;(await head(SITE + '/record/manifest.webmanifest')) === 200 ? ok('manifest is served') : bad('manifest is missing')

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings\n`)
process.exit(fail ? 1 : 0)
