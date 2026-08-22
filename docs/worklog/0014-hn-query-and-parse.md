# Session 0014 — 2026-08-22 — HN Algolia: query building and hit parsing

The first half of [TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md),
the primary source. Split the way TICKET-0008 was: this entry is the pure half —
url construction, expansion, and turning a captured payload into typed hits. The
paginated fetch and the usable-vs-unusable classifier are the second half and are
not in this commit.

## What I asked for

_"Continue implementation, stop for me to review changes, keep commits / changes
small and easy to review. Keep adding worklogs, add reflection hints. Update
ticket(s) status(es) accordingly."_ 0009 and 0010 were both Ready and
independent; 0009 was taken first because [TICKET-0011](../tickets/0011-ticket-query-planning.md)'s
probe and the gate at [TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md)
both hang off it.

## What the AI produced

`src/source/hn.ts` (~230 lines) and `tests/hn.test.ts` (17 tests).

| Export                         | What it is                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `hnSearchUrl(options, now)`    | Query, tags, `--since` window, page, hitsPerPage → one url. Deterministic in its inputs |
| `windowStartUnix(days, now)`   | The `created_at_i>` boundary, floored to a UTC day                                      |
| `expandQuery(seed)`            | The four fixed arms: `raw`, `show_hn`, `launch`, `funding`                              |
| `hitTimestamp(unix, iso)`      | Unix field first, ISO second, `null` third                                              |
| `parseSearchResponse(payload)` | Payload → `{ hits, page, nb_pages, nb_hits, dropped }`                                  |
| `hnItemUrl(objectId)`          | The thread url every hit carries, and what an `hn_item` evidence record will cite       |

And four fixtures under `tests/fixtures/hn/`, captured live from the API on
2026-08-22 with the `curl` commands recorded in
[`tests/fixtures/hn/README.md`](../../tests/fixtures/hn/README.md): a result
page, its page 1, an empty result set, and an Ask HN page where every hit has a
null url. `hitsPerPage=5`, so a whole page fits on a screen in review. No new
dependency.

## Four judgement calls, in descending order of how much they need review

**1. `show_hn` is a tag filter, not a phrasing.** ADR-0004 asks for expansion
across "Show HN / launch / funding phrasings". Two of the three are phrasings.
Show HN is not, because HN spells that concept in a field — `_tags` contains
`show_hn` — and a filter cannot mistake a post that merely contains the word
"show" for a launch. It is still code choosing a filter from a flag, which is the
half ADR-0008 cares about. The cost is that the arm is only as good as the
poster's use of the "Show HN:" prefix; a launch posted as a plain story is caught
by the `raw` and `launch` arms or not at all.

**2. The date window is floored to a UTC day.** A boundary computed from the
clock to the second would produce a new url on every invocation, so the fetch
cache would miss on every re-run — and a cache miss re-fetches, which produces a
new `retrieved_at`, which produces new evidence ids for the same page. Flooring
makes a same-day re-run byte-identical. The cost is that `--since 180` means
"180 days before midnight today", up to 24 hours wider than a literal reading.

**3. A mistyped optional field costs that field, not the hit.** Every field but
`objectID` is `.nullish().catch(null)`. Without the `.catch`, one malformed
timestamp fails the whole object and `parseOrDrop` discards an otherwise good
post — the fixture's hit 2, a `created_at_i` that arrived as a string, is exactly
that case and it survives with its date read from the other field. `objectID` is
the one hard requirement because without it there is no thread url and nothing to
dedup on.

**4. Absent numbers stay `null`.** `points` and `num_comments` are nullable all
the way through rather than defaulting to `0`. D3 reads them, and a post with no
score is not a post that scored nothing (CLAUDE.md invariant 4). It costs every
downstream consumer a null check, which is the intended price.

## Two things the record should be honest about

**`search-malformed.json` is hand-edited and the fixture README says so.** The
API does not serve broken records on request. It is `search-page-0.json` with
five deliberate defects, one per hit, tabulated in the README. Four of the five
are survivable on purpose: the test is that a strict parser would throw away four
usable posts to reject one.

**Nothing here has fetched anything.** `parseSearchResponse` is fed a file. The
adapter does not yet call `httpGet`, so the claim that HN is reachable through
the choke point is not yet demonstrated by a test — that is the next commit.

## Verification

- `pnpm test` — **140 passed** (123 before; +17 here: 7 on `hnSearchUrl`, 1 on
  `expandQuery`, 3 on `hitTimestamp`, 6 on `parseSearchResponse`). Offline, no
  key.
- `pnpm typecheck` and `pnpm lint` clean.
- Ticket acceptance, partial: pagination assembles two committed pages into ten
  distinct ids; the empty set returns `[]`; null-url Ask HN posts parse and keep
  a resolvable thread url; malformed timestamps degrade to `null` without a
  crash. The classifier half of the acceptance list is not started.

## What went wrong

- The first `RawHit` used plain `.nullish()`, and the malformed fixture dropped
  two hits instead of one — a `created_at_i` that arrived as a string failed the
  whole object. Fixed with `.catch(null)` per field; judgement call 3 above is
  the write-up of what that trade actually is.
- A test assertion was written as a comma expression — `expect(a), expect(b)` —
  which silently asserts nothing. Biome's `noCommaOperator` caught it. It is the
  kind of defect a passing suite hides, so it is named here rather than fixed
  quietly.

## Decisions taken

None. No open decision moved. D-6 (`--min-hits` default of 8) is measured
against the classifier, which is the next commit, so it stays open and untouched.

## Attribution

`src/source/hn.ts`, `tests/hn.test.ts`, the fixture capture commands and the
fixture README are AI-written end-to-end. The four judgement calls were made by
the AI and are listed so they can be overruled cheaply; none was reviewed before
this entry was written.

## Reflection

HN adapter has been implemented. The parsers and safeguards put forth by zod schema have made it robust to malformed responses.

## Next

The second half of 0009: `searchHn` over `httpGet` — pagination, the four
expansion arms deduped by `objectID`, and the usable-vs-unusable classifier that
[TICKET-0011](../tickets/0011-ticket-query-planning.md)'s probe threshold is
defined in terms of. [TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md)
stays Ready and independent.
