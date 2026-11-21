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
// only (STRIPE_READ_KEY: a restricted key with Customers, Subscriptions and Checkout Sessions read).
// Without it nothing is deleted at all — a family who is still paying losing
// their child's IEP is worse than one kept a little longer, and the run says so.
// If Stripe cannot be asked about one family, that family is skipped, not purged.
//
// Called by Vercel Cron (vercel.json) with `Authorization: Bearer CRON_SECRET`.
// By hand: header `x-admin-key` lists what WOULD go and deletes nothing, ever.

const { reject, supabase, secretEquals, sendEmail, filesOf, goneOk } = require('./_common');

const DAY = 24 * 60 * 60 * 1000;
const PLAN_YEAR = 36 * 7 * DAY;
const KEEP_AFTER = 365 * DAY;
const MARGIN = 7 * DAY;
// Paying, or about to retry a payment. Not 'incomplete' or 'unpaid': neither is a
// family paying, and counting them would keep a child's IEP forever.
const MEMBER = new Set(['active', 'trialing', 'past_due']);

// Questions asked from /ask (supabase-setup-4.sql). privacy.html: "Your email
// and contact details — until you ask me to remove them, or 24 months after our
// last contact". Last contact for an address = its latest question or answer.
// Until 2026-11-20 nothing deleted these at all.
const QUESTION_KEEP = 2 * 365 * DAY;

const at = (v) => (v ? Date.parse(v) || 0 : 0);

// The row's own dates decide. Exported for verify/purge.mjs.
function due(row, now) {
  const start = Math.max(at(row.created_at), at(row.used_at), at(row.intake_at));
  if (!start) return null;
  if (now > start + PLAN_YEAR + KEEP_AFTER + MARGIN) return 'all';
  if (row.kind === 'setup' && now > start + PLAN_YEAR + MARGIN) return 'shared';
  return null;
}

// true = still a member, false = not, null = could not tell (kept, and reported).
//
// ⛔ "Not found" must never mean "not a member". Stripe matches customers by email
// EXACTLY (case included), and a family may have paid with another address, so an
// empty search proves nothing. The row's own checkout session is asked first; the
// email is only a second way in, and a row with neither is a row we cannot clear.
// Ids of every question whose ADDRESS has had no contact for 24 months (+ the
// same week of margin). Grouped by address, so one recent question keeps that
// person's older ones too. Exported for verify/purge.mjs.
function questionsDue(rows, now) {
  const last = new Map();
  for (const q of rows) {
    const e = String(q.email || '').trim().toLowerCase();
    const t = Math.max(at(q.asked_at), at(q.answered_at));
    last.set(e, Math.max(last.get(e) || 0, t));
  }
  return rows
    .filter((q) => {
      const t = last.get(String(q.email || '').trim().toLowerCase()) || 0;
      return t && now > t + QUESTION_KEEP + MARGIN;
    })
    .map((q) => q.id);
}

async function isMember(row, key) {
  const stripe = async (path) => {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };
  const subsOf = async (customer) =>
    (await stripe(`subscriptions?status=all&limit=100&customer=${encodeURIComponent(customer)}`)).data || [];
  try {
    const customers = new Set();
    let session = null;
    if (row.stripe_session_id) {
      session = await stripe(`checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
      if (session.customer) customers.add(String(session.customer));
    }
    const email = String(row.parent_email || '').trim();
    if (email) {
      for (const e of new Set([email, email.toLowerCase()])) {
        for (const cu of (await stripe(`customers?limit=100&email=${encodeURIComponent(e)}`)).data || []) customers.add(cu.id);
      }
    }
    for (const c of customers) {
      if ((await subsOf(c)).some((x) => MEMBER.has(x.status))) return true;
    }
    if (session && session.subscription) {
      const sub = await stripe(`subscriptions/${encodeURIComponent(String(session.subscription))}`);
      if (MEMBER.has(sub.status)) return true;
    }
    // Cleared only when we actually saw this family's purchase: its own session,
    // or a customer record under its address. Otherwise we do not know.
    return session || customers.size ? false : null;
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

  // ⛔ By hand is ALWAYS a dry run. Only the schedule deletes, so the admin key —
  // which sits in a browser — can never be the thing that erases families.
  const dry = !byCron;

  const rest = supabase();
  if (!rest) return reject(res, 503, 'Supabase is not configured.');

  const r = await rest(
    '/rest/v1/upload_tokens?select=token,kind,parent_email,stripe_session_id,created_at,used_at,intake_at,object_path&limit=10000',
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
    const cacheKey = `${String(row.parent_email || '').toLowerCase()}|${row.stripe_session_id || ''}`;
    if (!memberCache.has(cacheKey)) memberCache.set(cacheKey, await isMember(row, stripeKey));
    const m = memberCache.get(cacheKey);
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
      if (!(await goneOk(sh))) { out.errors++; continue; }
      if (what === 'shared') {
        // Storage answers 200 with the objects it removed; [] means there was nothing.
        const gone = sh.ok ? await sh.json().catch(() => []) : [];
        if (Array.isArray(gone) && gone.length) out.sharedRemoved++;
        continue;
      }
    }
    let files;
    try { files = await filesOf(rest, row); } catch { out.errors++; continue; }
    if (files.length) {
      const f = await rest('/storage/v1/object/ieps', {
        method: 'DELETE',
        body: JSON.stringify({ prefixes: files }),
      }).catch(() => null);
      if (!(await goneOk(f))) { out.errors++; continue; }
    }
    // The intake answers go with the row (on delete cascade, supabase-setup-3.sql).
    const del = await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(row.token)}`, {
      method: 'DELETE',
    }).catch(() => null);
    if (!del || !del.ok) { out.errors++; continue; }
    out.deleted++;
  }

  // ---- questions from /ask: 24 months after the last contact ----
  // Not held for STRIPE_READ_KEY: a question is not a purchase, and a paying
  // family's address is kept on their own row by the rules above.
  out.questionsDeleted = 0;
  const qr = await rest('/rest/v1/questions?select=id,email,asked_at,answered_at&limit=10000', { method: 'GET' })
    .catch(() => null);
  if (qr && qr.ok) {
    const qs = await qr.json().catch(() => []);
    const ids = questionsDue(Array.isArray(qs) ? qs : [], now);
    if (ids.length) {
      if (dry) out.questionsDeleted = ids.length;
      else {
        // In batches, so the URL stays well under any length limit.
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          const d = await rest(`/rest/v1/questions?id=in.(${batch.map(encodeURIComponent).join(',')})`, { method: 'DELETE' })
            .catch(() => null);
          if (d && d.ok) out.questionsDeleted += batch.length; else out.errors++;
        }
      }
    }
  } else if (!(qr && qr.status === 404)) {
    // 404 = the table was never made (supabase-setup-4.sql not run): nothing to keep.
    out.errors++;
  }

  if (out.held) out.needs = 'STRIPE_READ_KEY';

  // Tell him when something happened or is stuck. Counts only — nothing about any family.
  if (!dry && (out.deleted || out.sharedRemoved || out.questionsDeleted || out.errors || out.held || out.unknown)) {
    await sendEmail({
      to: process.env.ALERT_TO || process.env.FORWARD_TO,
      subject: 'Kirton Learning — the daily retention run',
      text: [
        `Deleted at the end of the retention period: ${out.deleted}`,
        `Shared copies removed at the end of the plan year: ${out.sharedRemoved}`,
        `Kept because the family is still on the monthly plan: ${out.member}`,
        `Questions from /ask deleted, 24 months after the last contact: ${out.questionsDeleted}`,
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
module.exports.questionsDue = questionsDue;
module.exports.isMember = isMember;
