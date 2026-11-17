// The contact address is put together HERE, in the visitor's browser, instead of
// being written into the HTML. Spam bots read the raw HTML of every page they can
// find and collect anything shaped like an email address; most of them never run
// JavaScript, so they never see it. A real visitor sees the real address and a
// working link. Without JavaScript the page still shows "lamont [at]
// kirtonlearning.com" (readable, typeable) and links fall back to /ask.
(function () {
  var addr = 'lamont' + String.fromCharCode(64) + 'kirtonlearning.com';
  var shown = 'lamont [at] kirtonlearning.com';
  var els = document.querySelectorAll('[data-mail]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.tagName === 'A') el.setAttribute('href', 'mailto:' + addr);
    if (el.textContent.indexOf(shown) !== -1) el.textContent = el.textContent.split(shown).join(addr);
  }
  window.KL_MAIL = addr;
})();
