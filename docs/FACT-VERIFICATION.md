# Fact verification worksheet

All 22 entries in `docs/facts.json` are `status: "unverified"`, which is why every
handbook page is `noindex` and carries a "still being checked" line. `RESOURCE.md` says
only Lamont and his colleague move an entry to `verified`, and that rule stands — nothing
in this session changed a `status`, a `value`, or a `source`.

What this session did change: each fact below now carries the evidence in its own
`verify_against` field, so signing one off is a read rather than a research job.

**How to use this.** Work down the list. For each fact, the verdict says whether the claim
survived contact with the primary authority. When you agree, set `verified_on` to today's
date and `status` to `"verified"` in `docs/facts.json`. `verify/publish-gate.mjs` turns
green on the statuses alone and will tell you so.

⚠️ Read the DOE's pages in a browser, not by fetching them. `schools.nyc.gov` is
client-rendered: a plain fetch returns the navigation shell and none of the content, and
its numbers sit inside collapsed accordions that have to be clicked open. That is the
single reason several of these citations have gone unchecked for weeks — the page looked
like it didn't say the thing.

---

## Confirmed against a primary authority — ready for your signature

**`timelines.evaluation_completion` — "60 calendar days"**
Correct. **8 NYCRR 200.4(b)(1)**: *"The initial individual evaluation shall be completed
within 60 days of receipt of consent unless extended by mutual agreement of the student's
parents and the CSE."* Plain "days" means calendar days, matching federal
34 CFR 300.301(c)(1)(i). Re-point `source` from the `specialedstartguide.com` blog to
NYSED's own Part 200 page before you sign it.

> **There is a second 60 in the same regulation and it is the one she actually cares
> about.** **8 NYCRR 200.4(e)(1)**: *"the board of education shall arrange for appropriate
> special programs and services…within 60 **school** days of the receipt of consent to
> evaluate."* Sixty days to finish testing; sixty **school** days until the help starts —
> which, across holidays and a summer, is a different month entirely. The handbook teaches
> only the first. A mother counting calendar days will either think the school is late
> when it isn't, or sit quietly while it runs months over. This is the most useful thing
> I found all day and it is currently missing from the page.

**`timelines.interpreter_request_notice` — "at least 72 hours before the meeting, in writing"**
Correct, word for word. The DOE IEP-meeting page: *"If English is not your preferred
language, make a request for an interpreter in writing at least 72 hours before the
meeting."*

> Three things on that same page that are not in the handbook. The same 72-hour written
> notice also gets her **a certified IEP Parent Member** — a trained parent of a child with
> an IEP who comes to the meeting and sits with her, free — and **a school physician** for
> grades K–12. A deaf or hard-of-hearing parent has a separate legal right to a sign
> language interpreter, arranged through the parent coordinator or `OSLIS@schools.nyc.gov`.
> The Parent Member is the one almost nobody knows exists.

---

## Partly confirmed — one line in it is wrong or unsupported

**`placement.district_75`**
- `serves` — confirmed, matches the DOE's list word for word.
- `class_ratios` — confirmed. The DOE's prose writes them `12:1+1`, `8:1+1`, `6:1+1`,
  `12:1+3:1`; its own kindergarten listings write `12:1:4`. Same thing, two spellings.
- `phone_main` `212-802-1500` — corroborated. District 75 central office, 400 1st Ave,
  `D75info@schools.nyc.gov`.
- `student_count` "more than 23,000" and `sites` "roughly 69 schools and programs across
  more than 300 sites" — **not on the DOE page we cite.** Both trace to InsideSchools,
  which is secondary and undated. Cite InsideSchools honestly or drop the numbers; a
  student count moves every year and a stale one is the kind of thing a principal corrects
  you on.
- `phone_placement` `212-802-1578` — **could not be corroborated anywhere. Call it before
  you publish it, or take it out.** This is the riskiest line in the file: a parent dials a
  number in a handbook, and a wrong one teaches her the whole document is unreliable.

---

## Not verified — the source isn't good enough yet

**The Turning 5 cluster** — `turning_5_notice_window`, `turning_5_no_letter_deadline`,
`turning_5_contact_window`, `turning_5_conference`, `first_school_age_iep`.
Five dates drawn from **five different secondary sources**: one school's website, an
advocacy org, a private provider, a dated parent-training PDF, a university page. Nothing
guarantees they describe the same year or the same process, and Turning 5 dates move year
to year. Verify the cluster **together**, against one current DOE Turning 5 page or this
year's DOE Turning 5 letter, and record which school year they belong to.

**`timelines.d75_initial_referral`** — sourced to a single school's own site. The value
restates the general initial-evaluation clock in 200.4(b)(1); it is probably right for
that reason and not because it is a District 75 rule. Re-point it at the regulation and
say so plainly, or drop it — a D75-flavored "60 days" implies a rule that may not exist.

**`committees.cse`** — cites a real DOE page, but a section landing page rather than the
one that carries the office list. Re-point it at the page that actually says it.

**`committees.early_intervention`, `committees.cpse`, `eligibility_warnings.preschool_to_school_age`,
`placement.specialized_autism_programs`, `funding.insurance_mandate_ny`** — all rest on
IncludeNYC, Columbia, or Autism Speaks. Good organizations, none of them the authority.
The authorities are NYSED Part 200 (§200.16 for preschool), NYC DOE, NYS Department of
Health for Early Intervention, and NYS DFS for the insurance mandate.

**`placement.lre_principle`, `professional_roles`, `glossary`,
`referral_organizations`** — no source at all. Several are editorial by nature (a glossary,
a rule about how we describe professions) and may never need an external citation. Decide
which of these are *editorial* and which are *factual*, and mark them, because right now
they are blocking publication in the same bucket as a date that a parent will act on.

---

## The nine draft translations

`translation_review.languages.*` — all nine are `draft` and none has a named reviewer.
These are a separate decision from the facts: a fact needs a source, a translation needs a
human who reads that language. The interpreter letter in `source/` **prints**, and it is
carried into a school office, so an unreviewed Haitian Creole request can reach a
secretary with nothing on the paper saying it is a draft. That draft mark now prints; keep
it printing until someone has read it.

---

## What I did not do

I verified two facts to primary sources, part-verified one, and triaged the rest by source
quality. I did not attempt all 22 — several need a phone call (the D75 placement line), a
current-year DOE document (Turning 5), or a decision from you about what counts as
editorial. Those are the four things standing between this handbook and being publishable,
and none of them is code.
