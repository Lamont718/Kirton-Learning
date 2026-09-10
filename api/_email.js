// The two emails this system sends. Kept in one file so the words can be read
// without reading the plumbing around them.
//
// Read VOICE.md before changing a sentence here. The short version: the reader
// has been sold to badly before, specific beats warm, and a stated limit is more
// credible than a promise. No outcome claims. Nothing implying a licensed service.
//
// ⛔ These templates take an email address, a first name, and a link. They never
// take anything read out of an IEP or a record — see the note in _common.js.

const { siteOrigin } = require('./_common');

// A first name a parent typed goes into HTML. Escape it.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One plain frame for both emails. No images, no tracking pixel, no web fonts —
// it has to survive a locked-down school inbox and a phone on the bus.
function frame(bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#F4F2EC;
  font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55;color:#141D2E">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:28px 26px;border:1px solid #E2DED3">
  ${bodyHtml}
  <hr style="border:0;border-top:1px solid #E2DED3;margin:26px 0">
  <p style="font-size:13px;line-height:1.5;color:#5A6273;margin:0">
    Kirton Learning is a program of Our Rose LLC, Brooklyn, NY. Supplemental academic
    instruction only &mdash; reading, writing, and mathematics. Not special education
    advocacy, not legal advice, not therapy, not diagnosis, and not a replacement for the
    services your child&rsquo;s IEP requires the district to provide.
  </p>
  </div></body></html>`;
}

// The line that matters most in both emails, and the reason it is in both:
// the moment a parent learns to expect an email asking for her child's IEP is
// the moment somebody else can send her one.
const PHISHING_LINE =
  'I will never ask for the IEP any other way. Not as an email attachment, not through a ' +
  'form on another site, and never by text. If something else asks you for it, it is not me.';

// ---------------------------------------------------------------------------
// 1. After payment — the link for the IEP
// ---------------------------------------------------------------------------

function iepLinkEmail({ link, name }) {
  const hi = name ? `Hi ${name},` : 'Hi,';
  const origin = siteOrigin();

  const text = [
    hi,
    '',
    'Thank you. Here is the private link for your child\'s IEP:',
    '',
    link,
    '',
    'It opens a page that takes one document and nothing else. The file goes straight into',
    'an encrypted folder only I can open. It is never posted on the site, never sent over',
    'regular email, and never shared with your school.',
    '',
    'Two things about the link: it works once, and it stops working after seven days. If you',
    'run out of time or the page says the link is closed, reply to this email and I will send',
    'a fresh one. That is normal and it costs you nothing.',
    '',
    'PDF, Word document, or clear photos of the pages. Up to 25MB. If your only copy is on',
    'paper, photograph every page including the ones that look like boilerplate — the',
    'accommodations are usually near the back and they are half of what I build from.',
    '',
    PHISHING_LINE,
    '',
    'What happens after it lands:',
    '',
    '  1. I read the whole document. Every academic goal, the present levels, and the',
    '     accommodations. Five business days.',
    '  2. Your Blueprint arrives in your inbox, with a link to book a 30-minute call.',
    '  3. On the call I walk you through what I found. Bring questions. Bring the parts of',
    '     the IEP nobody has ever explained to you.',
    '',
    `Everything about what happens next is on one page: ${origin}/start.html`,
    '',
    'If you change your mind within fourteen days of getting your Blueprint, tell me and I',
    'refund it in full. You keep the Blueprint either way.',
    '',
    'Lamont Kirton',
    'Kirton Learning',
  ].join('\n');

  const html = frame(`
    <p style="margin:0 0 16px">${esc(hi)}</p>
    <p style="margin:0 0 16px">Thank you. Here is the private link for your child&rsquo;s IEP:</p>
    <p style="margin:0 0 20px">
      <a href="${esc(link)}" style="display:inline-block;background:#141D2E;color:#fff;
        text-decoration:none;padding:13px 22px;font-family:Helvetica,Arial,sans-serif;
        font-size:16px">Send the IEP</a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;color:#5A6273;word-break:break-all">
      If the button does not work, paste this into your browser:<br>${esc(link)}
    </p>
    <p style="margin:0 0 16px">It opens a page that takes one document and nothing else. The
      file goes straight into an encrypted folder only I can open. It is never posted on the
      site, never sent over regular email, and never shared with your school.</p>
    <p style="margin:0 0 16px"><b>Two things about the link:</b> it works once, and it stops
      working after seven days. If you run out of time or the page says the link is closed,
      reply to this email and I will send a fresh one. That is normal and it costs you nothing.</p>
    <p style="margin:0 0 16px">PDF, Word document, or clear photos of the pages. Up to 25MB.
      If your only copy is on paper, photograph every page including the ones that look like
      boilerplate &mdash; the accommodations are usually near the back, and they are half of
      what I build from.</p>
    <p style="margin:0 0 16px;padding:12px 14px;background:#F4F2EC;border-left:3px solid #E8A33D">
      ${esc(PHISHING_LINE)}</p>
    <p style="margin:0 0 8px"><b>What happens after it lands</b></p>
    <ol style="margin:0 0 16px;padding-left:20px">
      <li style="margin-bottom:7px">I read the whole document. Every academic goal, the present
        levels, and the accommodations. Five business days.</li>
      <li style="margin-bottom:7px">Your Blueprint arrives in your inbox, with a link to book a
        30-minute call.</li>
      <li>On the call I walk you through what I found. Bring questions. Bring the parts of the
        IEP nobody has ever explained to you.</li>
    </ol>
    <p style="margin:0 0 16px">Everything about what happens next is on one page:
      <a href="${esc(origin)}/start.html" style="color:#94590D">${esc(origin)}/start.html</a></p>
    <p style="margin:0 0 16px">If you change your mind within fourteen days of getting your
      Blueprint, tell me and I refund it in full. You keep the Blueprint either way.</p>
    <p style="margin:0">Lamont Kirton<br><span style="color:#5A6273">Kirton Learning</span></p>
  `);

  return { subject: 'Your private link for the IEP', text, html };
}

// ---------------------------------------------------------------------------
// 2. Later — the link for the record coming back
// ---------------------------------------------------------------------------
//
// The record lives on the family's device and nowhere else, which is the point,
// and it means the only way it reaches Lamont is if she sends it. This is the
// email that asks. start.html already promises this exact mechanism.

function recordLinkEmail({ link, name, why }) {
  const hi = name ? `Hi ${name},` : 'Hi,';
  const reason = why || 'before our next call';

  const text = [
    hi,
    '',
    `Here is a private link for the record, ${reason}:`,
    '',
    link,
    '',
    'How to get the file, if it has been a while:',
    '',
    '  1. Open the app and go to The record.',
    '  2. Set the date range to the period we are talking about.',
    '  3. Press Print, and choose Save as PDF instead of a printer.',
    '',
    'That PDF is what this link takes. Same as the IEP: one use, seven days, straight into',
    'the encrypted folder. It has her name and her goals in it word for word, so it deserves',
    'the same care the IEP got — please do not send it over regular email.',
    '',
    PHISHING_LINE.replace('the IEP any other way', 'the record any other way'),
    '',
    'If the record is thinner than you expected, send it anyway. A month where three weeks',
    'went missing tells me something I need to know, and it is usually about the work being',
    'wrong rather than the week being wrong.',
    '',
    'Lamont Kirton',
    'Kirton Learning',
  ].join('\n');

  const html = frame(`
    <p style="margin:0 0 16px">${esc(hi)}</p>
    <p style="margin:0 0 16px">Here is a private link for the record, ${esc(reason)}:</p>
    <p style="margin:0 0 20px">
      <a href="${esc(link)}" style="display:inline-block;background:#141D2E;color:#fff;
        text-decoration:none;padding:13px 22px;font-family:Helvetica,Arial,sans-serif;
        font-size:16px">Send the record</a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;color:#5A6273;word-break:break-all">
      If the button does not work, paste this into your browser:<br>${esc(link)}
    </p>
    <p style="margin:0 0 8px"><b>How to get the file, if it has been a while</b></p>
    <ol style="margin:0 0 16px;padding-left:20px">
      <li style="margin-bottom:7px">Open the app and go to <b>The record</b>.</li>
      <li style="margin-bottom:7px">Set the date range to the period we are talking about.</li>
      <li>Press <b>Print</b>, and choose <b>Save as PDF</b> instead of a printer.</li>
    </ol>
    <p style="margin:0 0 16px">That PDF is what this link takes. Same as the IEP: one use,
      seven days, straight into the encrypted folder. It has her name and her goals in it word
      for word, so it deserves the same care the IEP got &mdash; please do not send it over
      regular email.</p>
    <p style="margin:0 0 16px;padding:12px 14px;background:#F4F2EC;border-left:3px solid #E8A33D">
      ${esc(PHISHING_LINE.replace('the IEP any other way', 'the record any other way'))}</p>
    <p style="margin:0 0 16px">If the record is thinner than you expected, send it anyway. A
      month where three weeks went missing tells me something I need to know, and it is usually
      about the work being wrong rather than the week being wrong.</p>
    <p style="margin:0">Lamont Kirton<br><span style="color:#5A6273">Kirton Learning</span></p>
  `);

  return { subject: 'A private link for the record', text, html };
}

module.exports = { iepLinkEmail, recordLinkEmail };
