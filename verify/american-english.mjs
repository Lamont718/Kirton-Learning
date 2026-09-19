// Every file we write, swept for British spelling. Runs offline against the
// files on disk, needs nothing installed:
//
//     node verify/american-english.mjs
//
// Why this file exists. Lamont writes American English and the site is read by
// American parents in Brooklyn. There has been a British-spelling check since
// August — inside verify/handbook-check.mjs, where it sweeps the handbook pages
// and nothing else. On 09-18 four British spellings turned up in
// api/stripe-webhook.js, months after the cleanup that was supposed to have
// ended this. On 09-19 the record app was still labeling a math goal the
// British way, in an assertion that had been red the whole time and was carried
// as "pre-existing" — the app had been corrected and the test had not.
//
// ★ Both survived a cleanup because the cleanup was a person reading files, and
// the gate that should have caught them was only ever pointed at eight HTML
// pages. A rule about the whole repo needs a sweep over the whole repo.
//
// It does not care whether a word is prose, a comment, or a CSS class name. The
// record app's pill class was a name no parent would ever see, and it was
// corrected too, because an exception you have to remember is not a rule.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const WORDS = path.join(path.dirname(HERE), 'british-words.txt');

let failures = 0, checks = 0;
const fail = (what, detail) => { failures++; console.log(`  FAIL  ${what}\n        ${detail}`); };
const pass = (what, detail) => { checks++; console.log(`  ok    ${what}${detail ? `\n        ${detail}` : ''}`); };
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');

// ------------------------------------------------------------------ the list
// The list lives in its own file, and that file is the only one excused from
// the sweep — because it is the sweep. It is excused on the condition that it
// can hold nothing else: every line is a comment or a single lowercase pattern,
// asserted here. A list file that could carry a sentence would be a hiding
// place, which is the thing this gate exists to remove.
const raw = fs.readFileSync(WORDS, 'utf8').split(/\r?\n/);
const patterns = [];
let shape = true;
raw.forEach((line, i) => {
  const s = line.trim();
  if (!s || s.startsWith('//')) return;
  if (!/^[a-z[\]+* -]+$/.test(s)) {
    shape = false;
    fail('the word list holds patterns and nothing else', `${rel(WORDS)}:${i + 1} — ${s}`);
  }
  patterns.push(s);
});
if (shape) pass('the word list holds patterns and nothing else', `${patterns.length} of them; nothing can hide in it`);
if (patterns.length < 50) fail('the word list is intact', `only ${patterns.length} patterns — this gate is nearly a no-op`);

const RE = new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'gi');
const scan = text => { const hits = [...new Set(text.match(RE) || [])]; RE.lastIndex = 0; return hits; };

// ------------------------------------------------------------------ self-test
// A spelling gate that matches nothing passes every repo on earth, including
// one written end to end in British English. Prove it bites before trusting a
// green run.
//
// ★ Not one British word is written out in this file. The fixture is built FROM
// the list, because a gate that spells out what it bans has to be excused from
// its own sweep — and an excused file is exactly where a British spelling would
// live forever. It cannot open the hole it exists to close.
const sample = patterns.slice(0, 4).map(w => w.replace(/\[a-z\]\*/g, '').replace(/\[a-z\]\+/g, 'x'));
const bit = scan(`One ${sample.join(' and ')}.`);
if (bit.length === sample.length) pass('the gate bites', `${bit.length} of ${sample.length} off its own list: ${bit.join(', ')}`);
else fail('the gate bites', `${sample.length} words off its own list, ${bit.length} matched`);

// The two properties that decide whether anyone can live with it: it is
// case-insensitive, and it stops at word boundaries. Without the second, a
// banned word buried inside a hash, a base64 blob or a minified identifier
// turns the gate into noise, and a noisy gate gets switched off.
const cased = sample[0][0].toUpperCase() + sample[0].slice(1);
if (scan(cased).length) pass('it catches a capitalized one', cased);
else fail('it catches a capitalized one', `${cased} went through`);

const buried = `zz${sample[0]}zz`;
if (!scan(buried).length) pass('and it stops at word boundaries', `${buried} is not a hit`);
else fail('and it stops at word boundaries', `${buried} was flagged; the sweep would be unusable`);

// A gate that fires on "color" is switched off within a day. Prove the American
// spellings go straight through.
const CLEAN = 'The program recognizes her behavior, 80 percent of the color, gray, in 4 of 5 trials.';
const clean = scan(CLEAN);
if (!clean.length) pass('and it leaves American spelling alone');
else fail('and it leaves American spelling alone', `flagged ${clean.join(', ')} in a clean sentence`);

// ------------------------------------------------------------------ the sweep
// Ours to write, so ours to spell: source and copy, comments included.
// record/vendor is pdf.js — third-party, untouched, and its own license text is
// spelled the British way, which is not ours to correct. node_modules and .git
// for the same reason. Everything else in the repo is in.
const SKIP = new Set(['.git', 'node_modules', '.vercel', 'vendor']);
const EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.sql', '.txt', '.md']);

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

// A translated block is not English and cannot be judged as English. The
// interpreter letter carries the same paragraph in fourteen languages, and the
// French verb for "to use" is the exact twin of a British spelling on the list —
// correct French, flagged as bad English. The file marks its own translated
// blocks, rather than this gate holding a list of filenames it half-trusts.
//
// ★ The markers are the only way out of the sweep, so they are measured. A
// marker that can grow without limit is an exception list with extra steps: if
// the skipped share of a file passes a fifth, someone has wrapped a page
// instead of a paragraph, and this says so.
//
// ★★ Built from a fragment rather than written out, because writing the opening
// marker in this file OPENS ONE — the gate skipped its own second half and then
// reported that the file was clean. A marker is a thing a file can say by
// accident, including the file that defines it.
const TAG = 'not-english';
const START = new RegExp(`${TAG}:start`), END = new RegExp(`${TAG}:end`);
const files = walk(ROOT).filter(p => p !== WORDS);
let dirty = 0, skippedLines = 0, sweptLines = 0;

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const english = [];
  let inside = false, opened = 0, skippedHere = 0;
  for (const line of lines) {
    if (!inside && START.test(line)) { inside = true; opened++; skippedHere++; continue; }
    if (inside) { skippedHere++; if (END.test(line)) inside = false; continue; }
    english.push(line);
  }
  if (inside) fail('every not-english block is closed', `${rel(f)} — opened and never closed, so the rest of the file went unswept`);
  if (opened && skippedHere / lines.length > 0.2) {
    fail('the not-english blocks stay small', `${rel(f)} — ${Math.round(skippedHere / lines.length * 100)}% of the file skipped; that is a page, not a paragraph`);
  }
  skippedLines += skippedHere;
  sweptLines += english.length;

  const hits = scan(english.join('\n'));
  if (hits.length) { dirty++; fail('British spelling', `${rel(f)} — ${hits.join(', ')}`); }
}
if (!dirty) {
  pass('no British spelling in any file we write',
    `${files.length} files, ${sweptLines} lines, this one included — ${skippedLines} lines skipped as not English`);
}

console.log(`\n${checks} passed, ${failures} failures\n`);
process.exit(failures ? 1 : 0);
