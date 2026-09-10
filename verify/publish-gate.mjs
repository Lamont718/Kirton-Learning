// The handbook is on the main site now. What still protects a parent from its
// unverified facts?
//
//   node verify/publish-gate.mjs
//
// Until 2026-09-10 the guard was "keep it out of the deploy" — resource-platform/
// sat in .vercelignore and the whole question was whether that line survived.
// The handbook has now been merged onto kirtonlearning.com, so that guard is gone
// and this file had to be rebuilt around what actually matters:
//
//   Every one of the 22 facts is still `unverified` and all 9 translations are
//   `draft`. These are NYC special-education deadlines, phone numbers and office
//   names. A parent reads them and ACTS — asks for an evaluation, disagrees with
//   a placement, carries a letter into a meeting. A wrong date is not a typo.
//
// ⛔ So while anything is unverified, three things must hold, and each of them is
// one careless edit away from not holding:
//
//   1. every handbook page carries noindex        — search must not send anyone
//   2. every question page carries its draft mark — the reader must be told
//   3. nothing indexable links to it, and it is   — the site must not invite
//      not in sitemap.xml                            anyone in
//
// Being merged is not the same as being published. This is the difference.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { globSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let fail = 0;
const ok = (n, d = '') => console.log('  ok    ' + n + (d ? '  — ' + d : ''));
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

console.log('\nPublish gate — the handbook is merged; is it still safely unpublished?\n');

// ---------------------------------------------------------------------------
// 1. What is still unverified?
// ---------------------------------------------------------------------------
const facts = JSON.parse(read('docs/facts.json'));
const unverified = [];
const drafts = [];
(function walk(node, path) {
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    if (typeof node.status === 'string') {
      if (node.status === 'unverified') unverified.push(path);
      else if (node.status === 'draft') drafts.push(path);
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  }
})(facts, '');

const clean = unverified.length === 0 && drafts.length === 0;
console.log(`  ${unverified.length} unverified fact(s), ${drafts.length} draft translation(s)\n`);

// ---------------------------------------------------------------------------
// Which files are the handbook?
// ---------------------------------------------------------------------------
const handbookPages = ['handbook.html', ...globSync('start/*.html', { cwd: ROOT }), ...globSync('source/*.html', { cwd: ROOT })];

if (!existsSync(join(ROOT, 'handbook.html'))) {
  bad('handbook.html is missing', 'the merge moved resource-platform/index.html here');
}

// ---------------------------------------------------------------------------
// 2. noindex on every page
// ---------------------------------------------------------------------------
if (clean) {
  ok('every fact is verified', 'the noindex tags may now come off — see CLAUDE.md');
} else {
  const exposed = handbookPages.filter((p) => !/name="robots"\s+content="noindex/.test(read(p)));
  exposed.length
    ? bad(`${exposed.length} handbook page(s) would be INDEXED while facts are unverified`,
        exposed.slice(0, 6).join(', ') + (exposed.length > 6 ? ` … +${exposed.length - 6}` : ''))
    : ok(`all ${handbookPages.length} handbook pages are noindex`, 'search will not send anyone here');
}

// ---------------------------------------------------------------------------
// 3. the draft mark on the question pages
// ---------------------------------------------------------------------------
const questions = globSync('start/*.html', { cwd: ROOT }).filter((p) => basename(p) !== 'index.html');
if (!clean) {
  const unmarked = questions.filter((p) => !/class="draft/.test(read(p)));
  unmarked.length
    ? bad(`${unmarked.length} question page(s) carry no draft mark`, unmarked.slice(0, 6).join(', '))
    : ok(`all ${questions.length} question pages carry their draft mark`, 'the reader is told');
}

// ---------------------------------------------------------------------------
// 4. nothing invites anyone in
// ---------------------------------------------------------------------------
// ⚠️ THIS RULE CHANGED ON 2026-09-10, ON LAMONT'S CALL.
// It used to be "no indexable page may link to the handbook while facts are
// unverified" — the guard was to keep people away from it. He asked twice for the
// handbook to appear on the site, which is his decision to make, so the homepage
// now carries a section for it.
//
// The guard did not disappear, it MOVED. A link is fine; a link that presents
// unchecked deadlines as finished work is not. So what is asserted now is that
// the invitation carries its own caveat — if somebody tidies that paragraph away
// while the facts are still unverified, the homepage starts making a promise
// nobody has earned, and this fails.
if (!clean) {
  const home = read('index.html');
  if (/href="\/(handbook|start\/|source\/)/.test(home)) {
    /still being checked|being verified against/i.test(home)
      ? ok('the homepage links the handbook AND says it is still being checked')
      : bad('the homepage links the handbook with no caveat',
          'All 22 facts are unverified. The section must keep the sentence saying so — a parent ' +
          'following that link is about to act on a deadline.');
  } else {
    ok('the homepage does not link the handbook');
  }

  // Indexing is a separate decision from linking, and still not taken. A link is
  // an offer to people already here; indexing puts unverified deadlines in front
  // of strangers searching for exactly this.
  const sitemap = read('sitemap.xml');
  /\/(handbook|start|source)/.test(sitemap)
    ? bad('sitemap.xml lists handbook URLs while facts are unverified')
    : ok('sitemap.xml does not list the handbook', 'linked, not indexed');
}

// ---------------------------------------------------------------------------
// 5. the facts file is actually served
// ---------------------------------------------------------------------------
// facts.js fetches /docs/facts.json at runtime and rewrites each page's numbers.
// If that file is not deployed the fetch 404s and every page silently keeps the
// value hardcoded in its HTML — which is the 09-09 dead-loader failure exactly:
// it looks right because the fallback matches, until the day a number changes.
const vercelignore = read('.vercelignore').split('\n').map((l) => l.trim());
vercelignore.includes('docs/') || vercelignore.includes('docs/facts.json')
  ? bad('docs/facts.json is not deployed', 'facts.js will 404 and every page will silently keep its hardcoded number')
  : ok('docs/facts.json is served', 'facts.js can do its job');

['docs/RESOURCE.md', 'docs/platform-design.html'].forEach((p) => {
  vercelignore.includes(p)
    ? ok(`${p} stays private`)
    : bad(`${p} would be served`, 'internal working document');
});

// ---------------------------------------------------------------------------
// 6. the route that used to collide
// ---------------------------------------------------------------------------
existsSync(join(ROOT, 'start.html'))
  ? bad('start.html is back on the main site',
      'The handbook owns /start/. The post-payment page is welcome.html. Two meanings for ' +
      '/start on one site sends unpaid parents into the post-payment flow.')
  : ok('/start/ belongs to the handbook', 'the post-payment page is /welcome');

console.log(fail ? `\n  ${fail} failure(s)\n` : '\n  gate is satisfied\n');
process.exitCode = fail ? 1 : 0;
