/* Kirton Learning — page measurement.

   privacy.html, under "Information collected automatically", promises a
   family exactly this and no more: which pages were visited, roughly what
   country the visit came from, what kind of device. No cookies used for
   advertising, no cross-site tracking, no advertising network. That
   paragraph has been on the live site since launch. Until 2026-09-14 the
   site collected nothing at all, so the paragraph described a system that
   did not exist. This file is what makes it true.

   THE RULE THAT MATTERS: the IEP intake is never measured.

   /upload carries a one-time token in its query string, /intake is the six
   questions about a child, /ask is where she writes her question in her own
   words, and /admin is the back office. None of them ever
   loads a beacon, so neither the path nor the token can reach a third party
   even by accident. The guard lives here, in
   one file, rather than in the decision about which pages get the tag —
   so a page that includes this script by mistake is still safe.

   privacy.html says: "The upload page is behind a one-time authenticated
   link and its contents are never sent to any analytics, error-tracking,
   or third-party service." This is the code that keeps that sentence. */
(function () {
  var path = location.pathname.replace(/\/+$/, '').toLowerCase() || '/';

  /* Both spellings. cleanUrls means /upload.html 308s to /upload, but a
     redirect is a round trip and this script would already have run. */
  var NEVER = ['/upload', '/upload.html', '/intake', '/intake.html',
               '/ask', '/ask.html', '/admin', '/admin.html'];
  if (NEVER.indexOf(path) !== -1) return;

  /* A secret in a URL is never measured, on any page. If a token ever
     appears somewhere it was not expected, this still holds. */
  if (/[?&](t|token|key|session_id)=/i.test(location.search)) return;

  var s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);
})();
