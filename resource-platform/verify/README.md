# Checking the resource platform

    node verify/check.mjs

Runs offline against the files on disk, needs nothing installed, exits non-zero
on a failure. Run it before every deploy.

It checks facts.json integrity, that every `data-fact` path resolves and that the
fallback text in the HTML still matches the file, that every internal link points
at a file that exists, that every page carries noindex / lang / title / draft
banner / loader / review date / print URL, that every phone number is a `tel:`
link, and that no page contains banned vocabulary, clinical framing or a British
spelling.

Every one of those exists because something was actually wrong.

## What it cannot check, and how those were proved

These need a real browser. They are not in `check.mjs` because that would mean
adding a dependency, and CLAUDE.md says to ask first. The commands below are what
was used; they need `puppeteer-core` and `@axe-core/puppeteer` installed in a
scratch directory, pointed at the installed Chrome.

**Contrast and WCAG.** axe-core against WCAG 2.1 A and AA on every page. Last run
clean on all 22. Two traps: a crawler that follows `href` will pick up
`page.css` and report it as a page with no `<title>` — filter `.css` out. And
`--accent-deep` is `#94590D`, not the `#C97F1B` the drafts use, because the
lighter amber measures 2.87:1 on `--paper` where AA needs 4.5.

**Touch targets.** Device emulation at 390x844 and 320x568
(`setViewport({isMobile: true, hasTouch: true})`) — a resized window ignores the
viewport meta and reports whatever you want to hear. Nothing scrolls sideways at
either width. Hit areas are grown with an `::after`, so measuring an element's own
rectangle will report these links as far too small forever: measure
`getComputedStyle(el, '::after').height`.

**The loader actually running.** `--dump-dom` or `page.evaluate` after
`networkidle0`. curl cannot see any of it.

**That verification will actually reach the pages.** The important one. Intercept
the request for `/docs/facts.json` (`page.setRequestInterception`) and serve a
doctored copy with a corrected value and `status: "verified"`, then check the page
moved: text replaced, `tel:` href following the number, unverified underline
cleared, tooltip naming the date. A fallback that matches the file hides a dead
loader completely — that is exactly how the phone spans looked correct while doing
nothing at all.

**Print output.** `emulateMediaType('print')` then `page.pdf()`, and read the
result. Banner and navigation gone, "Do this week" and the routing block still
there, the page's own URL at the foot. Note that `.head` is a back-link bar on a
question page and the title block on a topic page — hiding it globally prints a
funding guide with no title on it.

**Page weight.** `setCacheEnabled(false)` per page, or the first page's fonts are
cached and every page after it reports about zero.

## What a check can never tell you

Nothing here says a fact is true. All 22 entries are unverified and all 9
translations are draft, and only a person can change that. A green run means the
site is consistent with `facts.json` — not that `facts.json` is right.
