# Session 0015 — 2026-08-22 — The usable-vs-unusable classifier

The second piece of [TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md),
continuing directly from [worklog 0014](./0014-hn-query-and-parse.md). This is
the filter ADR-0004 promised would be heuristic and auditable, and the definition
[TICKET-0011](../tickets/0011-ticket-query-planning.md)'s probe threshold (D-6)
is written in terms of. The paginated `searchHn` over `httpGet` is still open.

## What I asked for

_"Commit this on feature branch and continue with the classifier."_ The parse
half was committed first, on `feat/0009-hn-adapter`; this entry is what came
after it.

## What the AI produced

Appended to `src/source/hn.ts` (~180 lines) and `tests/hn.test.ts` (+13 tests,
153 in the suite).

| Export                                                           | What it is                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `classifyHit(hit)`                                               | One hit → `{ usable, kind, reason, host }`                                         |
| `classifyHits(hits)`                                             | The split the probe reads: `{ usable[], rejected[] }`, both carrying their verdict |
| `HitKind`                                                        | `company_site`, `code_repo`, `content`, `paper`, `aggregator`, `no_url`, `bad_url` |
| `CONTENT_HOSTS`, `PAPER_HOSTS`, `AGGREGATOR_HOSTS`, `CODE_HOSTS` | The lists, exported so TICKET-0013 can argue with them in one place                |
| `ARTICLE_PATH`, `DATED_PATH`                                     | `/blog/…`, `/2026/08/…` — what catches a company blogging about the topic          |

Rejections keep their hit rather than being dropped, so a thin probe can record
_why_ it was thin instead of only that it was.

## Three judgement calls, in descending order of how much they need review

**1. A repo is usable.** The ticket's unusable list is "blog, paper, or personal
domain" and does not name repos, but it does ask for a GitHub-only project as a
test case, so the call had to be made explicitly. It is usable: this thesis is
"adopted before it is sold", and for a dev-tools launch the repo _is_ the product
surface — GitHub is already the secondary enrichment source (ADR-0004), so a
candidate arriving as a repo is a candidate arriving with its best evidence
attached. `*.github.io` project pages classify the same way. The cost is that a
weekend project and a company are indistinguishable at this layer; separating
them is what stage 2's scoring is for, and what the gate at 0013 will measure.

**2. It errs towards accepting.** The unusable side is a set of narrow, nameable
rules; everything else passes. The asymmetry is deliberate: a wrong reject is
invisible — the company is never looked at again and nothing in the output says
it existed — while a wrong accept costs one analysis and appears in a memo a
human reads. It also means the usable count that D-6 is compared against is an
upper bound, which matters when the threshold is tuned at 0013.

**3. It reads the url, never the page.** The ticket says "resolves to a company
site"; this does not resolve anything. The probe must classify a whole result set
before a run is allowed to start, so it cannot fetch, and the real resolution —
redirects, canonical domain, dedup — is
[TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md), which can
overturn a verdict made here with better information. Rule order inside the
classifier follows from the same constraint: narrow before broad, so a PDF on a
company domain is still a paper and an article path on a code host is still a
repo.

## Two things the record should be honest about

**There is a false positive class it cannot see, and there is a test for it.**
`machinelearningmastery.com/llm-observability-tools-…` is a trade blog on its own
domain with no `/blog/` in the path. Nothing in the url distinguishes it from a
company site, so it is accepted. The test asserts the wrong answer on purpose and
says why, because the alternative — adding that host to `CONTENT_HOSTS` — fits
the list to the fixture and hides the class. It is one of the five hits 0013 will
hand-check.

**The host lists are hand-written and seeded from one topic's fixtures.** They
are exported constants rather than inline literals precisely because the honest
expectation is that a real result set will change them.

## Verification

- `pnpm test` — **153 passed** (140 before; +13 here: 11 on `classifyHit`
  covering company site, repo, personal blog, paper, aggregator, a real company's
  blog post, null url, unparseable url, `www`/subdomain handling, the
  reason-on-every-rejection rule and the known false positive; 2 on
  `classifyHits` over captured pages). Offline, no key.
- `pnpm typecheck` and `pnpm lint` clean.
- Ticket acceptance: the classifier line is now covered — company site, personal
  blog, paper/PDF and GitHub-only project each have a case, and null-URL posts
  are unusable with a reason. Pagination _assembly_ is tested against committed
  pages; pagination _fetching_ is not written yet.

## What went wrong

Nothing that survived, and nothing worth hiding: the fixture page split exactly
as predicted on the first run — two repos usable, a blog post, an Ask HN and a
trade-press article rejected. That is a small result and should not be read as
validation. The suite classifies 15 real urls from one topic. It says the rules
do what they say, not that the rules are right.

## Decisions taken

None taken, one sharpened. D-6 (`--min-hits` default of 8) stays open and its
default stands, but it is now measurable: "usable" has a definition and
`classifyHits(...).usable.length` is the number the threshold compares against.
The reading it produces is an upper bound, per judgement call 2 — worth knowing
before the threshold is tuned at 0013.

## Attribution

The classifier, its host lists and the 13 tests are AI-written end-to-end. The
three judgement calls were made by the AI; the first two change what the pipeline
looks at and are the ones to overrule if any are wrong.

## Reflection

HN classifier has landed. Difficult to trust right now, without testing it first on a real run.

## Next

The last piece of 0009: `searchHn` over `httpGet` — pagination past page 1, the
four expansion arms deduped by `objectID`, and source failures returned as data
rather than thrown, per ARCHITECTURE §5. After that 0009 is Done and
[TICKET-0011](../tickets/0011-ticket-query-planning.md) unblocks for its probe
half. [TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md) is still
Ready and independent.
