# investment-pipeline

An internal triage pipeline for a seed-stage VC firm. Point it at a topic; get
back a one-page investment memo per startup ending in a clear call —
**Pass / Watch / Take a meeting** — with every claim traceable to a source.

Sources from Hacker News, enriches from GitHub and company sites, scores against
one stated thesis, and renders memos. Three stages, file-based handoff, fully
replayable.

## Quickstart

```bash
./setup.sh                                          # deps, .env, offline self-check
./pipeline run --seed "AI agents for SMBs" --limit 15
```

`setup.sh` is idempotent, never overwrites an existing `.env`, and finishes by
re-rendering the committed sample run — so it proves the toolchain works before
you have obtained a single API key.

Memos land in `memos/<run_id>/`. `./pipeline --help` documents everything, and
[a sample run of 12 companies](memos/2026-08-23-ai-agent-infrastructure/) is
committed, so you can read real outputs without a key:

```bash
./pipeline memo --run 2026-08-23-ai-agent-infrastructure     # re-render, zero network
./pipeline run  --run 2026-08-23-ai-agent-infrastructure --seed "AI agent infrastructure" --replay
pnpm test                                              # offline, no key required
```

The `--replay` line re-runs **all three stages** without a network call or a
token: stage 1 reads the candidates it decided, stage 2 reads
`runs/<id>/bundles/` and the committed LLM cache, stage 3 re-renders
([ADR-0009](docs/adr/0009-bundles-as-artifacts.md)).

> **Read [docs/STATE.md](docs/STATE.md) before trusting a number in those
> memos.** The twelve calls were read by hand and one of them is wrong — a
> disqualifier fired against evidence quoted two sections above it in the same
> memo. The rubric is also unvalidated by design: there is no eval harness, and
> [SCOPE.md](docs/SCOPE.md) says why it was cut.

If a topic query returns too little to work with, stage 1 says so and offers
refinements rather than silently proceeding with four bad candidates. Whatever
you choose is committed to `query_plan.json`, and replays never ask again.

## The thesis

> We back technical founders building AI-native infrastructure that developers
> adopt before it is sold to them.

Scored across five weighted dimensions with anchored bands, plus four
disqualifiers that pass on a company regardless of score. Scoring is
deterministic code over facts extracted from cited evidence — never a number
asked of a model — so any score is recomputable by hand from the analysis JSON.
Full rubric: [docs/SPEC.md](docs/SPEC.md).

## How it works

```
seed → SOURCE → candidates.jsonl → ANALYSE → analyses/*.json → MEMO → memos/*.md
                                   ├ gather   deterministic, cached, cited
                                   ├ extract  LLM → facts + evidence ids
                                   └ score    pure rubric, no LLM
```

The LLM appears in exactly one step. Everything before it is retrieval;
everything after it is arithmetic and templating. That is what makes scores
reproducible and memos auditable. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Every factual claim in a memo carries an evidence id resolving to a committed
JSON record with the source URL and its retrieval timestamp. A validator fails
the run if a memo cites a source that does not exist.

## Repo map

| Path | What |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Thesis, rubric, call thresholds, memo contract |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stages, contracts, replay, failure policy |
| [docs/STATE.md](docs/STATE.md) | Current phase, open decisions, next step — **start here** |
| [docs/tickets/](docs/tickets/) | The backlog — 30 tickets in dependency order, 27 Done |
| [docs/SCOPE.md](docs/SCOPE.md) | What is not being built, and why |
| [docs/TESTING.md](docs/TESTING.md) | What is tested, what is not, and the eval harness that was cut |
| [docs/adr/](docs/adr/) | Nine decision records, each with the rejected options |
| [docs/worklog/](docs/worklog/) | How this was actually built, session by session |
| [CLAUDE.md](CLAUDE.md) | Operating guide for AI assistants in this repo |

## How this was built

Built with heavy use of Claude Code, deliberately and on the record.
[docs/worklog/](docs/worklog/) is a dated account of each session: what the AI
proposed, what I took, what I overrode, and where its first answer was not its
best one. [docs/adr/](docs/adr/) carries the decisions themselves with the
options that lost. Attribution is per-artifact and explicit — where a module was
AI-written end-to-end, the worklog says so.
