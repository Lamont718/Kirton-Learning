// GET /api/purge — the retention promise in privacy.html, run every day.
//
// privacy.html has said since launch that a child's IEP and the intake answers
// are "deleted automatically" 12 months after the plan year ends, and that work
// shared from the app goes "at the end of the plan year". Until 2026-10-13
// nothing did either: every uploaded IEP would have been kept forever. Lamont's
// call that day: count from the family's own dates, and never touch a family
// that is still paying for the monthly plan.
//
// "Plan year" is defined on the privacy page as the 36 weeks the Blueprint
// covers. It starts once the IEP is in, so a row's START is the latest thing
// that happened on it (issued, uploaded, intake answered), and:
//   · shared work is deleted at START + 36 weeks
//   · everything else — the file, the intake answers, the setup, the row — at
//     START + 36 weeks + 12 months, exactly what the desk's Delete does.
// A week of margin on both, because the Blueprint lands a few days after the
// upload and deleting before the promised date is also breaking the promise.
//
// ⛔ A FAMILY STILL ON THE MONTHLY PLAN IS NEVER PURGED. That needs Stripe, read
// only (STRIPE_READ_KEY: a restricted key with Customers and Subscriptions read).
// Without it nothing is deleted at all — a family who is still paying losing
// their child's IEP is worse than one kept a little longer, and the run says so.
// If Stripe cannot be asked about one family, that family is skipped, not purged.
//
// Called by Vercel Cron (vercel.json) with `Authorization: Bearer CRON_SECRET`.
// By hand: header `x-admin-key` and `?dry=1` lists what WOULD go, deleting nothing.

const { reject, supabase, secretEquals, sendEmail } = require('./_common');

const DAY = 24 * 60 * 60 * 1000;
const PLAN_YEAR = 36 * 7 * DAY;
const KEEP_AFTER = 365 * DAY;
const MARGIN = 7 * DAY;
const MEMBER = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

const at = (v) => (v ? Date.parse(v) || 0 : 0);

// The row's own dates decide. Exported for verify/purge.mjs.
function due(row, now) {
  const start = Math.max(at(row.created_at), at(row.used_at), at(row.intake_at));
  if (!start) return null;
  if (now > start + PLAN_YEAR + KEEP_AFTER + MARGIN) return 'all';
  if (row.kind === 'setup' && now > start + PLAN_YEAR + MARGIN) return 'shared';
  return null;
}

// true = still a member, false = not, null = could not tell (treated as member).
async function isMember(email, key) {
  const stripe = (path) => fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  try {
    const c = await stripe(`customers?limit=20&email=${encodeURIComponent(email)}`);
    if (!c.ok) return null;
    const customers = (await c.json()).data || [];
    for (const cu of customers) {
      const s = await stripe(`subscriptions?status=all&limit=20&customer=${encodeURIComponent(cu.id)}`);
      if (!s.ok) return null;
      if (((await s.json()).data || []).some((x) => MEMBER.has(x.status))) return true;
    }
    return false;
  } catch {
    return null;
  }
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return reject(res, 405, 'GET only.');

  const cron = process.env.CRON_SECRET;
  const admin = process.env.ADMIN_KEY;
  const bearer = String(req.headers.authorization || '');
  const byCron = !!cron && secretEquals(bearer, `Bearer ${cron}`);
  const byHand = !!admin && secretEquals(String(req.headers['x-admin-key'] || ''), admin);
  if (!byCron && !byHand) return reject(res, 401, 'Not allowed.');

  const dry = byHand && /(^|[?&])dry=1(&|$)/.test(String(req.url || '').split('?')[1] || '');

  const rest = supabase();
  if (!rest) return reject(res, 503, 'Supabase is not configured.');

  const r = await rest(
    '/rest/v1/upload_tokens?select=token,kind,parent_email,created_at,used_at,intake_at,object_path&limit=10000',
    { method: 'GET' },
  );
  if (!r.ok) return reject(res, 502, `Could not read the tokens (${r.status}).`);
  const rows = await r.json();

  const now = Date.now();
  const stripeKey = process.env.STRIPE_READ_KEY || '';
  const out = { ok: true, dry, checked: rows.length, due: 0, deleted: 0, sharedRemoved: 0, member: 0, unknown: 0, held: 0, errors: 0 };
  const memberCache = new Map();

  for (const row of rows) {
    const what = due(row, now);
    if (!what) continue;
    out.due++;

    if (!stripeKey) { out.held++; continue; }
    const email = String(row.parent_email || '').toLowerCase();
    if (!memberCache.has(email)) memberCache.set(email, email ? await isMember(email, stripeKey) : null);
    const m = memberCache.get(email);
    if (m === true) { out.member++; continue; }
    if (m === null) { out.unknown++; continue; }
    if (dry) { what === 'all' ? out.deleted++ : out.sharedRemoved++; continue; }

    // Same order as the desk's Delete (api/admin.js): files first, row last, so
    // a failure never leaves a child's document with nothing pointing at it.
    // ⚠️ The BULK delete form — the single-object route 400s on this helper.
    if (row.kind === 'setup') {
      const sh = await rest('/storage/v1/object/shared', {
        method: 'DELETE',
        body: JSON.stringify({ prefixes: [`${row.token}.json`] }),
      }).catch(() => null);
      if (!sh || (!sh.ok && sh.status !== 404 && sh.status !== 400)) { out.errors++; continue; }
      if (what === 'shared') {
        // Storage answers 200 with the objects it removed; [] means there was nothing.
        const gone = sh.ok ? await sh.json().catch(() => []) : [];
        if (Array.isArray(gone) && gone.length) out.sharedRemoved++;
        continue;
      }
    }
    if (row.object_path) {
      const f = await rest('/storage/v1/object/ieps', {
        method: 'DELETE',
        body: JSON.stringify({ prefixes: [row.object_path] }),
      }).catch(() => null);
      if (!f || (!f.ok && f.status !== 404)) { out.errors++; continue; }
    }
    // The intake answers go with the row (on delete cascade, supabase-setup-3.sql).
    const del = await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(row.token)}`, {
      method: 'DELETE',
    }).catch(() => null);
    if (!del || !del.ok) { out.errors++; continue; }
    out.deleted++;
  }

  if (out.held) out.needs = 'STRIPE_READ_KEY';

  // Tell him when something happened or is stuck. Counts only — nothing about any family.
  if (!dry && (out.deleted || out.sharedRemoved || out.errors || out.held || out.unknown)) {
    await sendEmail({
      to: process.env.ALERT_TO || process.env.FORWARD_TO,
      subject: 'Kirton Learning — the daily retention run',
      text: [
        `Deleted at the end of the retention period: ${out.deleted}`,
        `Shared copies removed at the end of the plan year: ${out.sharedRemoved}`,
        `Kept because the family is still on the monthly plan: ${out.member}`,
        out.unknown ? `Kept because Stripe could not be asked: ${out.unknown}` : null,
        out.held ? `⛔ Kept because STRIPE_READ_KEY is not set in Vercel: ${out.held}. Nothing is deleted until it is.` : null,
        out.errors ? `⛔ Failed, left in place: ${out.errors}. Check the desk.` : null,
      ].filter(Boolean).join('\n'),
    }).catch(() => {});
  }

  return res.status(200).json(out);
}

module.exports = handler;
module.exports.due = due;
