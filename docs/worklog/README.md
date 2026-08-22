# Worklog

A dated record of how this repo was actually built — what was tried, what was
rejected, where the AI was wrong, and what I decided against its recommendation.

## Why this exists

The brief for this project weights "can we see how you worked with AI" at 40% and
warns against trails assembled after the fact. So these are written during the
session they describe, committed alongside the code they produced, and left
unedited afterwards except for explicit `Correction:` notes. An entry that later
turned out to be wrong stays in, wrong, with the correction appended — a worklog
that is retroactively made to look correct is worth nothing.

## What a reviewer should read

| Want to know | Read |
|---|---|
| What was decided and why | [../adr/](../adr/) — 7 records, each with rejected options |
| How the thing was built, session by session | The numbered entries here |
| How prompts evolved and why | `prompts/CHANGELOG.md` — arrives with stage 2 |
| How prompt and rubric changes were evaluated | `docs/evals/` — arrives with the first golden set |
| What is left to build, in order | [../tickets/](../tickets/) |
| What was cut and why | [../SCOPE.md](../SCOPE.md) |
| How the AI was steered | [../../CLAUDE.md](../../CLAUDE.md) |

## Entry format

```
## Session N — <date> — <title>
Goal · Approach · What the AI produced · What I rejected and why ·
What went wrong · Attribution · Reflection (author-written)
```

**Attribution** states plainly which parts were AI-written end-to-end, which were
AI-drafted then reworked, and which were hand-written.

**Reflection** is written by me, not generated. Sections marked `TODO(author)`
are unfinished, not delegated.

## Entries

| # | Date | Title |
|---|---|---|
| [0001](./0001-scoping-and-architecture.md) | 2026-08-22 | Scoping, thesis selection, and architecture |
| [0002](./0002-query-planning-tests-and-setup.md) | 2026-08-22 | Query planning, tests, CLI, setup |
| [0003](./0003-ticket-breakdown.md) | 2026-08-22 | Ticket breakdown |
| [0004](./0004-repo-scaffold.md) | 2026-08-22 | Repo scaffold |
| [0005](./0005-cut-feed-seed-form.md) | 2026-08-22 | Cutting the `feed` seed form |
| [0006](./0006-cli-skeleton.md) | 2026-08-22 | CLI skeleton and the `--help` contract |
| [0007](./0007-setup-script-and-wrapper.md) | 2026-08-22 | `setup.sh` and the `./pipeline` wrapper |
| [0008](./0008-zod-contracts.md) | 2026-08-22 | Zod contracts — the stage boundary |
| [0009](./0009-config-and-model-routing.md) | 2026-08-22 | Config and model routing |
| [0010](./0010-evidence-store.md) | 2026-08-22 | Evidence store |
| [0011](./0011-cached-fetch-layer.md) | 2026-08-22 | Cached fetch layer |
| [0012](./0012-cheerio-only-extraction.md) | 2026-08-22 | D-8: cheerio only, no DOM |
| [0013](./0013-cheerio-extraction.md) | 2026-08-22 | HTML→text extraction; TICKET-0008 closes |
| [0014](./0014-hn-query-and-parse.md) | 2026-08-22 | HN Algolia: query building and hit parsing |
| [0015](./0015-hn-usable-classifier.md) | 2026-08-22 | The usable-vs-unusable classifier |
| [0016](./0016-hn-paginated-search.md) | 2026-08-22 | `searchHn`: pagination, dedup, failures as data; TICKET-0009 closes |
| [0017](./0017-url-canonicalisation-and-dedup.md) | 2026-08-22 | URL canonicalisation, site keys and dedup |
| [0018](./0018-redirect-resolution.md) | 2026-08-22 | Redirect resolution; TICKET-0010 closes |
| [0019](./0019-query-planning.md) | 2026-08-22 | Query planning: probe, then clarify; TICKET-0011 closes |
| [0020](./0020-run-identity-and-candidates.md) | 2026-08-22 | Run identity, and posts become candidates |
| [0021](./0021-stage-1-wired.md) | 2026-08-22 | Stage 1 wired; `./pipeline source` is real; TICKET-0012 closes |
| [0022](./0022-gate-hand-check.md) | 2026-08-22 | The gate: four live runs read by hand; TICKET-0013 closes |
| [0023](./0023-gate-fixes-canonicalisation.md) | 2026-08-22 | The gate's canonicalisation fixes; TICKET-0010 closes again |
| [0024](./0024-gate-fixes-classifier-and-naming.md) | 2026-08-22 | The gate's classifier and naming fixes; junk 5 → 1; TICKET-0009 closes again |
| [0025](./0025-llm-provider-and-cache.md) | 2026-08-22 | LLM provider seam and the committed response cache; TICKET-0018 closes |
