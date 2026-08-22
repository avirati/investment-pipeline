# Tickets

Derived from the committed specification on 2026-08-22, at the point where
[STATE.md](../STATE.md) read *"specification complete, no code yet"*.

Each ticket states **what to build** and **how it will be judged**. It does not
restate *why* — that lives in [SPEC](../SPEC.md), [ARCHITECTURE](../ARCHITECTURE.md),
[SCOPE](../SCOPE.md), [TESTING](../TESTING.md), and the [ADRs](../adr/), and every
ticket links to the sections it implements. If a ticket and a doc disagree, the
doc wins and the ticket is the bug.

## Rules

- **Every ticket leaves the repo runnable.** `pnpm test`, `pnpm typecheck`, and
  `pnpm lint` pass on a fresh clone at the end of each one, offline and with no
  API key.
- **Tests ship with the module they test**, not in a later ticket. The two
  exceptions are cross-cutting by nature: TICKET-0014 (fixtures) and TICKET-0023
  (missing-data paths).
- One logical change per ticket, one atomic commit or a small series — never a
  refactor mixed with a feature ([CLAUDE.md](../../CLAUDE.md)).
- Tickets that resolve an open decision from STATE say which, and the worklog
  says so too.

## Order

Follows STATE's *"Next session — start here"*. **TICKET-0013 is a hard gate**:
STATE says do not build stages 2 and 3 speculatively before it reports back, and
that instruction is load-bearing — stage 1 gates everything downstream and two
numbers in the spec are labelled guesses that only real output can settle.

| # | Ticket | Lands |
|---|---|---|
| [0001](./0001-ticket-repo-scaffold.md) | Repo scaffold and toolchain | `pnpm install/test/typecheck/lint` work · **D-1** |
| [0002](./0002-ticket-cut-feed-seed-form.md) | Cut the `feed` seed form | Docs stop contradicting ADR-0004 · **D-3** |
| [0003](./0003-ticket-cli-skeleton-and-help.md) | CLI skeleton and `--help` contract | `--help` on every command |
| [0004](./0004-ticket-setup-script-and-wrapper.md) | `setup.sh` and `./pipeline` | Clone-and-run, minus step 6 |
| [0005](./0005-ticket-zod-contracts.md) | Zod contracts | The stage boundary |
| [0006](./0006-ticket-config-and-model-routing.md) | Config and model routing | Provider swap is an env change |
| [0007](./0007-ticket-evidence-store.md) | Evidence store | Content-addressed ids |
| [0008](./0008-ticket-cached-fetch-layer.md) | Cached fetch layer | One choke point for all network |
| [0009](./0009-ticket-hn-algolia-adapter.md) | HN Algolia adapter | Sourcing + the usable classifier |
| [0010](./0010-ticket-url-resolution-and-dedup.md) | URL resolution and dedup | One company, one candidate |
| [0011](./0011-ticket-query-planning.md) | Query planning: probe, then clarify | `query_plan.json` |
| [0012](./0012-ticket-stage-1-wiring.md) | Stage 1 wiring | `./pipeline source` · manifest v1 |
| **[0013](./0013-ticket-gate-hand-check-candidates.md)** | **GATE — hand-check the candidates** | **Junk rate · D-5 · D-6** |
| [0014](./0014-ticket-fixture-capture-script.md) | `pnpm capture-fixtures` | The suite stays offline |
| [0015](./0015-ticket-github-adapter.md) | GitHub adapter | Evidence for D1/D3/D5 |
| [0016](./0016-ticket-company-site-adapter.md) | Company site adapter | Founders, positioning, self-serve path |
| [0017](./0017-ticket-evidence-gather.md) | Evidence gather (2a) | Bundles with ids, no LLM |
| [0018](./0018-ticket-llm-provider-and-cache.md) | LLM seam and response cache | Replay costs nothing |
| [0019](./0019-ticket-extraction-prompt.md) | Extraction prompt + CHANGELOG | Versioned, thesis-free |
| [0020](./0020-ticket-fact-extraction.md) | Fact extraction (2b) | Facts only, ids enforced |
| [0021](./0021-ticket-rubric-scoring.md) | The rubric | The only place a score exists |
| [0022](./0022-ticket-stage-2-wiring.md) | Stage 2 wiring | `./pipeline analyse` |
| [0023](./0023-ticket-missing-data-path-tests.md) | Missing-data path tests | Robustness as behaviour |
| [0024](./0024-ticket-memo-template-and-render.md) | Memo template and renderer | One page, no LLM · **D-2** |
| [0025](./0025-ticket-memo-validator.md) | Citation validator | The one hard fail |
| [0026](./0026-ticket-stage-3-wiring.md) | Stage 3 wiring | `./pipeline memo`, offline |
| [0027](./0027-ticket-run-command-and-replay.md) | `run` and replay | One command · full manifest |
| [0028](./0028-ticket-committed-sample-run.md) | Committed sample run | `setup.sh` step 6 · no key needed |
| [0029](./0029-ticket-docs-closeout.md) | Docs closeout | STATE, worklogs, checklist |
| [0030](./0030-ticket-walkthrough-video.md) | Walkthrough video | The other half of the deliverable |

## Decisions carried by tickets

Every open decision in STATE lands somewhere, taking its documented default
rather than blocking:

| Decision | Ticket | Taken as |
|---|---|---|
| D-1 model defaults | 0001 | Empty values, roles named in comments |
| D-2 memo rendering | 0024 | `eta` |
| D-3 `feed` seed form | 0002 | Cut |
| D-4 worklog reflections | 0029 | Left `TODO(author)` — **not** to be written by an assistant |
| D-5 sample run topic | 0013 → 0028 | Decided from real stage-1 output |
| D-6 `--min-hits` = 8 | 0013 | Kept until data contradicts it |
| D-7 ADR-0005/0006 padding | — | Author review; no code depends on it |

## Not tickets

Anything on [SCOPE](../SCOPE.md)'s out-of-scope list. In particular there is **no
eval-harness ticket**, and adding one is a scope change requiring a new ADR, not
a backlog item. Same for additional sources, a database, and a web UI.
