// POST /api/ask
// Body: { email, message, cameFrom }
//
// The landing page has had two buttons since launch. One is "Start with the
// Blueprint", which takes money. The other is "Ask me a question first", and
// until today it was a mailto: link — which on a phone with no mail app
// configured does nothing at all. No error, no draft, no send. The only route
// for a parent who is interested and not ready to spend $349 was a button that
// silently failed for an unknown share of the people who pressed it.
//
// ★ STORE FIRST, THEN EMAIL, and record the send on the row. A question that
// arrived and was lost to a bad minute at an email provider is a family who
// believes they were ignored — and the row is the only place that difference is
// visible afterwards. The answer to the parent does NOT depend on the email
// succeeding: once it is stored, she is told it arrived, because it did.
//
// ⛔ SCOPE.md governs the fields. An email address and whatever she chooses to
// write. Nothing asks about behavior, regulation, sensory or communication
// needs. We never ask; we never filter what she writes in her own words.

const { reject, supabase, parseJson, sendEmail } = require('./_common');

// Caps, not validation theater. Long enough to say the real thing on a phone at
// 10pm; short enough that a paste of the whole IEP is refused here rather than
// silently stored in a table that is not built for it.
const LIMITS = { email: 160, message: 4000, cameFrom: 60 };

// Deliberately loose. An address either routes or it does not, and no regex
// knows which — this refuses the obviously-not-an-address and nothing more.
// A parent mistyping her own email is a lost answer, so the page repeats it
// back to her rather than this trying to be clever.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return reject(res, 405, 'POST only.');

  const body = await parseJson(req);
  if (!body) return reject(res, 400, 'Nothing was sent.');

  const email = clean(body.email, LIMITS.email);
  // Not collapsed like the others: paragraphs are how people write when they
  // are explaining their child, and flattening that changes how it reads in
  // the inbox it lands in.
  const message = typeof body.message === 'string'
    ? body.message.trim().slice(0, LIMITS.message)
    : '';
  const cameFrom = clean(body.cameFrom, LIMITS.cameFrom);

  if (!EMAIL_RE.test(email)) return reject(res, 400, 'That email address does not look right. Check it and try again.');
  if (message.length < 2) return reject(res, 400, 'Add your question and send it again.');

  const rest = supabase();
  // Fail closed and SAY WHICH FILE. Until part 4 is run, this endpoint stores
  // nothing — and a question that is emailed but not stored is the exact thing
  // this design refuses to do.
  if (!rest) {
    return res.status(503).json({
      ok: false,
      setup: 'supabase-setup-4.sql',
      message: 'The form is not open yet. Email lamont@kirtonlearning.com and it will reach me.',
    });
  }

  const insert = await rest('/rest/v1/questions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ email, message, came_from: cameFrom || null }]),
  });

  if (!insert.ok) {
    const detail = await insert.text().catch(() => '');
    // 42P01 is "relation does not exist" — the migration has not been run.
    // Naming the file beats a 500 that reads like the site is broken.
    if (/42P01|does not exist/i.test(detail)) {
      return res.status(503).json({
        ok: false,
        setup: 'supabase-setup-4.sql',
        message: 'The form is not open yet. Email lamont@kirtonlearning.com and it will reach me.',
      });
    }
    return reject(res, 500, 'That did not send. Email lamont@kirtonlearning.com and it will reach me.');
  }

  const row = (await insert.json().catch(() => []))[0];

  // Now the email. It is allowed to fail: the question is already stored, and
  // the row carries what went wrong so /admin can show it. replyTo is her
  // address so answering is a reply, not a copy-paste.
  const sent = await sendEmail({
    to: process.env.MAIL_TO || process.env.MAIL_FROM,
    replyTo: email,
    subject: `Question from a parent — ${email}`,
    text: [
      `From: ${email}`,
      cameFrom ? `Asked from: ${cameFrom}` : null,
      '',
      message,
      '',
      '— Reply straight to this email; it goes back to her.',
    ].filter(Boolean).join('\n'),
  });

  if (row && row.id) {
    await rest(`/rest/v1/questions?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify(
        sent && sent.ok
          ? { emailed_at: new Date().toISOString() }
          : { email_error: String((sent && sent.error) || 'send failed').slice(0, 300) }
      ),
    }).catch(() => {});
  }

  // She is told it arrived because it arrived. Whether Resend had a good minute
  // is not her problem and is not her news.
  return res.status(200).json({ ok: true });
};
