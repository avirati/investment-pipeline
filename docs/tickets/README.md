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
- **A ticket's status is updated in the commit that changes it**, along with the
  status line of every ticket it unblocks. Status lives in the ticket header;
  this file indexes it. `STATE.md` counts them and names the next one.

## Order

Follows STATE's *"Next session — start here"*. **TICKET-0013 is a hard gate**:
STATE says do not build stages 2 and 3 speculatively before it reports back, and
that instruction is load-bearing — stage 1 gates everything downstream and two
numbers in the spec are labelled guesses that only real output can settle. It
gates 0014–0017 and 0019–0022. **TICKET-0018 sits outside it** — 0011's
clarifier needs the provider seam and 0011 is upstream of the gate, so the
original `0014–0022` range was a cycle. The reasoning is recorded in 0013.

## Status

Each ticket carries its status in its header line, and the table below is the
index of the same thing. Three values, and only three:

- **Done** — shipped and reviewed. The header links the worklog entry that
  describes what actually happened, which is one hop from the commit.
- **Ready** — every dependency is Done. More than one ticket can be Ready; the
  order below is the recommended one, not the only legal one.
- **Blocked · `NNNN`** — the header names the dependencies that are *not yet
  Done*, rather than restating the full `Depends on` list. When a ticket lands,
  the tickets it unblocks are updated in the same commit. A ticket whose
  blocking list has emptied but still says Blocked is a bug in this file.

| # | Ticket | Lands | Status |
|---|---|---|---|
| [0001](./0001-ticket-repo-scaffold.md) | Repo scaffold and toolchain | `pnpm install/test/typecheck/lint` work · **D-1** | Done |
| [0002](./0002-ticket-cut-feed-seed-form.md) | Cut the `feed` seed form | Docs stop contradicting ADR-0004 · **D-3** | Done |
| [0003](./0003-ticket-cli-skeleton-and-help.md) | CLI skeleton and `--help` contract | `--help` on every command | Done |
| [0004](./0004-ticket-setup-script-and-wrapper.md) | `setup.sh` and `./pipeline` | Clone-and-run, minus step 6 | Done |
| [0005](./0005-ticket-zod-contracts.md) | Zod contracts | The stage boundary | Done |
| [0006](./0006-ticket-config-and-model-routing.md) | Config and model routing | Provider swap is an env change | Done |
| [0007](./0007-ticket-evidence-store.md) | Evidence store | Content-addressed ids | Done |
| [0008](./0008-ticket-cached-fetch-layer.md) | Cached fetch layer | One choke point for all network | Done |
| [0009](./0009-ticket-hn-algolia-adapter.md) | HN Algolia adapter | Sourcing + the usable classifier | **Reopened** — three fixes from the 0013 gate (F1, F2, and F4 moved from 0010) |
| [0010](./0010-ticket-url-resolution-and-dedup.md) | URL resolution and dedup | One company, one candidate | Done — reopened by the gate, F3 and F5 landed, F4 moved to 0009 |
| [0011](./0011-ticket-query-planning.md) | Query planning: probe, then clarify | `query_plan.json` | Done — the clarifier is a seam 0018 fills |
| [0012](./0012-ticket-stage-1-wiring.md) | Stage 1 wiring | `./pipeline source` · manifest v1 | Done |
| **[0013](./0013-ticket-gate-hand-check-candidates.md)** | **GATE — hand-check the candidates** | **Junk rate · D-5 · D-6** | Done — [worklog 0022](../worklog/0022-gate-hand-check.md) |
| [0014](./0014-ticket-fixture-capture-script.md) | `pnpm capture-fixtures` | The suite stays offline | **Ready** |
| [0015](./0015-ticket-github-adapter.md) | GitHub adapter | Evidence for D1/D3/D5 | Blocked · 0014 |
| [0016](./0016-ticket-company-site-adapter.md) | Company site adapter | Founders, positioning, self-serve path | Blocked · 0014 |
| [0017](./0017-ticket-evidence-gather.md) | Evidence gather (2a) | Bundles with ids, no LLM | Blocked · 0015, 0016 |
| [0018](./0018-ticket-llm-provider-and-cache.md) | LLM seam and response cache | Replay costs nothing | **Ready** |
| [0019](./0019-ticket-extraction-prompt.md) | Extraction prompt + CHANGELOG | Versioned, thesis-free | Blocked · 0017 |
| [0020](./0020-ticket-fact-extraction.md) | Fact extraction (2b) | Facts only, ids enforced | Blocked · 0018, 0019 |
| [0021](./0021-ticket-rubric-scoring.md) | The rubric | The only place a score exists | Blocked · 0020 |
| [0022](./0022-ticket-stage-2-wiring.md) | Stage 2 wiring | `./pipeline analyse` | Blocked · 0017, 0020, 0021 |
| [0023](./0023-ticket-missing-data-path-tests.md) | Missing-data path tests | Robustness as behaviour | Blocked · 0022, 0026 |
| [0024](./0024-ticket-memo-template-and-render.md) | Memo template and renderer | One page, no LLM · **D-2** | Blocked · 0022 |
| [0025](./0025-ticket-memo-validator.md) | Citation validator | The one hard fail | Blocked · 0024 |
| [0026](./0026-ticket-stage-3-wiring.md) | Stage 3 wiring | `./pipeline memo`, offline | Blocked · 0024, 0025 |
| [0027](./0027-ticket-run-command-and-replay.md) | `run` and replay | One command · full manifest | Blocked · 0012, 0022, 0026 |
| [0028](./0028-ticket-committed-sample-run.md) | Committed sample run | `setup.sh` step 6 · no key needed | Blocked · 0013, 0023, 0027 |
| [0029](./0029-ticket-docs-closeout.md) | Docs closeout | STATE, worklogs, checklist | Blocked · 0028 |
| [0030](./0030-ticket-walkthrough-video.md) | Walkthrough video | The other half of the deliverable | Blocked · 0029 |

## Decisions carried by tickets

Every open decision in STATE lands somewhere, taking its documented default
rather than blocking:

| Decision | Ticket | Taken as |
|---|---|---|
| D-1 model defaults | 0001 | Empty values, roles named in comments |
| D-2 memo rendering | 0024 | `eta` |
| D-3 `feed` seed form | 0002 | Cut |
| D-4 worklog reflections | 0029 | Left `TODO(author)` — **not** to be written by an assistant |
| D-5 sample run topic | 0013 → 0028 | **Taken**: `AI agent infrastructure` — cleanest of four live runs |
| D-6 `--min-hits` = 8 | 0013 | **Closed**: kept. 26–35/50 on three topics, 3/6 on the one that produced the junk |
| D-7 ADR-0005/0006 padding | — | Author review; no code depends on it |

## Not tickets

Anything on [SCOPE](../SCOPE.md)'s out-of-scope list. In particular there is **no
eval-harness ticket**, and adding one is a scope change requiring a new ADR, not
a backlog item. Same for additional sources, a database, and a web UI.
