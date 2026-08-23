# TICKET-0022 — Stage 2 wiring: `./pipeline analyse`

Status: **In review** — [worklog 0033](../worklog/0033-stage-2-wiring.md). `src/analyse/index.ts` and `./pipeline analyse`, 30 tests; every acceptance item is met offline. Two things are recorded rather than fixed — the stage has still never been run against a live provider (inconsistency 69/72, and the first call is the author's), and the `Analysis` fields SPEC §4's memo needs are only half added (inconsistency 9, gap 5) · Depends on: 0003 (Done), 0017 (Done), 0020 (In review), 0021 (In review) · Blocks: 0023, 0024, 0027
Reads: [ARCHITECTURE §1, §4, §5](../ARCHITECTURE.md)

## Why

Turns three modules into a stage that can be run alone against a previous run's
output, which is the whole point of the file-based handoff.

## Scope

- `./pipeline analyse --run <run_id>` reads `candidates.jsonl` → gather →
  extract → score → `runs/<run_id>/analyses/<slug>.json`.
- Bounded concurrency across candidates.
- **Per-candidate failures never abort the run** (ARCHITECTURE §5). Each
  candidate's status lands in the manifest: `ok`, `partial`, `failed`, with the
  reason.
- Re-runnable from stage 1's output without re-running stage 1.
- `--replay` reuses the LLM cache and spends nothing.
- Append to `manifest.json`: per-candidate status, timings, token counts, cost.

## Acceptance

- [x] Against a committed stage-1 output, `analyse` produces one JSON per
      candidate that round-trips through the `Analysis` schema.
- [x] A run where one candidate's site 404s and another's model call fails twice
      still completes, with both recorded and the others `ok`.
- [x] Re-running with `--replay` makes zero network calls — asserted, not
      assumed: the transport is replaced by one that refuses, so the code path
      cannot make a request.
