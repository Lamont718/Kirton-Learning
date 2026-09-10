// The DNS this domain has to have, written down, applied, and then PROVED from
// outside.
//
//   node verify/dns.mjs             check only — what is actually resolving
//   node verify/dns.mjs --apply     add the missing records at GoDaddy, then check
//
// Applying needs GODADDY_PAT in the environment — a Personal Access Token from
// https://developer.godaddy.com/personal-access-token. It is never read from a
// file and never written to one.
//
// ⚠️ The old developer Key/Secret pair (`Authorization: sso-key KEY:SECRET`) and
// its OTE/Production choice are GONE from the dashboard. GoDaddy moved to PATs,
// and the classic key does not work against the v3 Domains API at all. If a guide
// tells you to pick an environment, it is describing the retired flow.
//
// ★★ Why this exists as a file and not a checklist: sending and receiving are
// separate records that fail separately and silently. A verified sending domain
// still leaves the address without a mailbox; a mailbox that receives says
// nothing about whether anything can leave. Both have to be asserted, and the
// only honest assertion is a lookup from outside, not the panel's own screen.
//
// ⛔ This adds records. It never deletes or overwrites one. Anything unexpected
// already in the zone is REPORTED for a person to decide about — silently
// rewriting somebody's DNS is not a thing a script gets to do.

import { promises as dns } from 'node:dns';

const DOMAIN = 'kirtonlearning.com';
const APPLY = process.argv.includes('--apply');
const API = 'https://api.godaddy.com/v3/domains';

// ---------------------------------------------------------------------------
// What we want, and why each one is there
// ---------------------------------------------------------------------------
const WANT = [
  // ---- sending: Resend, so the link email can leave and not land in spam ----
  {
    type: 'TXT', name: 'resend._domainkey', ttl: 3600,
    data: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCqk8DLpXV3sv7LPWvcb88S4m46zGhwZSZ0gYBDxNUTwfXeiW2d7t6CYbgZkSkUm8BXEWFZsCD92lK4GMaZHqVFn6JsBDUnofZKXMQ80PDu+hS3QqRs1XmKg5CkIVNMOFljojNGPL5xg8FqpVjHeLn9hNLWZxOoL9zLhg681+2J6QIDAQAB',
    why: 'DKIM — signs the mail Resend sends, so the link email is not spam',
  },
  {
    type: 'MX', name: 'send', ttl: 3600, priority: 10,
    data: 'feedback-smtp.us-east-1.amazonses.com',
    why: 'bounce feedback for Resend. On the `send` subdomain, NOT the apex — it does not receive your mail',
  },
  {
    type: 'TXT', name: 'send', ttl: 3600,
    data: 'v=spf1 include:amazonses.com ~all',
    why: 'SPF for the sending subdomain',
  },

  // ---- receiving: forwarding to his Gmail, chosen 2026-09-09 ----
  //
  // ⚠️ These records alone do NOT deliver anything. They hand the domain's mail
  // to ImprovMX, and ImprovMX REJECTS it unless an alias exists there saying
  // where lamont@ goes. Records first is still right — mail bounces either way
  // until both halves are done, and ImprovMX will not verify the domain until it
  // can see its own MX.
  {
    type: 'MX', name: '@', ttl: 3600, priority: 10,
    data: 'mx1.improvmx.com',
    why: 'receives mail for the domain and forwards it on',
  },
  {
    type: 'MX', name: '@', ttl: 3600, priority: 20,
    data: 'mx2.improvmx.com',
    why: 'second one, so a single host being down is not a bounced IEP question',
  },
  {
    type: 'TXT', name: '@', ttl: 3600,
    data: 'v=spf1 include:spf.improvmx.com ~all',
    why: 'lets the forwarder re-send without the forward being marked as spam',
  },
];

// ---------------------------------------------------------------------------
// GoDaddy v3
// ---------------------------------------------------------------------------
const PAT = process.env.GODADDY_PAT;

async function gd(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init && init.headers),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// v3 filters server-side by type and name, so each question is asked as its own
// small request. That sidesteps the paginated collection entirely — no chance of
// reading page one, not seeing a record, and adding a duplicate of it.
async function recordsAt(type, name) {
  const q = `?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`;
  const r = await gd(`/zones/${encodeURIComponent(DOMAIN)}/dns-records${q}`, { method: 'GET' });
  if (!r.ok) return { error: `${r.status} ${JSON.stringify(r.body).slice(0, 200)}` };
  const items = (r.body && r.body.items) || [];
  return { items };
}

const unquote = (s) => String(s == null ? '' : s).replace(/^"|"$/g, '').replace(/\.$/, '');

async function apply() {
  if (!PAT) {
    console.log('  GODADDY_PAT is not set — nothing applied.');
    console.log('  Make one at https://developer.godaddy.com/personal-access-token\n');
    return;
  }

  // Say out loud what is on the apex BEFORE touching anything. The A record is
  // Vercel's and the site is on it; nothing about email needs it moved, and it
  // should be visible in the output that it was not.
  const a = await recordsAt('A', '@');
  if (a.error) {
    console.log(`  GoDaddy refused the read: ${a.error}`);
    console.log('  A 401 means the token is wrong or expired. A 403 means the token is real');
    console.log('  but lacks the DNS scope, or the account is not entitled to the API.\n');
    return;
  }
  console.log(`  apex A: ${a.items.map((r) => r.data).join(', ') || 'none'}  (left alone)`);

  for (const w of WANT) {
    const found = await recordsAt(w.type, w.name);
    if (found.error) { console.log(`  ! ${w.type} ${w.name} read failed — ${found.error}`); continue; }

    if (found.items.some((r) => unquote(r.data) === unquote(w.data))) {
      console.log(`  = ${w.type} ${w.name} already correct`);
      continue;
    }

    // Anything else sitting at this type+name is somebody's decision, not a
    // stale artefact to clean up. Name it and leave it.
    const others = found.items.filter((r) => unquote(r.data) !== unquote(w.data));
    if (others.length && w.type !== 'MX') {
      console.log(`  ? ${w.type} ${w.name} already holds: ${others.map((r) => unquote(r.data)).join(' | ')}`);
      console.log('    Adding ours alongside it. Two SPF records on one name is invalid —');
      console.log('    if the line above is an SPF record, one of them has to go, by hand.');
    }

    const post = await gd(`/zones/${encodeURIComponent(DOMAIN)}/dns-records`, {
      method: 'POST',
      body: JSON.stringify({
        name: w.name, type: w.type, data: w.data, ttl: w.ttl,
        ...(w.priority !== undefined ? { priority: w.priority } : {}),
      }),
    });
    console.log(post.ok
      ? `  + ${w.type} ${w.name} added`
      : `  ! ${w.type} ${w.name} FAILED ${post.status} ${JSON.stringify(post.body).slice(0, 200)}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Proving it, from outside
// ---------------------------------------------------------------------------
let pass = 0, fail = 0, warn = 0;
const ok = (n, d = '') => { pass++; console.log('  ok    ' + n + (d ? '  — ' + d : '')); };
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };
const note = (n, d = '') => { warn++; console.log('  warn  ' + n + (d ? '\n        ' + d : '')); };

const flat = (rows) => rows.map((r) => (Array.isArray(r) ? r.join('') : String(r)));
const fqdn = (name) => (name === '@' ? DOMAIN : `${name}.${DOMAIN}`);

async function assertRecords(set) {
  for (const w of set.filter((x) => x.type === 'TXT')) {
    try {
      const rows = flat(await dns.resolveTxt(fqdn(w.name)));
      const hit = rows.find((r) => r.includes(w.data.slice(0, 40)));
      hit ? ok(`TXT ${w.name}`, w.why)
          : bad(`TXT ${w.name} is wrong`, `found: ${rows.join(' | ') || '(none)'}`);
    } catch {
      bad(`TXT ${w.name} is missing`, w.why);
    }
  }
  // Every wanted MX must be present. Checking that "some MX exists" would pass
  // with only one of a pair up — which is the exact failure the second one is
  // there to prevent.
  //
  // ⛔ ONE lookup per NAME, then check every wanted record against that single
  // answer. Asking once per wanted record made the pair's verdict depend on two
  // different queries, and a transient partial answer to the second one reported
  // "mx2 is missing" while mx2 was demonstrably in the zone and served by three
  // public resolvers. A flaky check is worse than no check: it teaches you to
  // ignore the output, which is the whole value of having it.
  const mxNames = [...new Set(set.filter((x) => x.type === 'MX').map((x) => x.name))];
  for (const name of mxNames) {
    let rows = [];
    try { rows = await dns.resolveMx(fqdn(name)); } catch { rows = []; }
    const found = rows.map((r) => `${r.exchange} (${r.priority})`).join(', ') || '(none)';
    for (const w of set.filter((x) => x.type === 'MX' && x.name === name)) {
      rows.some((r) => r.exchange === w.data)
        ? ok(`MX ${w.name} ${w.data}`, w.why)
        : bad(`MX ${w.name} ${w.data} is missing`, `found: ${found}`);
    }
  }
}

async function check() {
  // Ask public resolvers, not the machine's — the panel and the world can
  // disagree for hours, and only the world matters.
  dns.setServers(['8.8.8.8', '1.1.1.1']);

  console.log('Sending — can email leave as kirtonlearning.com?\n');
  await assertRecords(WANT.filter((w) => w.name !== '@'));

  // ★ The check that matters more than the three above: Resend's own verdict.
  // Three records resolving is not the same as Resend having verified them, and
  // it is Resend that decides whether an email actually goes.
  //
  // ⛔⛔ READ ONLY. Do NOT call POST /domains/{id}/verify from a polling loop.
  // Each call RESETS every record to "pending" and re-queues the check — so a
  // loop that triggers on every pass restarts the work it is waiting for and
  // never finishes. Observed here: two records had reached "verified", and
  // 41 polls later all three were back to "pending" because the poller kept
  // poking them. Trigger once by hand, then watch without touching.
  // ★★ The general shape: a watcher that acts on the thing it watches is not
  // observing it, it is driving it.
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      const list = await r.json();
      const rows = Array.isArray(list) ? list : list.data || [];
      const d = rows.find((x) => x.name === DOMAIN);
      if (!d) bad('Resend does not have this domain at all');
      else if (d.status === 'verified') ok('Resend says verified', 'email can actually leave');
      else note(`Resend says "${d.status}"`, 'records can resolve minutes before Resend re-checks them');
    } catch { note('could not reach Resend'); }
  } else {
    note('RESEND_API_KEY not in this shell', 'skipped the only check that proves sending works');
  }

  console.log('\nReceiving — can anyone write to lamont@kirtonlearning.com?\n');

  let anyMx = false;
  try { anyMx = (await dns.resolveMx(DOMAIN)).length > 0; } catch { anyMx = false; }

  if (!anyMx) {
    bad('apex has NO MX record — every mail to lamont@kirtonlearning.com bounces',
      'That address is printed on 18 lines across 9 pages, including partner.html and refer.html, ' +
      'which print it to be typed off paper. It is also what every rejection message in ' +
      'api/upload-url.js tells a parent to write to.');
  } else {
    await assertRecords(WANT.filter((w) => w.name === '@'));
    // ★★★ The records are half of it. Mail reaching ImprovMX with no alias behind
    // it is REJECTED, and from the DNS side that looks identical to working. This
    // cannot be proved from here.
    note('DNS cannot prove the forward actually delivers',
      'Send a message to lamont@kirtonlearning.com from a phone and confirm it lands in Gmail. ' +
      'Records with no alias behind them reject mail and look correct from out here.');
  }

  console.log(`\n  ${pass} passed, ${fail} failed, ${warn} warnings\n`);
  return fail;
}

// ---------------------------------------------------------------------------
console.log(`\nDNS — ${DOMAIN}${APPLY ? '  (applying)' : '  (checking only)'}\n`);
if (APPLY) await apply();
const failures = await check();
// ⚠️ Set the code, do not call process.exit(). Exiting while node's resolver
// still holds handles trips a libuv assertion on Windows, which prints a crash
// after a clean run and makes a passing check look like a broken script.
process.exitCode = failures ? 1 : 0;
