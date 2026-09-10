// POST /api/admin
//
// The back office. Before this, issuing a link meant opening the Supabase SQL
// editor and writing an INSERT by hand at nine at night, and answering "did she
// ever get it?" meant guessing.
//
// Actions: list · issue · resend · reissue · revoke
//
// Locked by ADMIN_KEY, a shared secret in the Vercel env, sent as a header. Not
// a login: there is exactly one person on this side and a password table for one
// person is more attack surface than it removes. If a second person ever needs
// access, this becomes real auth — do not hand out the key.

const {
  reject, supabase, parseJson, secretEquals, sendEmail, uploadLink, siteOrigin,
} = require('./_common');
const { iepLinkEmail, recordLinkEmail } = require('./_email');

// Every column the admin page shows. `token` is in here on purpose: it lets him
// copy a working link and hand it over another way when email is down — which,
// while kirtonlearning.com has no MX record, is every time.
const COLUMNS =
  'token,parent_email,child_label,kind,plan,issued_by,created_at,expires_at,' +
  'used_at,object_path,sent_at,send_count,revoked_at,stripe_session_id';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the row means, worked out in one place so the page and the API can never
// disagree about whether a link is alive.
function statusOf(row) {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  if (!row.sent_at) return 'unsent';
  return 'live';
}

function decorate(row) {
  return { ...row, status: statusOf(row), link: uploadLink(row.token, row.kind) };
}

async function mailFor(row, name, why) {
  const link = uploadLink(row.token, row.kind);
  return row.kind === 'record'
    ? recordLinkEmail({ link, name, why })
    : iepLinkEmail({ link, name });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed.');

  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY) return reject(res, 503, 'ADMIN_KEY is not set, so this page is closed.');

  const given = req.headers['x-admin-key'];
  if (!secretEquals(String(given || ''), ADMIN_KEY)) {
    await sleep(500); // slow a guesser down; there is no state here to count with
    return reject(res, 401, 'Not authorized.');
  }

  const rest = supabase();
  if (!rest) return reject(res, 503, 'Supabase is not configured.');

  const body = parseJson(req);
  if (!body) return reject(res, 400, 'Body is not JSON.');
  const action = String(body.action || '');

  const oneRow = async (token) => {
    const r = await rest(
      `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}&select=${COLUMNS}`,
      { method: 'GET' }
    );
    if (!r.ok) return { error: `Could not read that token (${r.status}).` };
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? { row } : { error: 'No token with that id.' };
  };

  try {
    // -----------------------------------------------------------------------
    // What is actually wired up, right now, on the deployment answering this
    // request. Written because a variable NAME proves nothing: a var can exist
    // and hold an empty string, and every screen that lists names rather than
    // testing behaviour will call that configured.
    //
    // ⛔ Booleans only. MAIL_FROM is the exception and is not a secret — it is
    // the From line printed on every email a parent receives.
    if (action === 'status') {
      const probe = await rest('/rest/v1/upload_tokens?select=kind,revoked_at&limit=1', { method: 'GET' });
      let mailReady = false;
      if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
        // Ask the provider whether the domain in MAIL_FROM can actually send.
        // A key that authenticates is not a domain that is verified, and the
        // difference is every email silently 403ing.
        try {
          const dom = (String(process.env.MAIL_FROM).match(/@([^>\s]+)/) || [])[1];
          const r = await fetch('https://api.resend.com/domains', {
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          });
          if (r.ok && dom) {
            const list = await r.json();
            const rows = Array.isArray(list) ? list : list.data || [];
            mailReady = rows.some((d) => d.name === dom && d.status === 'verified');
          }
        } catch { /* leave it false — unproven is not ready */ }
      }
      // Does the apex have anywhere to deliver mail to?
      // ⚠️ Reported as a HOST LIST, never as a boolean "receiving works". MX
      // records with nothing behind them are a destination that refuses every
      // message, and that is invisible from here — the same false green the
      // site audit was about to start showing.
      let apexMx = [];
      try {
        const dns = require('node:dns').promises;
        dns.setServers(['8.8.8.8', '1.1.1.1']);
        apexMx = (await dns.resolveMx('kirtonlearning.com')).map((r) => r.exchange);
      } catch { apexMx = []; }

      return res.status(200).json({
        ok: true,
        supabase: true, // we would not have got here otherwise
        migrated: probe.ok,
        apexMx,
        stripeWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
        resendKey: !!process.env.RESEND_API_KEY,
        mailFrom: process.env.MAIL_FROM || null,
        mailReady,
        origin: siteOrigin(),
      });
    }

    // -----------------------------------------------------------------------
    if (action === 'list') {
      const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
      const r = await rest(
        `/rest/v1/upload_tokens?select=${COLUMNS}&order=created_at.desc&limit=${limit}`,
        { method: 'GET' }
      );
      if (!r.ok) {
        // The most likely cause by a distance: supabase-setup-2.sql has not been
        // run, so half these columns do not exist yet. Say that, rather than
        // making him read a PostgREST error.
        return reject(res, 502,
          `Could not read the list (${r.status}). If this is the first time: run ` +
          'supabase-setup-2.sql in the Supabase SQL editor.');
      }
      const rows = await r.json();
      return res.status(200).json({ ok: true, rows: rows.map(decorate) });
    }

    // -----------------------------------------------------------------------
    if (action === 'issue') {
      const email = String(body.email || '').trim();
      const kind = body.kind === 'record' ? 'record' : 'iep';
      const childLabel = String(body.childLabel || '').trim().slice(0, 60) || null;
      const name = String(body.name || '').trim().slice(0, 40) || null;
      const why = String(body.why || '').trim().slice(0, 120) || null;
      const send = body.send !== false;

      if (!EMAIL_RE.test(email) || email.length > 200) {
        return reject(res, 400, 'That does not look like an email address.');
      }
      // child_label is a FIRST NAME ONLY — supabase-setup.sql says so and it is
      // the difference between a label and a record about a child.
      if (childLabel && /\s/.test(childLabel)) {
        return reject(res, 400, 'Child label is a first name only — no spaces.');
      }

      const insert = await rest('/rest/v1/upload_tokens', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          parent_email: email,
          child_label: childLabel,
          kind,
          issued_by: 'admin',
        }),
      });
      if (!insert.ok) return reject(res, 502, `Could not create the token (${insert.status}).`);
      const rows = await insert.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row || !row.token) return reject(res, 502, 'Token row came back empty.');

      if (!send) {
        const back = await oneRow(row.token);
        return res.status(200).json({ ok: true, row: decorate(back.row || row), sent: false });
      }

      const mail = await mailFor(row, name, why);
      const out = await sendEmail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
      if (out.ok) {
        await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(row.token)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sent_at: new Date().toISOString(), send_count: 1 }),
        });
      }

      const back = await oneRow(row.token);
      // ★ The link is returned either way. A token that exists and could not be
      // emailed is still a working link he can hand over another way — and the
      // page has to say plainly that the email did NOT go, not quietly succeed.
      return res.status(200).json({
        ok: true,
        row: decorate(back.row || row),
        sent: out.ok,
        sendError: out.ok ? null : out.error,
      });
    }

    // -----------------------------------------------------------------------
    // Same link, sent again. For "it went to spam" — not for a dead link.
    if (action === 'resend') {
      const token = String(body.token || '');
      if (!UUID_RE.test(token)) return reject(res, 400, 'That is not a token.');

      const got = await oneRow(token);
      if (got.error) return reject(res, 404, got.error);
      const row = got.row;

      const status = statusOf(row);
      if (status !== 'live' && status !== 'unsent') {
        return reject(res, 409, `That link is ${status}. Use Reissue to make a fresh one.`);
      }

      const mail = await mailFor(row, String(body.name || '').trim() || null, String(body.why || '').trim() || null);
      const out = await sendEmail({
        to: row.parent_email, subject: mail.subject, text: mail.text, html: mail.html,
      });
      if (!out.ok) return reject(res, 502, `Did not send: ${out.error}`);

      await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sent_at: new Date().toISOString(),
          send_count: (Number(row.send_count) || 0) + 1,
        }),
      });
      const back = await oneRow(token);
      return res.status(200).json({ ok: true, row: decorate(back.row || row), sent: true });
    }

    // -----------------------------------------------------------------------
    // Kill the old one, make a fresh one for the same family. For "the link
    // expired" and "the link says it was already used" — the two things the
    // rejection messages in upload-url.js actually tell a parent to email about.
    if (action === 'reissue') {
      const token = String(body.token || '');
      if (!UUID_RE.test(token)) return reject(res, 400, 'That is not a token.');

      const got = await oneRow(token);
      if (got.error) return reject(res, 404, got.error);
      const old = got.row;

      if (!old.revoked_at && !old.used_at) {
        await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}`, {
          method: 'PATCH',
          body: JSON.stringify({ revoked_at: new Date().toISOString() }),
        });
      }

      const insert = await rest('/rest/v1/upload_tokens', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          parent_email: old.parent_email,
          child_label: old.child_label,
          kind: old.kind,
          plan: old.plan,
          issued_by: 'admin',
          // ⛔ stripe_session_id is deliberately NOT copied. It is UNIQUE, so
          // copying it would fail — and it should: it records which payment the
          // ORIGINAL link came from, and there is only ever one of those.
        }),
      });
      if (!insert.ok) return reject(res, 502, `Could not create the replacement (${insert.status}).`);
      const rows = await insert.json();
      const row = Array.isArray(rows) ? rows[0] : rows;

      const mail = await mailFor(row, String(body.name || '').trim() || null, String(body.why || '').trim() || null);
      const out = await sendEmail({
        to: old.parent_email, subject: mail.subject, text: mail.text, html: mail.html,
      });
      if (out.ok) {
        await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(row.token)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sent_at: new Date().toISOString(), send_count: 1 }),
        });
      }
      const back = await oneRow(row.token);
      return res.status(200).json({
        ok: true, row: decorate(back.row || row), sent: out.ok, sendError: out.ok ? null : out.error,
      });
    }

    // -----------------------------------------------------------------------
    // Kill a link without losing the fact that it existed.
    if (action === 'revoke') {
      const token = String(body.token || '');
      if (!UUID_RE.test(token)) return reject(res, 400, 'That is not a token.');

      const r = await rest(
        `/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}&revoked_at=is.null`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ revoked_at: new Date().toISOString() }),
        }
      );
      if (!r.ok) return reject(res, 502, `Could not revoke that token (${r.status}).`);
      const back = await oneRow(token);
      if (back.error) return reject(res, 404, back.error);
      return res.status(200).json({ ok: true, row: decorate(back.row) });
    }

    // -----------------------------------------------------------------------
    // Erase it: the uploaded document AND the row.
    //
    // Not tidying — privacy.html promises a family their child's document is
    // "deleted on request", and until this existed there was no way to keep that
    // promise short of opening the Supabase dashboard by hand.
    //
    // ⛔ The FILE goes first. If the row went first and the object delete then
    // failed, the document would still be sitting in the bucket with nothing
    // left pointing at it — undeletable through this screen and invisible on it.
    // Losing the pointer to a child's IEP is worse than failing loudly.
    if (action === 'delete') {
      const token = String(body.token || '');
      if (!UUID_RE.test(token)) return reject(res, 400, 'That is not a token.');

      const got = await oneRow(token);
      if (got.error) return reject(res, 404, got.error);
      const row = got.row;

      if (row.object_path) {
        // ⚠️ The BULK form, with the path in a JSON body — not
        // `DELETE /object/ieps/<path>`. The single-object route answers 400 when
        // it is sent a JSON content-type with no body, which is exactly what a
        // shared REST helper does. Found by trying it: the delete failed, the
        // guard below correctly refused to orphan the file, and the 400 said
        // nothing about why until the provider's own message was surfaced.
        const gone = await rest('/storage/v1/object/ieps', {
          method: 'DELETE',
          body: JSON.stringify({ prefixes: [row.object_path] }),
        });
        // 404 means it is already not there, which is the state we want.
        if (!gone.ok && gone.status !== 404) {
          let why = '';
          try { why = JSON.stringify(await gone.json()).slice(0, 160); } catch { /* not json */ }
          return reject(res, 502,
            `The row was left alone because the file could not be deleted (${gone.status}). ` +
            `Nothing has been removed. ${why}`);
        }
      }

      const del = await rest(`/rest/v1/upload_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: 'DELETE',
      });
      if (!del.ok) {
        return reject(res, 502,
          `The file is deleted but the row could not be removed (${del.status}). ` +
          'The row now points at nothing — delete it in Supabase.');
      }

      return res.status(200).json({ ok: true, deleted: token, fileRemoved: !!row.object_path });
    }

    return reject(res, 400, 'Unknown action.');
  } catch (err) {
    return reject(res, 500, 'Something went wrong on my end.');
  }
};
