# Session 0016 — 2026-08-22 — `searchHn`: the fetch half of the HN adapter

The last piece of [TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md),
continuing from [worklog 0014](./0014-hn-query-and-parse.md) (url building and
parsing) and [worklog 0015](./0015-hn-usable-classifier.md) (the classifier).
With this in, **0009 is Done** and `src/source/` has fetched something for the
first time — in tests, over a stub transport, but through the real `httpGet`.

## What I asked for

_"Continue implementation, stop for me to review changes, keep commits small."_

## What the AI produced

Appended to `src/source/hn.ts` (~150 lines) and `tests/hn.test.ts` (+10 tests,
163 in the suite).

| Export                    | What it is                                                                      |
| ------------------------- | ------------------------------------------------------------------------------- |
| `searchHn(seed, options)` | Runs the four expansion arms, paginates each, dedups, returns everything        |
| `HnSearchResult`          | `{ hits, arms, failures, dropped, pages_fetched }`                              |
| `SourcedHit`              | `{ hit, found_by[] }` — every arm that found this post, not just the first      |
| `HnArmSummary`            | Per arm: `pages_fetched`, `hits`, and `new_hits` — what it actually contributed |
| `HnSearchFailure`         | One page that did not come back: arm, page, url, status, reason                 |
| `HN_MAX_PAGES_PER_ARM`    | 2. A budget, not a measurement                                                  |

## Four judgement calls

**1. The adapter never throws on a source failure; it returns them as data.**
ARCHITECTURE §5 says a source API failure, after bounded retries, fails the run.
It does not say the _adapter_ throws, and it must not: four arms over two pages
is up to eight requests, and one 500 on the funding arm's second page is not a
reason to lose the three arms that worked. `failures[]` carries every page that
did not come back, and [TICKET-0012](../tickets/0012-ticket-stage-1-wiring.md)
decides whether what survived is enough to continue. An adapter that throws takes
that decision away from the only layer that can make it. This is the call most
worth overruling if the reviewer reads §5 more strictly.

**2. The injection point is `HttpOptions`, not a replaceable `httpGet`.** The
obvious way to make this testable is to accept a fetch function. That would also
be a hole in the one rule CLAUDE.md states about the network — everything goes
through `src/evidence/fetch.ts`. So `searchHn` takes the same options object
`httpGet` takes and passes it down: a test supplies a stub transport, exactly as
`fetch.ts`'s own suite does, and the caching, retry and url-building code under
test is the production code. The cost is a slightly odd-looking option (`http`)
on a source adapter.

**3. `found_by` is a list, not the first arm that won.** A Show HN about a
funding round matches three of the four arms. Crediting only the first would make
the others look like they earned nothing, which is precisely the question
[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md) is meant to
answer with data. `arms[].new_hits` gives the other half of it: an arm that
returns fifty hits and contributes zero is an arm to cut.

**4. An arm stops on its first failure.** A 500 on page 0 usually means page 1 is
a 500 too, and each attempt costs the full retry budget. Also: a 200 whose body
is not a search response (an error page, a truncated body) is recorded the same
way, with `status: 200`, because that is what the server actually said.

Two smaller stop conditions, both in code: the `nbPages` Algolia reports, and a
short page — fewer hits than requested — for a payload that under-reports it.

## What the record should be honest about

**`HN_MAX_PAGES_PER_ARM = 2` is a fourth unmeasured guess**, alongside the three
already flagged in STATE (inconsistencies 14, 16, 17). Two pages of a relevance
ranking is already past what a human would read and `--limit` cuts far below it,
but that is an argument, not a measurement. It is one constant and it is labelled
in the code.

**Nothing has hit the live API yet.** Every test drives a stub transport over
committed fixtures from one topic. The pagination logic is tested; the assumption
that Algolia's `nbPages` and page ordering behave as the fixtures suggest is not.
That is what TICKET-0013's real run is for.

## Verification

- `pnpm test` — **163 passed** (153 before; +10 here: pagination past page 1
  across all four arms, the window and tags in every requested url, dedup with
  `found_by` and a zero-contribution arm, an empty result set, both stop
  conditions, a 500 mid-run, a 200 that is not JSON, dropped hits surfacing from
  a malformed page, and a classify-what-you-fetched pass end to end). Offline,
  no key, no network.
- `pnpm typecheck` and `pnpm lint` clean.
- Ticket acceptance, now fully covered: pagination assembles multiple pages; an
  empty result set returns `[]`; null-URL posts are unusable with a reason;
  malformed timestamps do not crash the parse; the classifier covers company
  site, personal blog, paper/PDF and GitHub-only project.

## What went wrong

One self-inflicted test bug: an assertion written as
`expect(hits.every(h => h.found_by).length)` — `.length` on a boolean, which is
`undefined`, which fails for the right reason by accident. Replaced with the
assertion it was meant to be. Also one `exactOptionalPropertyTypes` failure from
spreading `sinceDays: undefined` into a required-when-present field; fixed by
building the query options conditionally rather than by loosening the type.

## Decisions taken

None. D-6 stays open with its default; this session makes its input reachable
(`classifyHits(searchHn(...).hits)`) but measures nothing.

## Attribution

`searchHn`, its result types and the 10 tests are AI-written end-to-end. All four
judgement calls above were made by the AI. Call 1 is the one with consequences
past this file.

## Reflection

Implemented paginated search, along with tests.

## Next

**0009 is Done.** [TICKET-0011](../tickets/0011-ticket-query-planning.md) is
unblocked for its probe half — `searchHn` plus `classifyHits` is exactly what
`--min-hits` counts against — and it is designed to ship without the LLM
clarifier that [TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md)
would provide. [TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md)
is still Ready and independent of both. The gate at
[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md) is now two
tickets away.
