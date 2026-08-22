# Session 0026 — 2026-08-22 — `pnpm capture-fixtures`, and the fixtures it took

[TICKET-0014](../tickets/0014-ticket-fixture-capture-script.md), in four commits.
The suite now has the external surfaces stage 2 is about to add — GitHub owner
and repo payloads, two real company pages, the gate's thin HN topic — plus the
deliberately malformed model outputs TICKET-0020's failure path needs. It stays
offline: 507 tests, no network, no `.env`.

## What I asked for

Continue implementation, small reviewable commits, keep the worklog going.

## What landed

| Commit    | Contents                                                                 | Tests |
| --------- | ------------------------------------------------------------------------ | ----- |
| `419a0a4` | `scripts/fixtures.ts` — secret scan, normalisation, the HN defect table  | 25    |
| `409f085` | `scripts/capture-fixtures.ts` — the runner and its twelve-entry list     | 18    |
| `a03477f` | The capture itself: 8 files, `capture.json`, `tests/fixtures/README.md`  | 40    |
| `4c3e463` | `model/` — four authored files and the table that says why each is wrong | 15    |

**507 tests** (409 before this ticket: +98, of which 40 are the two per-file
guards below running once per committed fixture),
typecheck and lint clean, and `pnpm test` verified with `.env` moved aside.

## Four rules the script is built around

1. **A fixture is written once and refreshed on purpose.** A bare run writes
   only what is missing.
2. **Capture never reads the HTTP cache** (`cacheDir: ""`). A capture is a
   statement about what the server returned today.
3. **Nothing is written unscanned.** A credential-shaped body fails its fixture,
   names the rule that fired — never the match — and the run exits non-zero.
4. **Provenance is generated, not remembered.** `capture.json` merges across
   runs, so `--only github` cannot erase how the hn group was obtained.

## Rule 1 was not a precaution. It fired the same afternoon

The first version of the script had no such rule: a run captured everything on
its list. Running it once with `--refresh` over the four HN fixtures TICKET-0009
had captured **three and a half hours earlier** rewrote all four and broke five assertions in
`tests/hn.test.ts` — the classifier count the D-6 threshold argument rests on
among them. Algolia is relevance-ranked; an afternoon is enough.

Two things came out of that:

- Those four are now marked `legacy` and are **adopted** rather than
  re-captured: a bare run records the digest of the committed bytes and says
  `captured_by: "hand"`. Their `url` in the manifest is a transcription of the
  original `curl`, not a url rebuilt from `hnSearchUrl` — the command is what
  produced the bytes, and a manifest that claimed otherwise would be provenance
  with a lie in it.
- Deleting `capture.json` then exposed the hole in the other direction: a bare
  run skips what exists, so it cannot rebuild a record it never wrote. A fixture
  on disk with no manifest entry is now a loud failure.

## What the captures are, and what they cost

Ten fetches, all public and unauthenticated, ~1s each. Every subject is a
candidate from the [gate's own 48](0022-gate-hand-check.md) rather than an
invention:

- **`type: "Organization"` vs `type: "User"`** — `coroot` and `nullswan`, the
  field that separated all ten open-source projects from every real company in
  the gate's list (inconsistency 22). `ccfos` is the third payload: an
  organisation that is a foundation, which is what keeps that field a fact for
  the rubric rather than a filter in stage 1.
- **The `homepage` join** — `coroot/coroot` carries
  `homepage: "https://coroot.com"` (inconsistency 45). `nullswan/bpfsnitch`
  carries `homepage: ""` — an empty string, not null. Only a real payload tells
  you that.
- **`coroot.com/about`** turned out to be worth more than expected: three named
  people, roles, and a prior exit in prose ("Built Percona and FerretDB from the
  ground up"). That is a `founder.prior_exit` fact sitting in a committed
  fixture, which is exactly what TICKET-0020 needs to test extraction against.
- **`hn/search-thin.json`** is the gate's `eBPF observability` probe: 6 hits, 3
  usable, carrying the deep link into `alibaba/anolisa`, a `medium.com` post and
  an `infoq.com` article. The payload that beat canonicalisation and the
  classifier, now committed.

## Three decisions taken in the code

**The secret scan is biased towards false positives, and refuses rather than
redacts.** A body carrying anything credential-shaped fails its fixture and
writes nothing; the operator drops the page. The loose rule — `api_key`-shaped
assignments — will eventually fire on a real marketing page carrying a
publishable analytics key. That is still the right default: this script cannot
tell a publishable key from a private one and the operator can. The finding
reports a length and eight hex of sha256, never the match, so a scan that fires
does not move the leak into a terminal log.

**The oversize cap refuses instead of truncating.** 128 KB. Half a page of HTML
parses to something the server never served. `insforge.dev` (259 KB) was on the
first draft of the capture list and is not on the committed one.

**The model outputs are authored, not captured, and the defect table is code.**
Eight items, one defect each. Seven are dropped at parse time; the eighth is an
`evidence_ids` entry of exactly the right shape that resolves to nothing. It
parses. Nothing at parse time can tell it from a real citation, which is the
whole argument for the memo validator being a separate stage
([ADR-0003](../adr/0003-evidence-store-and-citations.md), TICKET-0025) — the gap
is now a fixture rather than a paragraph.

## Two acceptance criteria made mechanical

The ticket asks for "no token, cookie, or key anywhere under `tests/fixtures/`"
and "refreshes fixtures without hand editing". Both are now tests that run on
every `pnpm test`: every committed fixture is re-scanned, and every file must
match its `capture.json` digest — so a hand-edited fixture fails the suite.

## What this ticket did not do

- **No empty-shell page.** TESTING §6 wants a company site that serves a JS stub
  and no text; both captured pages render server-side (5,948 and 1,746
  characters extracted). One has to be _found_, and TICKET-0023 owns that path.
  Recorded in `tests/fixtures/README.md` rather than quietly skipped.
- **No 404 body.** `httpGet` turns a non-2xx into a `fetch_failed` record and
  drops the body, so there is nothing for a fixture to hold.
- **`tests/fixtures/hn/README.md` is gone**, folded into
  `tests/fixtures/README.md`. Its `curl` commands are now the manifest's `url`
  fields and its defect table is now `HN_DEFECTS` in code, so keeping it would
  have been keeping a third copy that drifts.

## Attribution

`scripts/fixtures.ts`, `scripts/capture-fixtures.ts`, all 98 new tests,
`tests/fixtures/README.md` and this worklog's factual sections are AI-written end
to end. The capture list — which company, which repo, which owner — was chosen
from the gate's own results rather than invented, and the three decisions above
were the AI's, taken under the documented defaults.

## Reflection

N/A

## Next

**TICKET-0014 is Done**, and it unblocks the two adapters:

- **[TICKET-0015](../tickets/0015-ticket-github-adapter.md)** — the GitHub
  adapter. Its fixtures are committed, including the `homepage` field that is the
  one gate defect stage 1 structurally cannot fix, and the `type` field that
  separates a weekend repo from a company.
- **[TICKET-0016](../tickets/0016-ticket-company-site-adapter.md)** — the company
  site adapter, with a real landing page and a real team page to work against.

[TICKET-0011](../tickets/0011-ticket-query-planning.md) stays reopened and not
Ready: the clarifier call still needs `prompts/clarify-query.v2.md` and the
rubric behind `{{thesis}}` (TICKET-0021).
