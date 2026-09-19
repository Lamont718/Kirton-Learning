// Guards the one move that could put unchecked deadlines in front of a parent:
// flipping facts to "verified" to unblock publishing.
//
//     node verify/fact-sources.mjs
//     node verify/fact-sources.mjs --net     also checks every source URL still answers
//
// publish-gate.mjs asks whether anything is still unverified. It cannot ask
// whether a "verified" fact was actually verified against anything — and on the
// day the handbook is finally published, 22 statuses change at once. That is the
// moment this file exists for.
//
// RESOURCE.md: "Never publish anything with status: unverified" · "Lamont and his
// colleague move entries to verified; you never do" · "If a source URL is dead or
// the page changed materially, set status back to unverified and tell Lamont."
// docs/FACT-VERIFICATION.md carries the evidence gathered for each entry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTS = path.join(ROOT, 'docs', 'facts.json');
const NET = process.argv.includes('--net');

let failures = 0, warnings = 0, checks = 0;
const fail = (w, d) => { failures++; console.log(`  FAIL  ${w}\n        ${d}`); };
const warn = (w, d) => { warnings++; console.log(`  warn  ${w}\n        ${d}`); };
const pass = (w, d) => { checks++; console.log(`  ok    ${w}${d ? `\n        ${d}` : ''}`); };

// The bodies that actually make the rules a parent is subject to. Anything else
// — IncludeNYC, Columbia, Autism Speaks, InsideSchools, a single school's site,
// a private provider, a blog — is somebody reporting them.
const PRIMARY = [
  /(^|\.)schools\.nyc\.gov$/, /(^|\.)nyc\.gov$/, /(^|\.)nysed\.gov$/,
  /(^|\.)health\.ny\.gov$/, /(^|\.)opwdd\.ny\.gov$/, /(^|\.)dfs\.ny\.gov$/,
  /(^|\.)ny\.gov$/, /(^|\.)ed\.gov$/, /(^|\.)ecfr\.gov$/, /(^|\.)govinfo\.gov$/,
];

const facts = JSON.parse(fs.readFileSync(FACTS, 'utf8'));

function entries(node, p = '') {
  const out = [];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if ('status' in node) out.push([p, node]);
    for (const [k, v] of Object.entries(node)) out.push(...entries(v, p ? `${p}.${k}` : k));
  }
  return out;
}
const all = entries(facts);
const sourcesOf = (e) => [e.source, ...(Array.isArray(e.sources) ? e.sources : [e.sources])]
  .flat().filter(Boolean)
  .map(s => (typeof s === 'string' ? s : s.url)).filter(Boolean);
const host = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const isPrimary = (u) => { const h = host(u); return !!h && PRIMARY.some(r => r.test(h)); };

console.log(`\nfact sources — ${all.length} entries\n`);

// ------------------------------------------------- nothing is verified on air
console.log('a verified fact has to have been verified against something');
// "editorial" is an exemption from needing a source, so it is a claim like any
// other and it gets checked. An entry is editorial when it is OURS to word — a
// glossary sentence, a rule about how we describe a profession. It stops being
// editorial the moment it carries something a parent would act on or repeat in
// a meeting: a class ratio, a deadline in days, a dollar figure, a phone
// number, or a statement about who is licensed to do what.
//
// ⛔ This exists because the advice below used to read "some are editorial by
// nature (a glossary, a rule about how we describe a profession). Mark those
// editorial: true" — and of the four entries it was pointing at, the glossary
// defines the 12:1:1 class ratios and professional_roles makes eleven licensure
// claims. Following that advice would have walked both of them past the
// verification gate, wearing a label that means "no source needed".
// ★★★ An exemption that is granted by asserting it is not an exemption, it is a
// hole. The label has to be earned.
const NOT_EDITORIAL = [
  [/\b\d+:\d+(?::\d+)?\b/, 'a class ratio'],
  [/\b\d{1,3}\s*(?:calendar |school |business )?days\b/i, 'a deadline in days'],
  [/\$\s?\d/, 'a dollar figure'],
  [/\b(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b|\b311\b/, 'a phone number'],
  [/licens\w+/i, 'a licensure claim'],
];
const disqualifies = e => NOT_EDITORIAL
  .filter(([re]) => re.test(JSON.stringify(e)))
  .map(([, what]) => what);

const claimed = all.filter(([, e]) => e.editorial === true);
for (const [p, e] of claimed) {
  const why = disqualifies(e);
  why.length
    ? fail(`${p} is marked editorial and is not`, `it carries ${why.join(', ')} — that needs a source, not a label`)
    : pass(`${p} is editorial and carries nothing to act on`);
}

const verified = all.filter(([, e]) => e.status === 'verified');
if (!verified.length) {
  pass('no entry claims to be verified yet', `${all.length} entries, none verified — this check has teeth the day that changes`);
} else {
  for (const [p, e] of verified) {
    if (e.editorial === true && !disqualifies(e).length) { pass(`${p} is marked editorial`, 'no external source expected'); continue; }
    const srcs = sourcesOf(e);
    if (!e.verified_on) fail(`${p} is verified with no date`, 'verified_on is null — RESOURCE.md requires a last-reviewed date on every page');
    else if (!srcs.length) fail(`${p} is verified with no source`, 'a status is not evidence');
    else if (!srcs.some(isPrimary)) fail(`${p} is verified against a secondary source`, `only ${srcs.map(host).join(', ')} — that is somebody reporting the rule, not the body that makes it`);
    else pass(`${p} is verified, dated, and cites a primary authority`);
  }
}

// -------------------------------------------------- every factual claim cites
console.log('\nevery factual claim names where it came from');
const noSource = [], secondary = [], primary = [], editorial = [];
for (const [p, e] of all) {
  if (e.status === 'draft') continue;           // translations, handled below
  if (e.editorial === true && !disqualifies(e).length) { editorial.push(p); continue; }
  const srcs = sourcesOf(e);
  if (!srcs.length) noSource.push(p);
  else if (srcs.some(isPrimary)) primary.push(p);
  else secondary.push(p);
}
if (noSource.length) {
  // Say which ones could honestly take the label and which could not, computed
  // from what they contain rather than guessed at in a sentence. The blanket
  // version of this advice named a glossary as the example, and that glossary
  // defines class ratios.
  const lines = noSource.map(p => {
    const e = all.find(([q]) => q === p)[1];
    const why = disqualifies(e);
    // Note the asymmetry: this can rule an entry OUT of being editorial and it
    // can never rule one in. "No number in it" is not the same as "ours to
    // word" — lre_principle is a paraphrase of a federal statute and carries no
    // digits at all. A person decides the label; this only refuses the ones
    // that plainly cannot have it.
    return why.length
      ? `          ${p} — NOT editorial: it carries ${why.join(', ')}. Needs a source.`
      : `          ${p} — nothing actionable in it. If the WORDING is ours, "editorial": true; if it restates a law or a rule, it still needs the source.`;
  });
  warn(`${noSource.length} entries have no source at all`, `\n${lines.join('\n')}`);
} else pass('every non-editorial entry names a source');

if (secondary.length) {
  warn(`${secondary.length} entries rest on a secondary source`,
    `${secondary.join(', ')}\n        Good organizations, none of them the authority. See docs/FACT-VERIFICATION.md.`);
}
pass('source split counted', `${primary.length} primary · ${secondary.length} secondary · ${noSource.length} none · ${editorial.length} editorial`);

// --------------------------------------------------- the evidence is attached
console.log('\nthe evidence sits next to the claim');
const annotated = all.filter(([, e]) => typeof e.verify_against === 'string' && e.verify_against.length > 40);
pass(`${annotated.length} entries carry a verify_against note`, 'what the primary authority actually says, so signing one off is a read');

// ------------------------------------------------------------ drafts and urls
console.log('\ntranslations');
const drafts = all.filter(([, e]) => e.status === 'draft');
const unreviewed = drafts.filter(([, e]) => !e.reviewed_by);
if (unreviewed.length) {
  pass(`${unreviewed.length} of ${drafts.length} translations have no named reviewer`,
    'correctly still draft — a fact needs a source, a translation needs a human who reads that language');
}

if (NET) {
  console.log('\nsource urls still answer');
  const seen = new Set();
  for (const [p, e] of all) {
    for (const u of sourcesOf(e)) {
      if (seen.has(u)) continue;
      seen.add(u);
      let code = 0;
      try { code = (await fetch(u, { method: 'GET', redirect: 'follow' })).status; } catch { code = 0; }
      if (code >= 200 && code < 400) pass(`${host(u)} answers ${code}`);
      else fail(`a source for ${p} does not answer`, `${u} → ${code || 'no response'}\n        RESOURCE.md: a dead source means the fact goes back to unverified.`);
    }
  }
}

console.log(`\n${checks} passed, ${warnings} warnings, ${failures} failures\n`);
process.exit(failures ? 1 : 0);
