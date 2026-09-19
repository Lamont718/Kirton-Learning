// Checks that the site measures what privacy.html says it measures, and
// nothing else. Runs offline against the files on disk; add --prod to also
// ask the deployment.
//
//     node verify/analytics.mjs
//     node verify/analytics.mjs --prod
//
// Why this file exists. On 2026-09-14 the Vercel project record carried
// `webAnalytics: { id: "jS1Iku..." }` — which reads exactly like the feature
// is on — while https://kirtonlearning.com/_vercel/insights/script.js
// answered 404 and not one page carried a beacon. The site had collected
// nothing since launch, and privacy.html had been telling families for a
// month that it collected "which pages were visited, roughly where in the
// world the visit came from, and what kind of device it was on."
//
// An id in a config object is not a feature that is running. The only proof
// is the deployment answering for the script, which is what --prod asks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = process.argv.includes('--prod');
const ORIGIN = 'https://kirtonlearning.com';

let failures = 0, warnings = 0, checks = 0;
const fail = (what, detail) => { failures++; console.log(`  FAIL  ${what}\n        ${detail}`); };
const warn = (what, detail) => { warnings++; console.log(`  warn  ${what}\n        ${detail}`); };
const pass = (what, detail) => { checks++; console.log(`  ok    ${what}${detail ? `\n        ${detail}` : ''}`); };

const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const read = p => fs.readFileSync(p, 'utf8');

// The four that must never carry a beacon. /upload has a one-time token in
// its query string, /intake is the six questions about a child, /admin is the
// back office, and the design doc is not served at all.
const NEVER = ['upload.html', 'intake.html', 'admin.html', 'docs/platform-design.html'];
const TAG = '/analytics.js';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'verify'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}
const pages = walk(ROOT);

console.log(`\nanalytics — ${pages.length} pages on disk\n`);

// ------------------------------------------------------- the loader itself
console.log('the loader');
const LOADER = path.join(ROOT, 'analytics.js');
if (!fs.existsSync(LOADER)) {
  fail('analytics.js exists', 'nothing measures anything, and privacy.html says otherwise');
} else {
  const src = read(LOADER);
  pass('analytics.js exists');

  if (src.includes('/_vercel/insights/script.js')) pass('it loads Vercel Web Analytics — no cookies, no advertising network');
  else fail('it loads Vercel Web Analytics', 'privacy.html promises privacy-respecting analytics; whatever this loads now is not that until it is checked');

  for (const banned of ['googletagmanager', 'google-analytics', 'gtag(', 'connect.facebook', 'fbq(', 'hotjar', 'clarity.ms']) {
    if (src.toLowerCase().includes(banned.toLowerCase())) {
      fail('no advertising or session-replay vendor', `analytics.js mentions ${banned}; privacy.html says there is no Meta pixel, no Google Ads tag and no advertising network on this site`);
    }
  }
  checks++; console.log('  ok    no advertising or session-replay vendor in the loader');

  // Run the guard for real rather than reading it. A regex that looks right
  // and matches nothing is the whole reason this section exists.
  const guard = (pathname, search) => {
    const calls = [];
    const sandbox = {
      location: { pathname, search },
      document: { createElement: () => ({}), head: { appendChild: (n) => calls.push(n) } },
    };
    new Function('location', 'document', src)(sandbox.location, sandbox.document);
    return calls.length > 0;
  };

  const mustNotLoad = [
    ['/upload', '?t=abc123'],
    ['/upload', ''],
    ['/upload.html', '?t=abc123'],
    ['/admin', ''],
    ['/admin.html', ''],
    ['/UPLOAD', '?T=abc123'],
    ['/upload/', '?t=abc123'],
    ['/welcome', '?session_id=cs_live_123'],
    ['/', '?token=abc123'],
  ];
  const mustLoad = [['/', ''], ['/demo', ''], ['/handbook', ''], ['/welcome', ''], ['/start/', ''], ['/record/', '']];

  let guardOk = true;
  for (const [p, s] of mustNotLoad) {
    if (guard(p, s)) { fail('the guard refuses the intake and the back office', `${p}${s} loaded a beacon and must not`); guardOk = false; }
  }
  if (guardOk) pass('the guard refuses the intake and the back office', `${mustNotLoad.length} paths proven, including a token on a page where one was never expected`);

  let loadOk = true;
  for (const [p, s] of mustLoad) {
    if (!guard(p, s)) { fail('the guard allows the public pages', `${p}${s} loaded nothing, so this page is not measured`); loadOk = false; }
  }
  // A guard that blocks everything passes the check above and measures
  // nothing. Both directions or neither.
  if (loadOk) pass('the guard allows the public pages', `${mustLoad.length} paths proven — a guard that blocked everything would pass the check above`);
}

// -------------------------------------------------------------- the pages
console.log('\nthe pages');
const missing = [], wrongly = [];
for (const p of pages) {
  const r = rel(p);
  const has = read(p).includes(TAG);
  if (NEVER.includes(r)) { if (has) wrongly.push(r); }
  else if (!has) missing.push(r);
}
if (missing.length) fail('every public page carries the tag', `${missing.length} without it: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`);
else pass('every public page carries the tag', `${pages.length - NEVER.length} pages`);

if (wrongly.length) fail('the intake and the back office carry no tag', wrongly.join(', '));
else pass('the intake and the back office carry no tag', NEVER.join(', '));

// ------------------------------------------------- the promise it answers
console.log('\nthe promise on privacy.html');
const privacy = read(path.join(ROOT, 'privacy.html'));
// If the analytics ever come out, this paragraph has to come out with them.
// It has already been wrong once in the other direction.
if (/Basic, aggregate website analytics/i.test(privacy)) pass('privacy.html still describes what this collects');
else fail('privacy.html still describes what this collects', 'the paragraph under "Information collected automatically" is gone — either restore it or remove the analytics, but the page and the site must agree');

if (/never sent to any analytics/i.test(privacy)) pass('privacy.html still promises the IEP is never measured', 'the guard in analytics.js is what keeps this sentence');
else fail('privacy.html still promises the IEP is never measured', 'that sentence is the reason the guard exists');

// --------------------------------------------------------------- the deploy
if (PROD) {
  console.log('\nthe deployment');
  const code = async (u) => { try { return (await fetch(u, { redirect: 'manual' })).status; } catch (e) { return 'ERR ' + e.message; } };

  const a = await code(`${ORIGIN}/analytics.js`);
  if (a === 200) pass('/analytics.js is served'); else fail('/analytics.js is served', `answered ${a}`);

  // The check that would have caught this whole thing. Vercel serves this
  // path only when Web Analytics is actually enabled for the project. The
  // project record's `webAnalytics.id` is present either way.
  const v = await code(`${ORIGIN}/_vercel/insights/script.js`);
  if (v === 200) {
    pass('Vercel Web Analytics is enabled on the project', 'the beacon script is served, so pageviews are being recorded');
  } else {
    fail('Vercel Web Analytics is enabled on the project',
      `/_vercel/insights/script.js answered ${v}. The tag is on every page and it is loading nothing.\n` +
      '        Fix: vercel.com → the project serving kirtonlearning.com (it is called spark-coach-families)\n' +
      '        → Analytics → Enable. A project record can carry a webAnalytics id while this is off.');
  }

  const u = await code(`${ORIGIN}/upload`);
  if (u === 200 || u === 308) pass('/upload still answers', 'the intake was not broken by any of this');
  else warn('/upload still answers', `answered ${u}`);
}

console.log(`\n${checks} passed, ${warnings} warnings, ${failures} failures\n`);
process.exit(failures ? 1 : 0);
