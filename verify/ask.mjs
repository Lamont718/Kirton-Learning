// Checks the ask form — the route for a parent who is interested and not ready
// to pay. Runs offline against the files on disk; add --prod to ask the
// deployment too.
//
//     node verify/ask.mjs
//     node verify/ask.mjs --prod
//
// Why this file exists. index.html has carried two buttons since launch. One
// takes money. The other says "Ask me a question first" and was a mailto: link
// — which on a phone with no mail app configured does nothing at all: no error,
// no draft, no send. The only route for someone not ready to spend $349 was a
// button that silently failed for an unknown share of the people who pressed
// it, and nobody could ever have known, because a mailto: that goes nowhere
// leaves no trace on either end.
//
// ★ Same rule as the intake gate: the promise is read off privacy.html at
// RUNTIME, so the page that sells trust and the form that collects cannot drift
// apart without something going red.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = process.argv.includes('--prod');
const SITE = process.env.SITE || 'https://kirtonlearning.com';

let checks = 0, warnings = 0, failures = 0;
const pass = (what, detail) => { checks++; console.log(`  ok    ${what}${detail ? `\n        ${detail}` : ''}`); };
const warn = (what, detail) => { warnings++; console.log(`  warn  ${what}${detail ? `\n        ${detail}` : ''}`); };
const fail = (what, detail) => { failures++; console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ''}`); };
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const page = read('ask.html');
const api = read('api/ask.js');
const sql = read('supabase-setup-4.sql');
const privacy = read('privacy.html');
const index = read('index.html');

// --------------------------------------------------- the promise is the spec
console.log('\nthe privacy page describes this form, and the form obeys it');

const promise = (privacy.match(/<li><strong>A question you ask before paying<\/strong>([\s\S]*?)<\/li>/) || [])[1];
if (!promise) {
  fail('privacy.html describes the ask form', 'no "A question you ask before paying" entry — the form collects something the policy does not mention');
} else {
  pass('privacy.html describes the ask form', 'read at runtime, not copied into this file');

  // Every field the policy promises has to exist on the page.
  const promised = [
    [/email address/i, 'input[name=email]', /name="email"/],
    [/your question/i, 'the question box', /name="message"/],
    [/which page you asked from/i, 'the referring page', /cameFrom/],
  ];
  for (const [inPolicy, label, inPage] of promised) {
    if (!inPolicy.test(promise)) { fail(`the policy still promises ${label}`, 'it was removed from privacy.html but the form may still collect it'); continue; }
    inPage.test(page) ? pass(`${label} — promised and present`) : fail(`${label} is promised and missing`);
  }

  // And nothing beyond it. A third field is a new claim about what this
  // business collects, and the policy is where that claim has to be made first.
  const fields = [...page.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/g)].map(m => m[1]);
  const allowed = new Set(['email', 'message']);
  const extra = fields.filter(f => !allowed.has(f));
  extra.length
    ? fail('the form collects something the policy does not name', extra.join(', '))
    : pass('the form collects nothing the policy does not name', fields.join(', ') || 'none');
}

// The policy says there is no list. The form says it too. If one of them stops
// being true, they have to stop saying it together.
/no list and no newsletter|there is no list/i.test(page)
  ? pass('the page says there is no list to be added to')
  : fail('the page no longer says there is no list', 'privacy.html still promises it');

// ------------------------------------------------------------- no honeypot
console.log('\nnothing invisible in the form');
// ⛔ A honeypot is a hidden field a bot is expected to fill and a human is not.
// Browsers autofill hidden fields, password managers fill them, and a real
// parent's submission gets thrown away as spam with no error and no trace. That
// has already happened once on another site of his and cost real signups.
const hidden = [...page.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)].map(m => m[0]);
const offscreen = /(?:left|top):\s*-\d{3,}px|visibility:\s*hidden|display:\s*none[^}]*}\s*[^{]*input/i.test(page);
hidden.length || offscreen
  ? fail('there is a hidden field in the form', `${hidden.join(' ') || 'an off-screen input'} — autofill fills these and the real parent is the one thrown away`)
  : pass('no hidden field for autofill to fill', 'spam is handled by refusing nonsense, never by a trap a human can fall into');

// ------------------------------------------------------- store, then email
console.log('\na question cannot be lost by an email going astray');
const insertAt = api.indexOf("/rest/v1/questions");
const emailAt = api.indexOf('sendEmail(');
insertAt > -1 && emailAt > -1 && insertAt < emailAt
  ? pass('the row is written before the email is sent')
  : fail('the email happens before the row exists', 'a bad minute at the email provider becomes a family who thinks they were ignored');

// The reply to the parent must not be conditional on the send. She is told it
// arrived because it arrived.
/if \(row && row\.id\)[\s\S]*?status\(200\)/.test(api) || api.indexOf('status(200)') > emailAt
  ? pass('she is told it arrived whether or not the email went out')
  : fail('the 200 depends on the email succeeding');

/replyTo: email/.test(api)
  ? pass('answering it is a reply, not a copy-paste')
  : warn('the email does not set reply-to', 'he has to copy her address out by hand');

/emailed_at|email_error/.test(api) && /emailed_at/.test(sql)
  ? pass('the row records whether the email actually went')
  : fail('nothing records a failed send', 'the question would sit in a table nobody knows to look at');

// ------------------------------------------------------------ fail closed
console.log('\nit fails closed and says which file');
/supabase-setup-4\.sql/.test(api) && /503/.test(api)
  ? pass('no table yet means 503 naming supabase-setup-4.sql', 'not a 500 that reads like the site is broken')
  : fail('the missing-table case does not name the file to run');
/42P01/.test(api)
  ? pass('it also catches the table being absent at the database', 'the env vars can be right while the migration has not been run')
  : warn('only the env vars are checked', 'a missing table would answer 500');
/lamont@kirtonlearning\.com/.test(page) && /lamont@kirtonlearning\.com/.test(api)
  ? pass('every dead end still hands her a real address')
  : fail('a failure leaves her with nowhere to go');

// ------------------------------------------------------------------ scope
console.log('\nSCOPE.md governs the field list, not just the copy');
let scope = '';
try { scope = read('SCOPE.md'); } catch { scope = ''; }
if (!scope) {
  warn('SCOPE.md is not on disk', 'it is gitignored; this check only runs on his machine');
} else {
  // The words that would make a form field a claim this business cannot make.
  // ★ Written behaviou?r rather than spelling both variants out: this file is
  // swept by verify/american-english.mjs like every other, and a gate that
  // lists a British spelling in order to ban it still contains one. A pattern
  // catches both and spells neither.
  const BANNED = /\b(behaviou?r|regulation|sensory|communication|speech|occupational therapy|counseling|diagnos\w+)\b/gi;
  const asked = [...page.matchAll(/<label[^>]*class="q"[^>]*>([\s\S]*?)<\/label>|<p class="hint">([\s\S]*?)<\/p>/g)]
    .map(m => (m[1] || m[2] || '').replace(/<[^>]*>/g, ' ')).join(' ');
  const hits = [...new Set(asked.match(BANNED) || [])];
  hits.length
    ? fail('a question or hint uses a word outside our scope', hits.join(', '))
    : pass('no question or hint asks about anything outside reading, writing and math');
}

// ------------------------------------------------------- the button works
console.log('\nthe button on the landing page goes somewhere that works');
/href="\/ask"[^>]*>Ask me a question first|Ask me a question first/.test(index) && /href="\/ask"/.test(index)
  ? pass('"Ask me a question first" points at /ask')
  : fail('the landing page button is not wired to /ask');
/href="mailto:[^"]*">Ask me a question first/.test(index)
  ? fail('it is a mailto: again', 'a mailto: does nothing on a phone with no mail app configured, and leaves no trace on either end')
  : pass('it is not a mailto: any more');

// ------------------------------------------------------------------- prod
if (PROD) {
  console.log('\nprod');
  const get = async (p, init) => { try { return await fetch(SITE + p, init); } catch (e) { return { status: 0, text: async () => String(e) }; } };

  const r = await get('/ask');
  r.status === 200 ? pass('/ask is served') : fail(`/ask answered ${r.status}`);

  const g = await get('/api/ask');
  g.status === 405 ? pass('GET /api/ask is refused', '405, so the endpoint is deployed and not guessing')
    : fail(`GET /api/ask answered ${g.status}`);

  const bad = await get('/api/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-address', message: 'hello' }),
  });
  const badBody = await bad.json().catch(() => ({}));
  if (bad.status === 503) warn('the table is not there yet', `run ${badBody.setup || 'supabase-setup-4.sql'} — until then the page tells her it is not open`);
  else bad.status === 400 ? pass('a malformed address is refused', badBody.message) : fail(`a malformed address answered ${bad.status}`);

  const empty = await get('/api/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'someone@example.com', message: '' }),
  });
  if (empty.status === 503) warn('the table is not there yet', 'the empty-question case could not be proven');
  else empty.status === 400 ? pass('an empty question is refused', 'nothing is stored') : fail(`an empty question answered ${empty.status}`);

  const sm = await (await get('/sitemap.xml')).text();
  /kirtonlearning\.com\/ask/.test(sm) ? pass('/ask is in the sitemap') : fail('/ask is indexable and not in the sitemap');
}

console.log(`\n${checks} passed, ${warnings} warnings, ${failures} failures\n`);
process.exit(failures ? 1 : 0);
