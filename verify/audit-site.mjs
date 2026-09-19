// Walks every page on the live site and checks the things that quietly rot:
// dead internal links, missing assets, wrong canonicals, leaked internal docs,
// placeholders that were meant to be replaced, and mailto addresses that bounce.
//
// It reads the deployed site, not the working tree, because the working tree has
// never been what a parent sees.
import { promises as dns } from 'node:dns'

const SITE = process.env.SITE || 'https://kirtonlearning.com'
const PAGES = [
  '/', '/demo', '/privacy', '/terms',
  '/partner', '/refer', '/referrals', '/upload.html', '/record/',
  // Where a family lands after paying. noindex and unlinked on purpose.
  '/welcome',
  // The handbook, merged onto this site on 2026-09-10. Reachable, deliberately
  // NOT offered: every page is noindex and every fact in it is still unverified.
  '/handbook', '/start', '/start/how-to-ask-for-an-evaluation', '/source/money',
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
// A canonical only means something on a page a search engine is allowed to
// index. This used to warn on every page without one, which was nine warnings
// about the nine pages that MUST NOT have one — the handbook and its question
// pages, the two handouts, the token page, the post-payment page. Nine warnings
// nobody can act on are how a suite teaches people to skim its output.
//
// ★ So the rule is the pair, not the tag: an indexable page needs a canonical,
// and on a noindex page the only safe canonical is one naming the page itself.
// It also arms the publish path — the day the handbook's noindex comes off,
// which is a documented, planned edit once the facts are verified, this turns
// from silent to demanding a canonical on all 22 pages, with nobody having to
// remember to ask for it.
//
// ★★ The first version of this failed anything noindex that carried a
// canonical, and it immediately called /referrals wrong. /referrals is not
// wrong: it is deliberately empty, noindex until the first verified provider
// lands, and staged with the canonical it will need that day. The hazard is
// narrower than "both tags present" — a noindex page canonicalizing to a
// DIFFERENT url hands the noindex to that other page, which is how a live page
// gets deindexed by a draft. Pointing at itself risks nothing.
//
// ★★★ The decision is a FUNCTION, and it has fixtures, because this whole suite
// reads the deployment. Editing a page on disk to see the rule bite proves
// nothing here — the run that follows fetches prod and reports on prod, looking
// exactly as if the edit had been judged. That mistake has been made in this
// repo before. A verdict computed from a string can be tested from a string.
function canonicalVerdict (pagePath, html, site = SITE) {
  const m = html.match(/<link rel="canonical" href="([^"]+)"/)
  const noindex = /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html)
  const norm = u => u.replace(/\.html$/, '').replace(/\/+$/, '')
  const self = !!m && norm(m[1]) === norm(`${site}${pagePath === '/' ? '' : pagePath}`)
  if (noindex) return { code: !m ? 'noindex-bare' : self ? 'noindex-staged' : 'noindex-elsewhere', href: m && m[1] }
  if (!m) return { code: 'indexable-bare' }
  return { code: m[1].startsWith(site) ? 'ours' : 'foreign', href: m[1] }
}

// The five cases, stated as fixtures. If a later edit collapses the noindex
// branches back together, /referrals goes red for no reason and someone deletes
// the rule instead of reading it — these say which case is which.
const FIX = 'https://example.com'
const CASES = [
  ['/x', `<meta name="robots" content="noindex"><link rel="canonical" href="${FIX}/x">`, 'noindex-staged'],
  ['/x', '<meta name="robots" content="noindex, nofollow">', 'noindex-bare'],
  ['/x', `<meta name="robots" content="noindex"><link rel="canonical" href="${FIX}/other">`, 'noindex-elsewhere'],
  ['/x', `<link rel="canonical" href="${FIX}/x">`, 'ours'],
  ['/x', '<p>no tags at all</p>', 'indexable-bare'],
]
const wrong = CASES.filter(([p, html, want]) => canonicalVerdict(p, html, FIX).code !== want)
wrong.length
  ? bad(`the canonical rule's own fixtures`, wrong.map(([, , w]) => `expected ${w}, got ${canonicalVerdict('/x', CASES.find(c => c[2] === w)[1], FIX).code}`).join('; '))
  : ok(`the canonical rule decides all ${CASES.length} cases correctly — tested from strings, not from a deployment`)

for (const [p, html] of body) {
  const v = canonicalVerdict(p, html)
  if (v.code === 'noindex-bare') { ok(`${p} is noindex, so no canonical — correct`); continue }
  if (v.code === 'noindex-staged') { ok(`${p} is noindex and canonical → itself, staged for the day it publishes`); continue }
  if (v.code === 'noindex-elsewhere') { bad(`${p} is noindex and canonical → ${v.href}`, 'a noindex page pointing at another url hands that page the noindex'); continue }
  if (v.code === 'indexable-bare') { bad(`${p} is indexable and has no canonical`, 'an indexable page names its own url or it competes with itself'); continue }
  v.code === 'ours' ? ok(`${p} canonical → ${v.href}`) : bad(`${p} canonical → ${v.href}`, 'points off this domain')
}

// og:url is the canonical for everything that shares a link — it is the address
// a preview, a like and a forward all attach to. It has to be the same address
// the canonical names, or one page keeps two identities.
//
// ⛔ Four pages disagreed: /demo, /privacy, /terms and /referrals all declared
// og:url ending in ".html" while their canonical had been rewritten to the
// clean url. Leftovers from the 2026-09-10 merge that turned cleanUrls on and
// rewrote every canonical and the sitemap — and stopped there. They still
// resolved, by a 308, which is exactly why nobody noticed for nine days.
// ★ The same shape as the redirect that sent paying families to /start: with
// cleanUrls on, a ".html" address in a page is never the address of the page.
console.log('\n=== og:url and canonical name the same address ===')
for (const [p, html] of body) {
  const can = html.match(/<link rel="canonical" href="([^"]+)"/)
  const og = html.match(/<meta property="og:url" content="([^"]+)"/)
  if (!og) { ok(`${p} has no og:url to disagree`); continue }
  if (!can) { bad(`${p} has an og:url and no canonical`, 'the share knows the address and the page does not'); continue }
  og[1] === can[1]
    ? ok(`${p} — og:url matches the canonical`)
    : bad(`${p} — og:url ${og[1]} but canonical ${can[1]}`, 'one page, two identities; shares land on the one nothing else names')
}

// And the picture has to exist. og:image is a content= attribute, so the link
// sweep above — which reads href= and src= — has never once looked at it. Every
// preview card on this site could have been pointing at a 404 and every check
// would still have been green.
for (const [p, html] of body) {
  const img = html.match(/<meta property="og:image" content="([^"]+)"/)
  if (!img) continue
  const s = await head(img[1])
  s === 200 ? ok(`${p} — its preview image is actually served`) : bad(`${p} — og:image → ${s}`, `${img[1]} is what a forwarded link tries to draw`)
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

console.log('\n=== the contact address has somewhere to deliver to ===')
//
// ⛔⛔ THIS CHECK USED TO CLAIM THE ADDRESS "CAN ACTUALLY RECEIVE MAIL" AND IT
// WAS ABOUT TO START LYING. Before 2026-09-10 the domain had no MX at all, so it
// failed for the right reason and looked like a working check. The moment MX
// records were added it flipped to a green tick — while the address still
// rejected every message, because MX records with nothing behind them (no
// mailbox, no forwarder alias) are a delivery target that refuses delivery.
//
// ★★★★ An MX lookup proves a destination is NAMED, not that anything is HOME.
// The distinction is invisible from out here and there is no DNS query that
// closes it: the only proof is a real message arriving. So the presence of MX
// is a floor, not a pass, and this says so rather than banking a tick it has
// not earned.
const addrs = new Set()
for (const html of body.values())
  for (const m of html.matchAll(/mailto:([^"?]+)/g)) addrs.add(m[1])
for (const a of addrs) {
  const domain = a.split('@')[1]
  let mx = []
  try { mx = await dns.resolveMx(domain) } catch {}
  if (!mx.length) {
    bad(`${a} has NO MX record — every one of these links bounces`)
  } else {
    note(`${a} → ${mx.map((r) => r.exchange).join(', ')}`,
      'MX records exist, which is NOT the same as mail arriving. Nothing here can tell the ' +
      'difference between a working mailbox and a host that refuses every message. Send one ' +
      'to this address and confirm it lands before treating it as working.')
  }
}
console.log(`  (${addrs.size} distinct address(es) across the site)`)

console.log('\n=== robots and sitemap agree with the pages ===')
const sitemap = await (await fetch(SITE + '/sitemap.xml')).text()
for (const [p, html] of body) {
  const noindex = /name="robots" content="noindex/.test(html)
  // The page is FETCHED as /record/ (a directory with an index.html) but the
  // site is trailingSlash:false, so its canonical and its sitemap entry are
  // both /record. Comparing the raw strings said "indexable but not in the
  // sitemap" about a url that was sitting in the sitemap — so compare the two
  // the way the site itself resolves them.
  const trim = u => u.replace(/\/+$/, '') || '/'
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => trim(m[1]))
  const listed = locs.includes(trim(SITE + p))
  if (noindex && listed) bad(`${p} is noindex but IS in the sitemap`)
  else if (!noindex && !listed) note(`${p} is indexable but not in the sitemap`)
  else ok(`${p} — ${noindex ? 'noindex, not listed' : 'indexable and listed'}`)
}

console.log('\n=== the free tool still promises what it claims ===')
const rec = body.get('/record/') || ''
// Reversed 2026-09-19, on Lamont's call. This used to pass BECAUSE the tool was
// noindex — "it is a tool, not a landing page". The tool is the one thing here a
// parent can be handed with nothing asked of them, and it was the only public
// page search could never return. It is the page most worth finding, so a
// noindex on it is now a failure, not a virtue. It needs the tags that make a
// forwarded link and a search result work: a canonical and a preview card.
// ⛔ Read the TAG, not the page. This was `/noindex/.test(rec)` for one commit,
// and it failed immediately — on the comment above the tag, which explains why
// the page used to be noindex. Third time in a day that a check was satisfied
// or tripped by a file TALKING ABOUT the thing instead of doing it.
;/name="robots"[^>]*content="[^"]*noindex/i.test(rec)
  ? bad('/record/ is noindex again', 'the free tool is meant to be findable and forwardable; that was decided, not assumed')
  : ok('/record/ is indexable — the free tool can be found')
;/rel="canonical"/.test(rec) ? ok('/record/ names its own url') : bad('/record/ is indexable with no canonical')
;/og:image/.test(rec) && /og:title/.test(rec)
  ? ok('/record/ has a preview card', 'it is forwarded in a text message more often than it is searched for')
  : bad('/record/ has no preview card', 'a link with no title or image is a link nobody taps')
// ⛔ This read `rec.includes('/#start')` and reported "links to the paid work".
// The check is named "a dead end AGAIN" — it was written after the tool WAS a
// dead end once, and then it was satisfied by the string appearing anywhere in
// the file. Both occurrences of it are inside a <script>, in a template that
// renders on a later screen. On the first screen a visitor lands on there is
// exactly one link — the brand mark — and none to the paid work.
// ★★★ Same disease as a flag that is set and never read: a guard that greps for
// a STRING passes on the file mentioning the thing, not on the thing happening.
// It was invisible while /record was only reachable from the homepage. It is
// worth knowing now the page is indexed and people will arrive on it cold.
//
// Not raised to a failure on purpose: whether the free tool carries a link to
// the paid work on screen one is a decision about how hard this sells, and the
// band on index.html was worded carefully so the free tool is not bait. That is
// Lamont's call, so this states what is true and does not make it for him.
// ★★ And the first version of THIS fix was fooled too: it looked for the
// anchor markup instead of the bare string, and the template inside the script
// contains the whole `<a href="/#start">` tag as text. Strip the scripts first,
// then ask. Checked against the live DOM at 390px to be sure the answer is the
// same one a phone gives: one link on the first screen, the brand mark.
const recMarkup = rec.replace(/<script[\s\S]*?<\/script>/gi, ' ')
const startAnchor = /<a [^>]*href="[^"]*#start/i.test(recMarkup)
if (!rec.includes('/#start')) bad('/record/ is a dead end again', 'nothing in it points at the paid work at all')
else if (startAnchor) ok('/record/ leads somewhere — a real link to the paid work')
else note('/record/ mentions the paid work only inside a script',
  'the template renders on a later screen; the first screen a search visitor lands on has no link to it')
;(await head(SITE + '/record/sw.js')) === 200 ? ok('service worker is served') : bad('service worker is missing — "works offline" is false')
;(await head(SITE + '/record/manifest.webmanifest')) === 200 ? ok('manifest is served') : bad('manifest is missing')

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings\n`)
process.exit(fail ? 1 : 0)
