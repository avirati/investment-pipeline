# TICKET-0008 — Cached fetch layer (`src/evidence/fetch.ts`)

Status: **Ready** — all dependencies Done · Depends on: 0007 · Blocks: 0009, 0010, 0015, 0016
Reads: [ARCHITECTURE §5, §8](../ARCHITECTURE.md), [CLAUDE.md](../../CLAUDE.md) conventions

## Why

CLAUDE.md: *all fetching goes through this module so everything is cached and
recorded. Never call `fetch` directly from a stage.* One choke point is also
the only way the failure policy in ARCHITECTURE §5 can be applied consistently.

## Scope

- Native `fetch` + `p-retry`, bounded retries with backoff on 429/5xx.
- HTTP cache on disk under `.cache/http/` (gitignored — bulky and re-fetchable).
- A descriptive User-Agent. Respect `Retry-After` when present.
- HTML → text: `cheerio` for targeted extraction, `@mozilla/readability` for
  article prose (ADR-0005 records why this pairing and what it costs).
- Failures return a typed result, never throw past the caller: a fetch that fails
  becomes an `Evidence` record of type `fetch_failed` (ARCHITECTURE §5), so a
  dead site is *recorded* evidence of a dead site.
- Adds runtime deps `p-retry`, `cheerio`, `@mozilla/readability` — all already
  justified in ARCHITECTURE §8, so no new ADR needed. Note them in the commit.

## Acceptance

- Tests, offline, against a stubbed transport: cache hit avoids a second request;
  429 retries then succeeds; permanent failure yields a `fetch_failed` record
  rather than an exception; HTML extraction strips boilerplate on a committed
  fixture page.
- `grep -rn "fetch(" src/ --include=*.ts` shows no direct call outside this file.
