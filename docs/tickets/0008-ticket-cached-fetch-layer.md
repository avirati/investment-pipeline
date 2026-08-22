# TICKET-0008 — Cached fetch layer (`src/evidence/fetch.ts`)

Status: **Done** — transport half in [worklog 0011](../worklog/0011-cached-fetch-layer.md), D-8 in [worklog 0012](../worklog/0012-cheerio-only-extraction.md), HTML→text half in [worklog 0013](../worklog/0013-cheerio-extraction.md) · Depends on: 0007 · Blocks: 0009, 0010, 0015, 0016
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

**Shipped in two sittings.**

[Worklog 0011](../worklog/0011-cached-fetch-layer.md) — the transport half:
`httpGet`, the disk cache, the bounded retry policy with `Retry-After`,
`fetchFailedEvidence`, `isFetchableUrl`, 25 offline tests, and `p-retry`. It
raised D-8, which [worklog 0012](../worklog/0012-cheerio-only-extraction.md)
closed at its default in documents only.

[Worklog 0013](../worklog/0013-cheerio-extraction.md) — the HTML→text half:
`extractHtml`, `looksLikeHtml`, `fetchEvidence(url, type)`, `cheerio`, the
committed fixture page at `tests/fixtures/company-site.html`, and 20 more tests.
Acceptance met: `grep -rn "fetch(" src/ --include='*.ts'` returns only the
injectable default inside this module. 123 tests pass offline with no key.

Three judgement calls inside the extraction are recorded in worklog 0013 and
carried as STATE inconsistencies rather than left implicit: `<header>` is kept
while `nav`/`footer`/`aside` are stripped, the meta description leads the
extracted text, and an empty `<main>` falls back to `<body>`.
