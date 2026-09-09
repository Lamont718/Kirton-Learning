/* facts.js — every date, deadline and phone number on this site comes from
   docs/facts.json. Pages carry the current value as their own text so the page
   still reads correctly with JavaScript off or the fetch failed; this script
   replaces that text with whatever facts.json says now, and marks anything a
   human has not yet verified.

   Markup:
     <span data-fact="timelines.turning_5_no_letter_deadline">February 1</span>
     <span data-fact="timelines.evaluation_completion" data-field="plain_language">…</span>
     <p data-fact-reviewed></p>

   Never hardcode a value without a data-fact wrapper, and never let this script
   promote anything to verified — only a person edits status in facts.json. */
(function () {
  'use strict';

  var SRC = '/docs/facts.json';

  var css = document.createElement('style');
  css.textContent =
    '.fact--unverified{border-bottom:1px dotted #A6402F;cursor:help}' +
    '.factline{font-size:.8rem;opacity:.75;margin-top:2rem}' +
    '.factline--error{color:#A6402F;opacity:1}';
  document.head.appendChild(css);

  function get(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
    }, obj);
  }

  function longDate(iso) {
    var parts = String(iso).split('-');
    if (parts.length !== 3) return iso;
    // build from parts, not new Date(iso) — that parses as UTC and prints the day before in New York
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return Number(parts[2]) + ' ' + months[Number(parts[1]) - 1] + ' ' + parts[0];
  }

  function applyFacts(facts) {
    var missing = [];

    document.querySelectorAll('[data-fact]').forEach(function (el) {
      var path = el.getAttribute('data-fact');
      var entry = get(facts, path);
      if (!entry) { missing.push(path); return; }

      var field = el.getAttribute('data-field') || 'value';
      var val = entry[field];
      if (typeof val === 'string') el.textContent = val;

      if (entry.status !== 'verified') {
        el.classList.add('fact--unverified');
        el.title = 'Not yet verified against a primary source.';
      } else {
        el.classList.remove('fact--unverified');
        el.title = 'Verified ' + longDate(entry.verified_on) + '.';
      }
    });

    if (missing.length) {
      console.error('facts.js: no entry in facts.json for ' + missing.join(', '));
    }

    var meta = facts._README || {};
    document.querySelectorAll('[data-fact-reviewed]').forEach(function (el) {
      el.textContent = meta.last_full_review
        ? longDate(meta.last_full_review)
        : 'not yet reviewed — compiled ' + longDate(meta.compiled_on) +
          ' and not yet confirmed by a person';
    });
  }

  function failed(why) {
    console.error('facts.js: ' + why + ' — pages are showing their built-in text, which may be out of date.');
    document.querySelectorAll('[data-fact-reviewed]').forEach(function (el) {
      el.classList.add('factline--error');
      el.textContent = 'unavailable — treat everything on this page as unconfirmed';
    });
  }

  // RESOURCE.md, meeting mode: a printed page carries its own URL, so a parent
  // who was handed a photocopy can find it again.
  document.querySelectorAll('[data-page-url]').forEach(function (el) {
    el.textContent = location.origin + location.pathname;
  });

  fetch(SRC, { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error(SRC + ' returned ' + r.status);
      return r.json();
    })
    .then(applyFacts)
    .catch(function (e) { failed(e.message); });
})();
