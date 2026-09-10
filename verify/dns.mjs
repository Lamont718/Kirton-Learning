// The DNS this domain has to have, written down, applied, and then PROVED from
// outside.
//
//   node verify/dns.mjs             check only — what is actually resolving
//   node verify/dns.mjs --apply     write the missing records at GoDaddy, then check
//
// Applying needs GODADDY_KEY and GODADDY_SECRET in the environment. They are
// never read from a file and never written to one.
//
// ★★ Why this exists as a file and not a checklist: sending and receiving are
// separate records that fail separately and silently. A verified sending domain
// still leaves the address without a mailbox; a mailbox that receives says
// nothing about whether anything can leave. Both have to be asserted, and the
// only honest assertion is a lookup from outside, not the panel's own screen.
//
// ⛔ This never touches the apex A record. That is Vercel's, the site is on it,
// and nothing about email needs it changed.

import { promises as dns } from 'node:dns';

const DOMAIN = 'kirtonlearning.com';
const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// What we want, and why each one is there
// ---------------------------------------------------------------------------
const WANT = [
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
  // ⚠️ These two records alone do NOT deliver anything. They hand the domain's
  // mail to ImprovMX, and ImprovMX drops it unless an alias exists there saying
  // where lamont@ goes. Records first is still right — mail bounces either way
  // until both halves are done, and ImprovMX will not verify the domain until
  // it can see its own MX.
  {
    type: 'MX', name: '@', ttl: 3600, priority: 10,
    data: 'mx1.improvmx.com',
    why: 'receives mail for the domain and forwards it on',
  },
  {
    type: 'MX', name: '@', ttl: 3600, priority: 20,
    data: 'mx2.improvmx.com',
    why: 'second one, so a single host being down is not a bounced IEP question',
    sibling: true, // same type+name as the record above; written together, not twice
  },
  {
    type: 'TXT', name: '@', ttl: 3600,
    data: 'v=spf1 include:spf.improvmx.com ~all',
    why: 'lets the forwarder re-send without the forward being marked as spam',
  },
];

// ---------------------------------------------------------------------------
// GoDaddy
// ---------------------------------------------------------------------------
const KEY = process.env.GODADDY_KEY;
const SECRET = process.env.GODADDY_SECRET;

async function gd(path, init) {
  const r = await fetch(`https://api.godaddy.com${path}`, {
    ...init,
    headers: {
      Authorization: `sso-key ${KEY}:${SECRET}`,
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// PUT replaces every record of one type+name. That is the right verb here —
// each of these is a single-valued record and we want it to end up as exactly
// what is written above, not appended to whatever was there.
//
// ⚠️ Read first and skip if it already matches, so a re-run is a no-op instead
// of a rewrite. Rewriting is not harmless: it resets the TTL and, on a record
// somebody else edited by hand, silently discards their version.
async function apply() {
  if (!KEY || !SECRET) {
    console.log('  GODADDY_KEY / GODADDY_SECRET are not set — nothing applied.\n');
    return false;
  }

  const all = await gd(`/v1/domains/${DOMAIN}/records`, { method: 'GET' });
  if (!all.ok) {
    console.log(`  GoDaddy refused the read: ${all.status} ${JSON.stringify(all.body).slice(0, 220)}\n`);
    return false;
  }
  const existing = Array.isArray(all.body) ? all.body : [];
  console.log(`  GoDaddy has ${existing.length} records on ${DOMAIN}.`);

  // Say out loud what is already there on the apex, so nothing gets clobbered
  // without it being visible in the output.
  const apexA = existing.filter((r) => r.type === 'A' && r.name === '@');
  const apexMX = existing.filter((r) => r.type === 'MX' && r.name === '@');
  console.log(`  apex A: ${apexA.map((r) => r.data).join(', ') || 'none'} (left alone)`);
  console.log(`  apex MX: ${apexMX.map((r) => r.data).join(', ') || 'none — mail to this domain bounces'}\n`);

  // ⛔ PUT replaces EVERY record of one type+name, so the two apex MX records
  // have to go up in one call. Writing them one at a time would put mx1 up and
  // then delete it by writing mx2 — leaving a single point of failure in front
  // of the address parents are told to write to, and looking like it worked.
  const groups = new Map();
  for (const w of WANT) {
    const k = `${w.type}|${w.name}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }

  for (const [k, want] of groups) {
    const [type, name] = k.split('|');
    const have = existing.filter((r) => r.type === type && r.name === name);
    const norm = (s) => String(s).replace(/^"|"$/g, '');
    const same = have.length === want.length &&
      want.every((w) => have.some((h) => norm(h.data) === w.data));
    if (same) { console.log(`  = ${type} ${name} already correct`); continue; }

    const payload = want.map((w) => ({
      data: w.data, ttl: w.ttl, ...(w.priority ? { priority: w.priority } : {}),
    }));
    const put = await gd(`/v1/domains/${DOMAIN}/records/${type}/${encodeURIComponent(name)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    console.log(put.ok
      ? `  + ${type} ${name} written (${want.length} record${want.length > 1 ? 's' : ''})`
      : `  ! ${type} ${name} FAILED ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
  }
  console.log('');
  return true;
}

// ---------------------------------------------------------------------------
// Proving it, from outside
// ---------------------------------------------------------------------------
let pass = 0, fail = 0, warn = 0;
const ok = (n, d = '') => { pass++; console.log('  ok    ' + n + (d ? '  — ' + d : '')); };
const bad = (n, d = '') => { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };
const note = (n, d = '') => { warn++; console.log('  warn  ' + n + (d ? '\n        ' + d : '')); };

const flat = (rows) => rows.map((r) => (Array.isArray(r) ? r.join('') : String(r)));

async function check() {
  // Ask a public resolver, not the machine's — the panel and the world can
  // disagree for hours and only the world matters.
  dns.setServers(['8.8.8.8', '1.1.1.1']);

  // '@' means the domain itself, not a host called "@".
  const fqdn = (name) => (name === '@' ? DOMAIN : `${name}.${DOMAIN}`);

  console.log('Sending — can email leave as kirtonlearning.com?\n');

  const sending = WANT.filter((w) => w.name !== '@');
  const receiving = WANT.filter((w) => w.name === '@');

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
    // Every wanted MX must be present — checking that "some MX exists" would
    // pass with only one of the pair up, which is the exact failure the second
    // one is there to prevent.
    const mx = set.filter((x) => x.type === 'MX');
    for (const w of mx) {
      try {
        const rows = await dns.resolveMx(fqdn(w.name));
        rows.some((r) => r.exchange === w.data)
          ? ok(`MX ${w.name} ${w.data}`, w.why)
          : bad(`MX ${w.name} ${w.data} is missing`,
                `found: ${rows.map((r) => `${r.exchange} (${r.priority})`).join(', ') || '(none)'}`);
      } catch {
        bad(`MX ${w.name} ${w.data} is missing`, w.why);
      }
    }
  }

  await assertRecords(sending);

  // ★ The check that matters more than the three above: Resend's own verdict.
  // Three records resolving is not the same as Resend having verified them, and
  // it is Resend that decides whether an email actually goes.
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
    await assertRecords(receiving);
  }

  // ★★★ The records are half of it. Mail reaching ImprovMX with no alias behind
  // it is REJECTED, and from the DNS side that looks identical to working. This
  // cannot be proved from here — the only proof is sending a real message to the
  // address and watching it arrive in his Gmail.
  if (anyMx) {
    note('DNS cannot prove the forward actually delivers',
      'Send a test message to lamont@kirtonlearning.com from a phone and confirm it lands. ' +
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
