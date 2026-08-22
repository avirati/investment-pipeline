# Session 0011 — 2026-08-22 — Cached fetch layer

[TICKET-0008](../tickets/0008-ticket-cached-fetch-layer.md), first half. One
module, `src/evidence/fetch.ts`, plus 25 tests and one new runtime dependency
(`p-retry`). It is the first code in this repo that can touch the network, and
the choke point CLAUDE.md names: _"Fetching goes through `src/evidence/fetch.ts`
so everything is cached and recorded. Never call `fetch` directly from a stage."_

**The ticket is not finished.** Its HTML→text half — `cheerio` and
`@mozilla/readability` — is deliberately not in this change, for a reason that
needs a decision from the author. See _"The half that is missing"_ below.

## What I asked for

Continue implementation, stop for review before committing, keep the diff small
and reviewable, keep adding worklogs with reflection hints, update ticket status.

## What the AI produced

`src/evidence/fetch.ts` — one call, `httpGet`, and the pieces it is built from,
each exported because each is separately testable and one of them is a
precondition other tickets have to share:

- **`httpGet(url, options)`** → `HttpSuccess | HttpFailure`. Resolves for every
  outcome a network can produce: 200, 404, an exhausted retry budget, a dead
  host, a body that could not be read. `options` injects the transport, the
  clock, `sleep`, the cache directory and the retry policy, so every test drives
  it offline with no timers.
- **`fetchFailedEvidence(failure)`** → an `Evidence` of type `fetch_failed`
  (ARCHITECTURE §5), with the failure reason as its text.
- **`isFetchableUrl(url)`** — the http(s) precondition, exported so TICKET-0010
  filters with this predicate rather than a lookalike.
- **`retryAfterMs(header, now)`** — both RFC 9110 forms, clock injected.
- **`cacheKey(url, method)`** — `sha256("GET <url>")`, the cache filename.
- **`USER_AGENT`, `HTTP_CACHE_DIR`, `HTTP_CACHE_MAX_AGE_MS`, `DEFAULT_RETRY`,
  `RETRYABLE_STATUS`** — the policy constants, in one place, each with the
  reason it holds that value.

`tests/evidence-fetch.test.ts` — 25 tests against a scripted stub transport, a
fixed clock and a `sleep` that records instead of waiting. `package.json` and
the lockfile gain `p-retry` and nothing else. No other file changed:
`.gitignore` already excluded `.cache/http/`, from TICKET-0001.

## Five judgement calls, in descending order of how much they need review

**1. A cache hit replays the original `retrieved_at` — and therefore needed a
max age.** Evidence ids are `sha256(url + retrieved_at)`, so if a warm cache
returned "now" as the retrieval time, re-running a run would produce a second
evidence record, under a second id, for a page nobody re-fetched. Replaying the
stored timestamp instead makes a re-run over a warm cache produce _the same
evidence ids_ — which is what replay (ARCHITECTURE §4) should mean. The cost
lands immediately: a cache entry from last week would then have this run citing
a page "as of" a date the run did not happen on. Hence
`HTTP_CACHE_MAX_AGE_MS = 24h` — old enough to cover a working session and a
re-run after a crash, short enough that the timestamp cannot misdescribe the
run by more than a day. It is a judgement call, not a measurement, and it is
labelled as one in the code.

**2. What gets cached: a 404 yes, a 503 no, a 429 no.** The cache is a local
speedup (it is gitignored), but it also decides what a re-run sees. A 404 is a
stable fact about a site and worth replaying; a 503 and a final 429 are facts
about one minute, and caching them would make a transient outage sticky for a
day. So `isCacheable` is `200 ≤ status < 500, excluding 429`. The consequence:
a run that fails on a rate limit re-requests on the next run, which is the
behaviour you want and also the more expensive one.

**3. `httpGet` throws on a url that is not http(s), and only there.** Everything
else is a result. The reasoning: a candidate url is _data_ — it arrives from an
HN post — so it must never crash a run, but by the time it reaches this layer it
has already been through resolution (TICKET-0010) and a non-http url at that
point is a bug in the caller, not a dead site. The awkward part is that this
splits url handling across two tickets, so `isFetchableUrl` is exported as the
exact predicate 0010 has to filter with. The alternative — returning a failure
result — was rejected because `Evidence.url` is `z.url()`, so a `fetch_failed`
record for `file:///etc/passwd` cannot be constructed anyway: the failure would
just move one line later and become a Zod error.

**4. A corrupt cache entry is a miss; a corrupt evidence record is an error.**
Deliberately the opposite of `store.ts`, which reports a torn file as `invalid`
and lets the validator hard-fail. The asymmetry is the point: evidence records
are committed and are what a claim is traced to, so a bad one is a correctness
problem; an http cache entry is a re-fetchable local optimisation, so a bad one
is a cache miss and the run continues. Both reads use the same defensive shape,
and they draw opposite conclusions from it on purpose.

**5. `p-retry` rather than a hand-rolled loop, and `Retry-After` layered on
top.** The dependency is pre-justified in ARCHITECTURE §8 and ADR-0005, so it
needs no new ADR — but it does not do `Retry-After` on its own. The header is
honoured in `onFailedAttempt`, guarded by the same cap that `shouldRetry` uses,
so a `Retry-After: 600` ends the attempt _without_ sleeping first rather than
parking a run for ten minutes. That ordering is subtle enough to have its own
test. What `p-retry` actually buys over ~15 lines of loop is backoff arithmetic
and the retry-budget bookkeeping; if a reviewer thinks that is not worth a
dependency, removing it is contained to one function.

## The half that is missing, and the decision behind it

The ticket also asks for HTML→text: `cheerio` for targeted extraction,
`@mozilla/readability` for article prose, both named in ARCHITECTURE §8 and
ADR-0005. That half is not in this change, because shipping it as specified
means adding a dependency that no document in this repo mentions.

`@mozilla/readability` does not parse HTML. It takes a DOM `Document`, which in
Node means `jsdom` (or `linkedom`, or `happy-dom`) underneath it. So the line in
ADR-0005 that reads as two small libraries is really three, and the third is the
largest runtime dependency in the project — for prose extraction, on a pipeline
whose own ADR says _"our extraction is mostly structured, not prose"_.

The smaller version is cheerio alone: it parses HTML, and stripping
`script/style/nav/footer/aside` and reading `<title>`, `og:` tags, and the main
content block covers the three things stage 2 actually reads — a team page, a
meta description, and repo metadata. It is worse on long article prose, which is
what readability is for, and this pipeline reads few articles.

This is left for the author rather than assumed, because it edits ADR-0005's
consequences either way. It is now **D-8** in `STATE.md` with a default
(cheerio-only), so a session that does not want to wait can take the default and
record it.

## What is deliberately not here

- **No `fetchEvidence(url, type)` convenience** that returns an `Evidence` for
  success as well as failure. It cannot be honest until extraction exists —
  putting a raw HTML body in `Evidence.text` would mean the model reading
  `<script>` tags, and the 8k truncation limit would be spent on markup. It
  lands with the extraction half, in the same file.
- **No conditional requests** (`ETag` / `If-Modified-Since`). The cache is
  keyed by url with a 24-hour age limit and the corpus is a few hundred pages
  per run; revalidation would add a header round-trip and a second code path to
  save bandwidth nobody is paying for.
- **No robots.txt handling, no rate limiter, no concurrency pool.** Stage 1
  fetches on the order of tens of urls. A limiter belongs with the code that
  knows the fan-out (TICKET-0017), not with the code that makes one request.
- **No `POST`.** `cacheKey` takes a method so the cache does not have to change
  when something needs one; nothing in the pipeline does yet.

## Verification

| Acceptance criterion (ticket)                                                    | Result                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Cache hit avoids a second request                                                | pass — and the second call reports `attempts: 0`, `from_cache: true` |
| 429 retries then succeeds                                                        | pass — plus `Retry-After` honoured, and capped without sleeping      |
| Permanent failure yields `fetch_failed`, not an exception                        | pass — for a 404, an exhausted budget, and a dead host               |
| HTML extraction strips boilerplate on a fixture page                             | **not done** — see "The half that is missing"                        |
| `grep -rn "fetch(" src/ --include='*.ts'` finds no direct call outside this file | pass — one match, `globalThis.fetch` as the default transport        |

`pnpm test` 103 passed (17 CLI + 28 contracts + 14 config + 19 evidence store +
25 fetch), `pnpm typecheck` clean, `pnpm lint` clean. The suite makes no network
call and writes only to `mkdtemp` directories, which it removes.

Beyond the acceptance list, the suite pins: a stale cache entry is re-fetched
rather than misdating the run; a warm cache produces the same evidence id as the
cold fetch that filled it; a corrupt cache file is a miss and not a throw; a 404
is cached and a 503 is not; a 404 is not retried; a non-http url throws before
any request is made; and the `User-Agent` actually goes out on the wire.

## What went wrong

The first draft of the test stub replayed a queue of responses and returned
`undefined` once it ran dry, so the two tests that assert "the transport throws"
passed against the _stub's_ error message instead of the injected one. They
still went green — the reason string simply said "stub transport ran out of
responses" rather than `ENOTFOUND`, and only the `toContain("ENOTFOUND")`
assertion caught it. Same failure mode as the garbled ternary in session 0010:
a generated test that passes for the wrong reason. Two sessions in a row is a
pattern, and the mitigation both times was reading the assertion output rather
than the pass count.

`biome` also reformatted two lines after the tests were written; the gates
caught it, which is what they are for.

## Decisions taken

No open decision was closed. **D-8 is new** — `@mozilla/readability` and its DOM
dependency, described above, with cheerio-only as the default if unanswered.
D-2, D-4, D-5, D-6 and D-7 stay open. `HTTP_CACHE_MAX_AGE_MS` is a labelled
guess of the same kind as `EVIDENCE_TEXT_LIMIT` and `--min-hits`, and for the
same reason is not raised to a STATE decision: there is no fork behind it, only
a number to revise once a real run exists.

## Attribution

`src/evidence/fetch.ts`, `tests/evidence-fetch.test.ts`, the ticket status
changes and the factual sections of this entry: AI-written end-to-end from one
prompt, reviewed by me before the commit. The five judgement calls and the D-8
question were the AI's and were surfaced before the commit rather than after.

## Reflection

A single point for network call will help bring consistency and make it easier to debug and manage network related issues. File based caches are good for local development and testing, but will not scale for production use. Cache strategy takes HTTP status codes into consideration, quite a cognitive step, 404 may not change, but 503 can and should be retried. Retries are good, but with a cap.

## Next

Finish TICKET-0008 — the extraction half — once D-8 is answered, then
[TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md), the HN Algolia
adapter, which is the first caller of `httpGet` and the first module that turns
a real response into `makeEvidence`.
