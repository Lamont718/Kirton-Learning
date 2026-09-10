// Can the handbook be served yet?
//
//   node verify/publish-gate.mjs
//
// The handbook is a plain-language guide to how special education works in NYC:
// deadlines, phone numbers, office names, what a district must do and by when.
// A parent reads it and acts on it — asks for an evaluation, disagrees with a
// placement, brings a letter to a meeting. A wrong date in it is not a typo.
//
// ★★★★★ Every one of its 22 facts is `unverified` and every one of its 9
// translations is `draft`. That is why `resource-platform/` and `docs/` are in
// .vercelignore. The gate is EDITORIAL, not technical — only Lamont and his
// colleague move a fact to `verified`, and nobody else gets to decide it is
// close enough.
//
// ⛔ The whole risk is that publishing is ONE LINE. Deleting `resource-platform/`
// from .vercelignore takes two seconds, looks like a deploy config tidy-up, and
// silently puts unchecked legal deadlines in front of parents. This check exists
// so that line cannot be removed quietly: it fails, loudly, naming what is not
// yet verified.
//
// It reads the ignore file and the facts together, because either one alone
// looks fine. That is the point — the fault is in the COMBINATION.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const ok = (n, d = '') => console.log('  ok    ' + n + (d ? '  — ' + d : ''));
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

console.log('\nPublish gate — may the handbook be served?\n');

// ---------------------------------------------------------------------------
// 1. What is still unverified?
// ---------------------------------------------------------------------------
const facts = JSON.parse(readFileSync(join(ROOT, 'docs/facts.json'), 'utf8'));

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
// 2. Is it currently kept off the live site?
// ---------------------------------------------------------------------------
const ignore = readFileSync(join(ROOT, '.vercelignore'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const hidden = ignore.includes('resource-platform/') && ignore.includes('docs/');

// ---------------------------------------------------------------------------
// 3. The only combination that is not allowed
// ---------------------------------------------------------------------------
if (!hidden && !clean) {
  bad('THE HANDBOOK WOULD BE PUBLISHED WITH UNCHECKED FACTS IN IT',
    `resource-platform/ and/or docs/ are no longer in .vercelignore, and ${unverified.length} fact(s) ` +
    `are still marked unverified.\n        These are NYC special-education deadlines, phone numbers and ` +
    `office names that a parent will act on.\n        Put both lines back, or verify the facts first. ` +
    `Only Lamont and his colleague can move a fact to "verified".`);
  console.log('\n        Still unverified:');
  for (const p of unverified.slice(0, 8)) console.log('          · ' + p);
  if (unverified.length > 8) console.log(`          … and ${unverified.length - 8} more`);
} else if (!hidden && clean) {
  ok('handbook is servable and every fact is verified', 'this is the state that allows publishing');
} else if (hidden && clean) {
  ok('every fact is verified', 'the handbook may now be un-ignored and merged — see CLAUDE.md for the steps');
} else {
  ok('handbook is kept off the live site', `${unverified.length} unverified, ${drafts.length} draft — correctly not published`);
}

// ---------------------------------------------------------------------------
// 4. The route the merge collides on
// ---------------------------------------------------------------------------
// The handbook's index and its 35 internal links live at /start/. The main site
// used to serve /start.html — the page a family reaches AFTER PAYING. On one
// site those fight, and the losing case is specific: a parent who has never paid
// follows "Start Here" in the free handbook and lands in the post-payment flow.
// Renamed to /welcome.html on 2026-09-10 so /start/ is free.
import { existsSync } from 'node:fs';
if (existsSync(join(ROOT, 'start.html'))) {
  bad('start.html is back on the main site',
    'The handbook owns /start/ and has 35 internal links to it. The post-payment page is ' +
    'welcome.html. Two different meanings for /start on one site sends unpaid parents into ' +
    'the post-payment flow.');
} else {
  ok('/start/ is free for the handbook', 'the post-payment page is welcome.html');
}

console.log(fail ? `\n  ${fail} failure(s)\n` : '\n  gate is satisfied\n');
process.exitCode = fail ? 1 : 0;
