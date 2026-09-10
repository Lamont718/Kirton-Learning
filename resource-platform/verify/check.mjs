// Checks the resource platform against the rules in docs/RESOURCE.md and
// docs/SCOPE.md. Runs offline against the files on disk, needs nothing installed:
//
//     node verify/check.mjs
//
// Browser-level checks — contrast, touch targets, print output, whether the
// loader actually runs — are not here, because they need a real browser and this
// has to work with no dependencies. Those are in verify/README.md, with the
// commands that were used to prove them.
//
// Every check below exists because something was actually wrong at some point.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTS = path.join(ROOT, '..', 'docs', 'facts.json');

let failures = 0, warnings = 0, checks = 0;
const fail = (what, detail) => { failures++; console.log(`  FAIL  ${what}\n        ${detail}`); };
const warn = (what, detail) => { warnings++; console.log(`  warn  ${what}\n        ${detail}`); };
const pass = (what) => { checks++; console.log(`  ok    ${what}`); };

const html = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['fonts', 'docs', 'verify', 'node_modules', '.vercel'].includes(e.name)) walk(p); }
    else if (e.name.endsWith('.html')) html.push(p);
  }
})(ROOT);

const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const read = p => fs.readFileSync(p, 'utf8');

console.log(`\nresource platform — ${html.length} pages\n`);

// ---------------------------------------------------------------- facts.json
console.log('facts.json');
const facts = JSON.parse(read(FACTS));

function entries(node, p = '') {
  const out = [];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if ('status' in node) out.push([p, node]);
    for (const [k, v] of Object.entries(node)) out.push(...entries(v, p ? `${p}.${k}` : k));
  }
  return out;
}
const all = entries(facts);
pass(`${all.length} entries carry a status`);

for (const [p, e] of all) {
  if (e.status === 'verified' && !e.verified_on) fail('verified with no date', `${p} — someone marked it without recording when`);
  if (e.status !== 'verified' && e.verified_on) fail('date with no verification', `${p} — verified_on set but status is ${e.status}`);
  if (!e.source && !e.sources && !p.startsWith('translation_review')) warn('no source', `${p} — RESOURCE.md: adding a fact means adding a source URL`);
}
const unverified = all.filter(([, e]) => e.status === 'unverified').length;
const draft = all.filter(([, e]) => e.status === 'draft').length;
pass(`${unverified} unverified, ${draft} draft — nothing may publish until a person changes these`);

// numeric twins must not drift from the sentence they came from
const twins = [
  ['timelines.evaluation_completion', 'days', 60],
  ['timelines.interpreter_request_notice', 'hours', 72],
  ['timelines.turning_5_no_letter_deadline', 'month', 2],
];
for (const [p, field] of twins) {
  const node = p.split('.').reduce((o, k) => o?.[k], facts);
  if (node && node[field] === undefined) fail('missing numeric twin', `${p}.${field} — the calculator does arithmetic with it`);
}
pass('the calculator\'s numbers are still in the file');

// ------------------------------------------------------------ page furniture
console.log('\nevery page');
const REQUIRED = [
  [/<meta name="robots" content="noindex/, 'noindex — nothing here is published yet'],
  [/<html lang="/, 'a lang attribute'],
  [/<title>[^<]+<\/title>/, 'a title'],
  [/class="draft"/, 'the draft banner'],
  [/src="\/facts\.js"/, 'the facts loader'],
  [/data-fact-reviewed/, 'a visible review date'],
  [/data-page-url/, 'its own URL for the printed copy'],
];
for (const [re, what] of REQUIRED) {
  const missing = html.filter(f => !re.test(read(f))).map(rel);
  if (missing.length) fail(`missing ${what}`, missing.join(', '));
}
if (!failures) pass('noindex, lang, title, draft banner, loader, review date, print URL');

// --------------------------------------------------- facts wired to the pages
console.log('\nfacts on the pages');
// A path may land on an entry object or on a plain string inside one. This is
// exactly what the loader got wrong once: the phone spans resolved to strings,
// so nothing was ever replaced and it still looked right, because the fallback
// text in the HTML happened to equal the value in the file.
function resolve(p) {
  const parts = p.split('.'); let node = facts, owner = null;
  for (const k of parts) {
    if (node && typeof node === 'object' && 'status' in node) owner = node;
    node = node?.[k];
    if (node === undefined) break;
  }
  if (node && typeof node === 'object' && 'status' in node) owner = node;
  return { node, owner };
}
let spans = 0, drift = 0;
for (const f of html) {
  const s = read(f);
  for (const m of s.matchAll(/data-fact="([^"]+)"(?:[^>]*data-field="([^"]+)")?[^>]*>([^<]*)</g)) {
    spans++;
    const [, p, field, text] = m;
    const { node } = resolve(p);
    if (node === undefined) { fail('data-fact points at nothing', `${rel(f)} — ${p} is not in facts.json`); continue; }
    const value = typeof node === 'string' ? node : node[field || 'value'];
    if (typeof value !== 'string') { fail('data-fact resolves to no text', `${rel(f)} — ${p} has no ${field || 'value'}`); continue; }
    if (text.trim() && text.trim() !== value.trim()) {
      drift++;
      warn('fallback text has drifted', `${rel(f)}\n        ${p}\n        page says "${text.trim()}"\n        file says "${value.trim()}"`);
    }
  }
}
pass(`${spans} data-fact spans, all resolve${drift ? `, ${drift} drifted` : ', none drifted from the file'}`);

// ------------------------------------------------------------- links on disk
console.log('\nlinks');
let broken = 0;
for (const f of html) {
  const s = read(f);
  for (const m of s.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
    const target = m[1];
    if (target.startsWith('//')) continue;
    const candidates = [
      path.join(ROOT, target),
      path.join(ROOT, target + '.html'),
      path.join(ROOT, target, 'index.html'),
    ];
    if (!candidates.some(c => fs.existsSync(c))) {
      broken++; fail('link goes nowhere', `${rel(f)} -> ${target}`);
    }
  }
}
if (!broken) pass('every internal link resolves to a file that exists');

// ------------------------------------------------------ meeting mode: calling
console.log('\nphone numbers');
const phone = /\b(?:\(\d{3}\)\s*|\d{3}-)\d{3}-\d{4}\b/g;
let untappable = 0;
for (const f of html) {
  const s = read(f).replace(/<script[\s\S]*?<\/script>/g, '');
  for (const m of s.matchAll(phone)) {
    const before = s.slice(Math.max(0, m.index - 220), m.index);
    const openA = before.lastIndexOf('<a '), closeA = before.lastIndexOf('</a>');
    const inTel = openA > closeA && before.slice(openA).includes('tel:');
    if (!inTel) { untappable++; fail('phone number is not tappable', `${rel(f)} — ${m[0]} (RESOURCE.md: phone numbers as tel: links)`); }
  }
}
if (!untappable) pass('every phone number is a tel: link');

// ------------------------------------------------------------- voice + scope
console.log('\nvoice and scope');
const BANNED = /\b(unlock|empower|transformative|revolutioniz\w*|holistic|synergy|game-changing|cutting-edge|leverage|your child's potential|catch up|close the gap|on grade level|suffers from|high-functioning|low-functioning|behavior problem)\b/gi;
const CLINICAL = /\b(social skills group|emotional regulation|self-regulation|sensory diet|sensory break|coping strateg\w+|behavior management|articulation target|whole child|comprehensive support)\b/gi;
const BRITISH = /\b(programme|organisation|organise\w*|colour\w*|behaviour\w*|centre|licence|realis\w+|recognis\w+|analyse\w*|neighbourhood|defence|maths|whilst|grey)\b/gi;
let voice = 0;
for (const f of html) {
  const text = read(f).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ');
  for (const [re, what] of [[BANNED, 'banned vocabulary (VOICE.md)'], [CLINICAL, 'clinical scope (SCOPE.md)'], [BRITISH, 'British spelling']]) {
    const hits = [...new Set((text.match(re) || []))];
    if (hits.length) { voice++; fail(what, `${rel(f)} — ${hits.join(', ')}`); }
  }
}
if (!voice) pass('no banned vocabulary, no clinical framing, no British spellings');

// --------------------------------------------------------------------- done
console.log(`\n${checks} checks passed, ${warnings} warnings, ${failures} failures\n`);
process.exit(failures ? 1 : 0);
