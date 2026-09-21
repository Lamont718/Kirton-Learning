// The setup handoff: the half of this that lives on the site.
//
// The work app (kirton-learn) reads an IEP into a setup and puts the whole
// thing inside a link. This side never makes one. What it does is keep it out
// of an email, hold it in the same private table the IEP tokens live in, and
// hand it to one family's browser.
//
// ⛔⛔ THE RULE UNDER ALL OF IT, from CLAUDE.md: never send IEP contents to a
// third-party API. A setup link IS IEP contents — the goals are inside it, and
// it is not encrypted. An email provider is a third-party API. So the tests
// that matter most here are the ones about what is NOT in an email.
//
//   node verify/setup-handoff.mjs

import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.PUBLIC_ORIGIN = 'https://kirtonlearning.com';
process.env.APP_ORIGIN = 'https://kirton-learn.vercel.app';

const { readSetupCode, codeFrom } = require('../api/_setup-code.js');
const { setupLinkEmail, iepLinkEmail, recordLinkEmail } = require('../api/_email.js');
const { uploadLink, setupLink, joinLink, appOrigin } = require('../api/_common.js');

let pass = 0, fail = 0;
const check = (n, cond, d = '') => {
  if (cond) { pass++; console.log('  ok    ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); }
};

// ---------------------------------------------------------------------------
// A real code, built the way lib/handoff.js builds one. Written out here rather
// than imported, because the other repo is not a dependency of this one — and
// that is the point of these tests: this side has to read a format it does not
// own. ⚠️ If this fixture ever stops matching what that app produces, these
// tests pass while the desk refuses every real paste.
// ---------------------------------------------------------------------------
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const GOAL_TEXT = 'Given a grade-level informational text, the student will identify the main ' +
  'idea and two supporting details with 75% accuracy in 3 of 4 trials.';

const SETUP = {
  kind: 'kirton-learn-setup',
  version: 1,
  madeOn: '2026-09-21',
  accommodations: { readAloud: true, textScale: 1.15, reducedItems: false, passageStaysUp: true, highContrast: false },
  goals: [
    { id: 'a1', text: GOAL_TEXT, area: 'reading', engineId: 'main-idea',
      criterion: { accuracy: 0.75, of: 3, outOf: 4 }, everyDays: 7 },
    { id: 'a2', text: 'Given 20 addition facts within 20, the student will solve them with 90% accuracy in 4 of 5 opportunities.',
      area: 'math', engineId: 'math-facts', criterion: { accuracy: 0.9, of: 4, outOf: 5 },
      everyDays: 7, engineOptions: { set: 'add-20' } },
  ],
};

function encode(obj, mode = 'c') {
  const json = JSON.stringify(obj);
  const bytes = Buffer.from(json, 'utf8');
  const payload = mode === 'c' ? zlib.deflateRawSync(bytes) : bytes;
  return `KL1.${mode}.${b64url(payload)}.${fnv1a(json)}`;
}

console.log('\nThe setup handoff\n');
console.log('=== a code the work app made is read here ===');
{
  const code = encode(SETUP);
  const r = readSetupCode(code);
  check('a real code is accepted', r.ok === true, r.why);
  check('★ and the number of goals comes back, so the desk can see whose setup it is',
    r.goals === 2, JSON.stringify(r));
  check('the date it was made comes back too', r.madeOn === '2026-09-21');
  check('★ an uncompressed code reads as well — the app falls back to one on an old browser',
    readSetupCode(encode(SETUP, 'r')).ok === true);
  check('the whole link reads, not just the bare code',
    readSetupCode(`https://kirton-learn.vercel.app/#join=${code}`).ok === true);
  // ★★ The failure this will actually meet, and the reason the code is found by
  // its shape rather than by where the text around it ends.
  check('★★ a link an email app wrapped onto two lines still reads',
    readSetupCode(`https://kirton-learn.vercel.app/#join=${code.slice(0, 40)}\r\n${code.slice(40)}`).ok === true);
  check('★ and one with a sentence typed around it',
    readSetupCode(`here you go: https://kirton-learn.vercel.app/#join=${code} — open it on her tablet.`).ok === true);
}

console.log('\n=== ⛔ and a code that was CUT SHORT is refused, at the paste ===');
{
  const code = encode(SETUP);
  const short = readSetupCode(code.slice(0, -14));
  check('⛔⛔ a truncated code never reaches the database', short.ok === false);
  // ★★★ Not "that is not a setup link". A code that opens like ours and is the
  // wrong shape was CUT, and saying anything else sends him hunting the wrong
  // problem while a family waits.
  check('★★★ and it is named as what it is — incomplete, not unrecognized',
    /incomplete|cut short/i.test(short.why), short.why);
  const bitten = readSetupCode(code.slice(0, 60) + code.slice(100));
  check('★★ a code with a bite out of the middle is refused too — that is the checksum working',
    bitten.ok === false && /incomplete|damaged/i.test(bitten.why), bitten.why);
  check('something that is not a code at all is told THAT instead, and where to make one',
    /not a setup link/i.test(readSetupCode('hello').why) &&
    /work app/i.test(readSetupCode('hello').why));
  check('an empty paste asks for the link rather than storing nothing',
    readSetupCode('').ok === false);
}

console.log('\n=== ⛔⛔ what this side refuses to store on a parent\'s behalf ===');
{
  const withChecks = { ...SETUP, attempts: [{ id: 'k1', goalId: 'a1', score: 4, outOf: 5 }] };
  const r = readSetupCode(encode(withChecks));
  check('⛔⛔ a code carrying checks is refused — a check that arrives with a setup is a check nobody did',
    r.ok === false && /checks/i.test(r.why), r.why);
  const named = { ...SETUP, name: 'Adaeze' };
  check("⛔ a code with a child's name in it is refused — the work app never puts one there",
    readSetupCode(encode(named)).ok === false);
  check('a code holding something else entirely is refused',
    readSetupCode(encode({ kind: 'something-else', goals: [] })).ok === false);
  check('a setup with no goals in it is refused rather than stored as an empty link',
    readSetupCode(encode({ ...SETUP, goals: [] })).ok === false);
  const huge = 'KL1.c.' + 'A'.repeat(20000) + '.deadbeef';
  check('★ something far longer than a setup is refused before anything tries to inflate it',
    readSetupCode(huge).ok === false && /longer than a setup/i.test(readSetupCode(huge).why));
}

console.log('\n=== ⛔⛔⛔ THE SETUP DOES NOT GO THROUGH THE EMAIL PROVIDER ===');
{
  const code = encode(SETUP);
  const token = '11111111-2222-3333-4444-555555555555';
  const link = setupLink(token);
  const mail = setupLinkEmail({ link, name: 'Rose' });
  const whole = mail.text + ' ' + mail.html + ' ' + mail.subject;

  check('the email carries the short link to this site', mail.text.includes(link));
  check('⛔⛔⛔ AND NOT THE SETUP CODE', !whole.includes(code) && !whole.includes('KL1.'));
  check('⛔⛔ nor one word of any goal in it',
    !whole.includes(GOAL_TEXT) && !whole.includes('main idea') && !whole.includes('addition facts'));
  check('⛔ nor the work app\'s address with a fragment on it', !/#join=/.test(whole));
  // ★★ A subject line is read off a lock screen by whoever is holding the
  // phone, so the child's name does not go in one.
  check("★★ and no child's name anywhere, including the subject line",
    !/Adaeze/.test(whole) && mail.subject === "Your child's work is set up");
  check('it still says the one sentence all three emails carry',
    /I will never ask for the IEP any other way/.test(mail.text));
  check('★ it tells her to open it on the device the work will happen on',
    /device the work is going to happen on/i.test(mail.text));
  check('★ and that nothing is added until she presses the button',
    /nothing is added until you press the button/i.test(mail.text));

  // The rule the other two emails have always kept, asserted for all three at
  // once so a fourth cannot quietly break it.
  const others = [
    iepLinkEmail({ link: 'https://kirtonlearning.com/upload.html?t=' + token, name: 'Rose' }),
    recordLinkEmail({ link: 'https://kirtonlearning.com/upload.html?t=' + token + '&k=record', name: 'Rose' }),
    mail,
  ];
  check('★★★ not one of the three emails contains a setup code',
    others.every((m) => !/KL1\.[cr]\./.test(m.text + m.html)));
}

console.log('\n=== the links this side builds ===');
{
  const token = '11111111-2222-3333-4444-555555555555';
  check('a setup token points at the collect page, not at the upload page',
    uploadLink(token, 'setup') === `https://kirtonlearning.com/setup?t=${token}`);
  // ⚠️ cleanUrls is on: /setup.html is a 308 to /setup. A link that is going
  // into an email should not spend a redirect, with the token riding through
  // it, on a spelling nobody needs.
  check('★ and it is the clean url, so the emailed link is not a redirect',
    !uploadLink(token, 'setup').includes('.html'));
  check('an IEP token still points at the upload page',
    uploadLink(token, 'iep') === `https://kirtonlearning.com/upload.html?t=${token}`);
  check('a record token still carries its k=record',
    uploadLink(token, 'record').endsWith('&k=record'));
  check('★★ the setup link a family taps puts the goals in the FRAGMENT',
    joinLink('KL1.c.xxx.deadbeef') === 'https://kirton-learn.vercel.app/#join=KL1.c.xxx.deadbeef');
  check('the work app\'s origin is configurable, so a preview cannot be hard-coded into an email',
    appOrigin() === 'https://kirton-learn.vercel.app');
}

console.log('\n=== the page that hands it over ===');
{
  const page = readFileSync(new URL('../setup.html', import.meta.url), 'utf8');
  check('it is never indexed', /name="robots" content="noindex,nofollow"/.test(page));
  // ⛔⛔ Both halves. Without them the browser announces this page's address —
  // token and all — to the work app's server on the way out.
  check('⛔⛔ it sends no referrer, by meta', /name="referrer" content="no-referrer"/.test(page));
  check('⛔⛔ and the outbound link says so itself', /id="go"[^>]*rel="noreferrer"/.test(page));
  check('★ it loads no analytics beacon — this page knows which family is on it',
    !/analytics\.js|_vercel\/insights/.test(page));
  check('★ it asks the server for the setup and does not read it out of its own URL',
    /fetch\('\/api\/setup'/.test(page) && !/#join=/.test(page.replace(/placeholder="[^"]*"/g, '')));
  check('the whole setup is only ever put in the href', /setAttribute\('href', link\)/.test(page));
  check('★ it tells her what the app will ask for, before she taps',
    /first name only/i.test(page));
  check('★ and warns that the copied link holds the goals word for word',
    /word for word/i.test(page) && /sensitive as the page of the IEP/i.test(page));
}

console.log('\n=== the desk, and the migration it needs ===');
{
  const admin = readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/setup.js', import.meta.url), 'utf8');

  check('the desk can send a setup', /action === 'setup'/.test(admin));
  check('★★ and it validates the paste BEFORE it stores it', /readSetupCode\(body\.code\)/.test(admin));
  check('★ a failed insert names the file to run', /supabase-setup-5\.sql/.test(admin));
  check('★ and the status panel says whether it has been run',
    /migrated5/.test(admin) && /supabase-setup-5\.sql/.test(html));
  // ⛔ The one that would have shipped silently: a reissued setup with no code
  // on it is a link to an empty page, reported as sent.
  check('⛔ reissuing a setup carries the setup with it', /carried \? \{ setup_code: carried \}/.test(admin));
  check('★★ and refuses rather than sending an empty one', /would be an empty link/.test(admin));
  // ⛔ The list is a screen he leaves open. A child's goals have no business on
  // it, so the column is not in either select the desk uses — the only place
  // that reads it is the reissue path, which needs it to carry it forward.
  const columnLists = (admin.match(/^const COLUMNS[A-Z_]* =[\s\S]*?;$/gm) || []).join('\n');
  check('★ the two column lists were found, so this is checking something',
    /COLUMNS_BASE/.test(columnLists) && columnLists.includes('parent_email'), columnLists.slice(0, 60));
  check('⛔ and neither of them selects a setup code into the list',
    !/setup_code/.test(columnLists));
  const clears = (html.match(/\[([^\]]*)\]\.forEach\(function \(id\) \{ \$\(id\)\.value = ''/g) || []).join('|');
  check("★ the pasted code is cleared from the form whatever happened",
    /'s-code'/.test(clears), clears.slice(0, 120));

  // ★★ A setup link is the one kind that does not die when it is used.
  check('★★ collecting a setup does not kill the link', /not one-time, on purpose/i.test(api));
  check('★ and the desk shows that as its own status', /'collected'/.test(admin) && /p-collected/.test(html));
  check('⛔ every refusal from /api/setup says the same thing, so it cannot be used to find tokens',
    (api.match(/reject\(res, 403, NO\)/g) || []).length >= 3);
  check('★ a missing migration reads as "not open yet" to a parent, never as a schema error',
    /r\.status === 400/.test(api) && /not open yet/.test(api));
}

console.log('\n=== the two ignore files still agree about the SQL ===');
{
  // ⛔ The repo is PUBLIC. A new supabase-setup file does not inherit the old
  // one's ignore line, and this has gone wrong here before — twice in one day
  // on 2026-09-19. Derived from what is actually on disk.
  const git = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  const vercel = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  const onDisk = require('node:fs')
    .readdirSync(new URL('../', import.meta.url))
    .filter((f) => /^supabase-setup.*\.sql$/.test(f));
  check('there is at least one migration on disk to check', onDisk.length >= 5, onDisk.join(' '));
  for (const f of onDisk) {
    check(`${f} is kept out of the public repo and off the live site`,
      git.includes(f) && vercel.includes(f),
      `gitignore:${git.includes(f)} vercelignore:${vercel.includes(f)}`);
  }
}

// ---------------------------------------------------------------------------
// ★★★★ THE PROBE THAT TELLS THE TRUTH. Run with --prod.
//
// On 2026-09-09 the whole intake looked finished and had a hole in the middle:
// every stage was built and nothing ever wrote a token row. What settled it was
// posting a fake token at the deployment and reading WHICH rejection came back
// — 403 "not valid" means the database is reachable and the token simply is not
// there; 503 means it was never wired up at all. Guessing from the code would
// have said "probably not configured". Same two answers, same diagnosis, here.
// ---------------------------------------------------------------------------
if (process.argv.includes('--prod')) {
  const origin = (process.argv.find((a) => a.startsWith('http')) || 'https://kirtonlearning.com')
    .replace(/\/+$/, '');
  console.log(`\n=== ★ the deployment, ${origin} ===`);
  const fake = '00000000-0000-4000-8000-000000000000';
  try {
    const r = await fetch(`${origin}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: fake }),
    });
    const b = await r.json().catch(() => ({}));
    if (r.status === 403) {
      check('★★★ /api/setup is wired: a token that does not exist is refused, not 503d', true);
      check('★ and the refusal gives nothing away about which tokens exist',
        /not valid, or it has expired/.test(b.message || ''), b.message || '');
    } else if (r.status === 503) {
      // ★★★★ 503 has TWO causes and they need different actions, so ask the
      // endpoint next door. /api/upload-url reads the same database with the
      // same credentials and needs nothing from part 5: if IT can refuse a fake
      // token, Supabase is wired and the only thing missing is the migration.
      // Guessing between the two is what the 09-09 probe was invented to stop.
      const other = await fetch(`${origin}/api/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fake, filename: 'x.pdf', size: 100, type: 'application/pdf' }),
      }).then((x) => x.status).catch(() => 0);
      check(other === 403
        ? '⏳ NOT AN OUTAGE: Supabase is wired (the upload endpoint refuses a fake token ' +
          'properly) and /api/setup is 503, so supabase-setup-5.sql has NOT been run yet. ' +
          'Open the Supabase SQL editor and run it — nothing else is missing.'
        : `⛔ /api/setup is 503 AND /api/upload-url answered ${other} — this is the database ` +
          'connection itself, not the migration.', false, JSON.stringify(b));
    } else {
      check(`/api/setup answered ${r.status}`, false, JSON.stringify(b).slice(0, 200));
    }
    const page = await fetch(`${origin}/setup?t=${fake}`);
    const html = await page.text();
    check('★ the collect page itself is served at the clean url', page.ok);
    check('★ and it is noindex on the deployment, not only on disk',
      /noindex/.test(html) && /no-referrer/.test(html));
  } catch (err) {
    check('the deployment answered at all', false, String(err.message || err));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
// ⚠️ Not process.exit(): on Windows, killing the loop while a fetch handle is
// still closing prints a libuv assertion AFTER the summary, which reads like
// the suite itself crashed. Set the code and let it end on its own.
process.exitCode = fail ? 1 : 0;
