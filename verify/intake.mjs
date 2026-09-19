// Checks the six-question intake form (P2) against the promise that has been
// on the site since launch. Runs offline against the files on disk; add --prod
// to also ask the deployment.
//
//     node verify/intake.mjs
//     node verify/intake.mjs --prod
//
// Why this file exists. privacy.html has told families since August, under
// "Information you give me", that it collects "your child's first name, grade,
// what's going well, what's hard, what they're into, and how best to reach
// you." It listed a Supabase table as "the intake form database". None of it
// existed. The promise shipped and the form did not, the same way the privacy
// page promised analytics the site never collected.
//
// So the first test here is not "does the form work". It is "does the form
// collect exactly what the privacy policy already said it collects" — and it
// reads the list off privacy.html rather than off a list in this file, so the
// two cannot drift apart without something going red.

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

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));

// Several checks below ask whether the CODE does something. A comment saying
// "we deliberately do not do X" contains X, and a grep over the raw file reads
// that as doing it — a test that fails on its own explanation is a test that
// gets deleted. So: strip the comments first, and ask the code.
const codeOnly = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')          // HTML comments
  .replace(/\/\*[\s\S]*?\*\//g, '')        // /* block */
  .replace(/^\s*\/\/.*$/gm, '');            // whole-line //

console.log('\nintake — the six questions\n');

// --------------------------------------------------------------- the files
console.log('the parts exist');
for (const f of ['intake.html', 'api/intake.js', 'supabase-setup-3.sql']) {
  if (has(f)) pass(f); else fail(f, 'missing');
}
if (failures) {
  console.log(`\n${checks} passed, ${warnings} warnings, ${failures} failures\n`);
  process.exit(1);
}

const page = read('intake.html');
const api = read('api/intake.js');
const sql = read('supabase-setup-3.sql');
const privacy = read('privacy.html');

// ------------------------------------------------- the promise is the spec
console.log('\nthe form matches what privacy.html already promised');

// The sentence on the live privacy page, read at runtime. If someone edits
// that line, this test starts asking about the new list.
const promised = (privacy.match(/<strong>Intake answers<\/strong>\s*(?:&mdash;|—|-)\s*([^<]*)</) || [])[1];
if (!promised) {
  fail('privacy.html still names the intake answers',
    'the "Intake answers" line is gone — if the form stops collecting these, that line should ' +
    'change on purpose, not vanish');
} else {
  pass('privacy.html names the intake answers', promised.trim().replace(/\s+/g, ' '));

  // Each promised field, and the question on the page that answers for it.
  const FIELDS = [
    [/first name/i, 'f-name', "child's first name"],
    [/grade/i, 'f-grade', 'grade'],
    [/going well/i, 'f-well', "what's going well"],
    [/what's hard|what&rsquo;s hard|whats hard/i, 'f-hard', "what's hard"],
    [/into/i, 'f-into', "what they're into"],
    [/reach you/i, 'f-contact', 'how best to reach you'],
  ];
  for (const [re, id, label] of FIELDS) {
    const inPromise = re.test(promised);
    const onPage = new RegExp(`id="${id}"`).test(page);
    if (inPromise && onPage) pass(`${label} — promised and asked`);
    else if (inPromise && !onPage) fail(`${label} — promised and asked`, `privacy.html promises it; #${id} is not on intake.html`);
    else if (!inPromise && onPage) warn(`${label} — promised and asked`, `intake.html asks it; privacy.html no longer promises it`);
    else fail(`${label} — promised and asked`, 'neither');
  }
}

// Six questions, and six is the number the page and the emails both claim.
const fieldCount = (page.match(/<(input type="text"|textarea)/g) || []).length;
if (fieldCount === 6) pass('six fields on the page', 'the page, the email and welcome.html all say six');
else fail('six fields on the page', `found ${fieldCount} — the copy says six in three places`);

// ------------------------------------------------------------------ SCOPE
console.log('\nSCOPE.md — academic only');

// A form field is a claim about what the business does. These are the words
// SCOPE.md names, and none of them may appear as something we ASK for. They
// are allowed in the one sentence that says we do not do them.
const OUT = ['speech', 'occupational therapy', 'sensory', 'counseling', 'therapy',
  'behavior', 'regulation', 'social skills', 'anxiety'];
const labels = [...page.matchAll(/<label class="q"[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[1]);
const hints = [...page.matchAll(/<p class="hint">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
const asked = labels.concat(hints).join(' ').toLowerCase();
const strayed = OUT.filter((w) => asked.includes(w));
if (strayed.length === 0) pass('no out-of-scope word in any question or hint');
else fail('no out-of-scope word in any question or hint',
  `${strayed.join(', ')} — a field is a claim, and these are the three walls in SCOPE.md`);

// And the boundary is stated to the parent, not just observed by us.
if (/reading, writing, and math/i.test(page) && /who to call/i.test(page)) {
  pass('the page says what I do not do', 'the VOICE.md line, before the two open questions');
} else {
  fail('the page says what I do not do',
    'a parent spending her five minutes on speech or OT notes is a parent I have wasted');
}

// ------------------------------------------------------- privacy posture
console.log('\nprivacy posture');

if (/name="robots" content="noindex,nofollow"/.test(page)) pass('intake.html is noindex,nofollow');
else fail('intake.html is noindex,nofollow', 'it is reached by a private one-time link');

if (/name="referrer" content="no-referrer"/.test(page)) pass('no referrer leaves the page', 'the token is in the URL');
else fail('no referrer leaves the page', 'the token is in the query string and would ride along');

if (!page.includes('/analytics.js')) pass('no analytics tag on intake.html');
else fail('no analytics tag on intake.html', 'what a parent types about her child is not measured');

if (!/localStorage|sessionStorage|indexedDB/i.test(codeOnly(page))) {
  pass('nothing is kept in browser storage', "CLAUDE.md's rule, and it may be a shared phone");
} else {
  fail('nothing is kept in browser storage', 'a child’s name and what she finds hard, left on the device');
}

const never = read('analytics.js').match(/var NEVER = \[([\s\S]*?)\]/);
if (never && /'\/intake'/.test(never[1]) && /'\/intake\.html'/.test(never[1])) {
  pass('/intake is on the analytics NEVER list', 'both spellings, because cleanUrls redirects after the script runs');
} else {
  fail('/intake is on the analytics NEVER list', 'belt and braces for a page that already omits the tag');
}

// ---------------------------------------------------------------- the API
console.log('\napi/intake.js');

// The whole design, in one assertion. The upload burns `used_at`; if intake
// also died on that flag, the form would be closed for every parent who did
// the main task first, and the normal path would be the broken one.
if (!/used_at/.test(codeOnly(api))) {
  pass('`used_at` is not a bar to the intake', 'the upload burns it; the intake is guarded by its own primary key');
} else {
  fail('`used_at` is not a bar to the intake',
    'api/intake.js reads used_at — a parent who uploaded the IEP first would find the form closed');
}

if (/on delete cascade/i.test(sql) && /primary key/i.test(sql)) {
  pass('one row per token, deleted with it', 'the primary key stops a double submit; the cascade is the retention promise');
} else {
  fail('one row per token, deleted with it', 'the PK and the cascade are both load-bearing');
}

// The same sentence for a dead link as upload-url.js, so this endpoint cannot
// be used to find out which tokens exist.
const uploadApi = read('api/upload-url.js');
const DEAD = 'That link has expired. Email me and I will send a fresh one.';
if (api.includes(DEAD) && uploadApi.includes(DEAD)) {
  pass('a dead link says the same thing on both endpoints', 'no oracle for which tokens are real');
} else {
  fail('a dead link says the same thing on both endpoints', 'a difference in wording tells the holder why it stopped working');
}

if (/revoked_at/.test(api) && /expires_at/.test(api)) pass('revoked and expired links are both refused');
else fail('revoked and expired links are both refused', 'one of the two checks is missing');

if (/supabase-setup-3\.sql/.test(api)) {
  pass('an un-run migration names the file', 'a parent sees "not open yet"; the response says which file');
} else {
  fail('an un-run migration names the file', 'PostgREST 400s the whole select when intake_at does not exist');
}

// ------------------------------------------------- the back office survives
console.log('\nthe back office survives an un-run migration');

const admin = read('api/admin.js');
if (/COLUMNS_BASE/.test(admin) && /selectTokens/.test(admin)) {
  pass('admin falls back to the pre-part-3 columns', 'adding a column must not take the whole page down');
} else {
  fail('admin falls back to the pre-part-3 columns',
    'PostgREST refuses the WHOLE select when one column is missing — part 2 already learned this');
}
if (/migrated3/.test(admin) && /migrated3/.test(read('admin.html'))) {
  pass('the admin page reports whether part 3 has been run');
} else {
  fail('the admin page reports whether part 3 has been run', 'the fallback is a bridge, and a bridge has to announce itself');
}

// ---------------------------------------------------------------- the email
console.log('\nthe email carries the link, and only when it has one');

const { iepLinkEmail } = await import(path.join('file://', ROOT, 'api', '_email.js').replace(/\\/g, '/'))
  .then((m) => m.default || m)
  .catch(async () => {
    // _email.js is CommonJS; import() of a .js file in a package without
    // "type": "module" gives us module.exports on .default.
    const { createRequire } = await import('node:module');
    return createRequire(import.meta.url)(path.join(ROOT, 'api', '_email.js'));
  });

const withIntake = iepLinkEmail({ link: 'https://x/upload.html?t=T', name: 'Dana', intake: 'https://x/intake.html?t=T' });
const without = iepLinkEmail({ link: 'https://x/upload.html?t=T', name: 'Dana' });

if (withIntake.text.includes('intake.html') && withIntake.html.includes('intake.html')) {
  pass('the link is in both halves of the email', 'plain text and HTML');
} else {
  fail('the link is in both halves of the email', 'a locked-down school inbox shows the plain text one');
}
if (!without.text.includes('intake') && !/undefined/.test(without.text + without.html)) {
  pass('a caller that passes no link sends the old email', 'no stray "undefined" at a paying family');
} else {
  fail('a caller that passes no link sends the old email', 'the block leaked into a send that has no link');
}
if (!/\n\n\n/.test(withIntake.text) && !/\n\n\n/.test(without.text)) {
  pass('no doubled blank line either way');
} else {
  warn('no doubled blank line either way', 'cosmetic, but it is the email a family reads first');
}

// Both send paths pass it.
if (/intakeLink\(row\.token\)/.test(read('api/stripe-webhook.js'))) pass('a payment emails the link');
else fail('a payment emails the link', 'stripe-webhook.js is the only path a real family takes');
if (/intakeLink\(row\.token\)/.test(admin)) pass('a hand-issued link emails it too');
else fail('a hand-issued link emails it too', 'the admin page issues links at nine at night');

// --------------------------------------------------------- the other doors
console.log('\nthe other ways in');

const upload = read('upload.html');
if (/intake\.html\?t=/.test(upload)) {
  pass('the upload done screen offers the form', 'the moment she is already at the finish line');
} else {
  fail('the upload done screen offers the form', 'the email is a backup, not the main door');
}
if (/done-intake'\)\.classList\.add\('hide'\)/.test(upload)) {
  pass('the record path does not offer it', 'nothing to ask when the record is coming back');
} else {
  fail('the record path does not offer it', 'she would be asked her child’s grade for the second time');
}
if (/Six questions about your child/.test(read('welcome.html'))) pass('welcome.html says it is coming');
else fail('welcome.html says it is coming', 'the page that sets expectations must list both asks');

// ------------------------------------------------------------------- prod
if (PROD) {
  console.log('\nprod');
  const code = async (u, init) => {
    try { return (await fetch(u, { redirect: 'manual', ...init })).status; }
    catch (e) { return 'ERR ' + e.message; }
  };
  const json = async (u, body) => {
    try {
      const r = await fetch(u, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) { return { status: 'ERR', body: { message: e.message } }; }
  };

  const p = await code(`${ORIGIN}/intake`);
  if (p === 200) pass('/intake is served'); else fail('/intake is served', `answered ${p}`);

  const g = await code(`${ORIGIN}/api/intake`);
  if (g === 405) pass('GET /api/intake is refused', '405, so the endpoint is deployed and not guessing');
  else fail('GET /api/intake is refused', `answered ${g} — 404 means it is not deployed`);

  const bad = await json(`${ORIGIN}/api/intake`, { action: 'check', token: 'not-a-uuid' });
  if (bad.status === 400) pass('a malformed token is refused', bad.body.message);
  else fail('a malformed token is refused', `answered ${bad.status}`);

  // A real-shaped token that was never issued. 403 means the table is there
  // and said no. 503 means supabase-setup-3.sql has not been run yet, which
  // is a true answer about a closed form, not a broken one.
  const ghost = await json(`${ORIGIN}/api/intake`, {
    action: 'check', token: '00000000-0000-4000-8000-000000000000',
  });
  if (ghost.status === 403) {
    pass('an unissued token is refused', ghost.body.message);
  } else if (ghost.status === 503 && ghost.body.setup) {
    warn('the form is not open yet', `run ${ghost.body.setup} in the Supabase SQL editor — the form stores nothing until then`);
  } else {
    fail('an unissued token is refused', `answered ${ghost.status}: ${ghost.body.message || ''}`);
  }

  // Nothing submits without the two required answers, checked on the server
  // and not only in the page.
  const thin = await json(`${ORIGIN}/api/intake`, {
    action: 'submit', token: '00000000-0000-4000-8000-000000000000', childFirstName: '', grade: '',
  });
  if (thin.status === 403 || thin.status === 400 || thin.status === 503) {
    pass('a submit on a dead token stores nothing', `answered ${thin.status}`);
  } else {
    fail('a submit on a dead token stores nothing', `answered ${thin.status}`);
  }

  const s = await code(`${ORIGIN}/supabase-setup-3.sql`);
  if (s === 404) pass('supabase-setup-3.sql is not served', 'it maps the schema; same as parts 1 and 2');
  else fail('supabase-setup-3.sql is not served', `answered ${s} — add it to .vercelignore`);

  const sm = await fetch(`${ORIGIN}/sitemap.xml`).then((r) => r.text()).catch(() => '');
  if (!sm.includes('/intake')) pass('/intake is not in the sitemap');
  else fail('/intake is not in the sitemap', 'a page behind a one-time link is never indexed');
}

console.log(`\n${checks} passed, ${warnings} warnings, ${failures} failures\n`);
process.exit(failures ? 1 : 0);
