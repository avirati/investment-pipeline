# TICKET-0008 — Cached fetch layer (`src/evidence/fetch.ts`)

Status: **Ready** — transport half shipped ([worklog 0011](../worklog/0011-cached-fetch-layer.md)); the HTML→text half is specified (D-8 closed, [worklog 0012](../worklog/0012-cheerio-only-extraction.md)) and not yet written · Depends on: 0007 · Blocks: 0009, 0010, 0015, 0016
Reads: [ARCHITECTURE §5, §8](../ARCHITECTURE.md), [CLAUDE.md](../../CLAUDE.md) conventions

## Why

CLAUDE.md: *all fetching goes through this module so everything is cached and
recorded. Never call `fetch` directly from a stage.* One choke point is also
the only way the failure policy in ARCHITECTURE §5 can be applied consistently.

## Scope

- Native `fetch` + `p-retry`, bounded retries with backoff on 429/5xx.
- HTTP cache on disk under `.cache/http/` (gitignored — bulky and re-fetchable).
- A descriptive User-Agent. Respect `Retry-After` when present.
- HTML → text: `cheerio` alone — strip `script/style/nav/footer/aside`, read
  `<title>`, `og:` tags and the main content block. `@mozilla/readability` was
  cut at D-8; the [ADR-0005 amendment](../adr/0005-typescript-stack.md) records
  why and what it costs.
- Failures return a typed result, never throw past the caller: a fetch that fails
  becomes an `Evidence` record of type `fetch_failed` (ARCHITECTURE §5), so a
  dead site is *recorded* evidence of a dead site.
- Adds runtime deps `p-retry` and `cheerio`, both justified in ARCHITECTURE §8,
  so no new ADR needed. Note them in the commit.

## Acceptance

- Tests, offline, against a stubbed transport: cache hit avoids a second request;
  429 retries then succeeds; permanent failure yields a `fetch_failed` record
  rather than an exception; HTML extraction strips boilerplate on a committed
  fixture page.
- `grep -rn "fetch(" src/ --include=*.ts` shows no direct call outside this file.

## Progress

Shipped in worklog 0011 — `httpGet`, the disk cache, the bounded retry policy
with `Retry-After`, `fetchFailedEvidence`, `isFetchableUrl`, and 25 offline
tests. `p-retry` added; `cheerio` not yet — nothing imports it.

Left to do — the HTML→text half. **D-8 is closed**: `cheerio` alone, no
`@mozilla/readability` and no DOM, recorded in the
[ADR-0005 amendment](../adr/0005-typescript-stack.md) and
[worklog 0012](../worklog/0012-cheerio-only-extraction.md). Nothing blocks it
now; it was simply not written in the same session as the decision. When it
lands it brings with it the `fetchEvidence(url, type)` convenience that returns
an `Evidence` for a success as well as a failure, plus the committed fixture
page for the boilerplate test.

The ticket is not Done until that half ships, so 0009, 0010, 0015 and 0016 stay
Blocked — even though 0009 only needs the transport half that already exists.
