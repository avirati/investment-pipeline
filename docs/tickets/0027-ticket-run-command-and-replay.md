# TICKET-0027 — `./pipeline run` and replay

Status: **Done** — [worklog 0039](../worklog/0039-bundles-and-the-run-command.md), commit `7e3790c`. `EXIT.UNIMPLEMENTED` is retired with it. Acceptance met, with two notes below · Depends on: 0012 (Done), 0022 (In review), 0026 (Done) · Blocks: 0028 (Done)
Reads: [ARCHITECTURE §4, §7](../ARCHITECTURE.md), [SPEC §5](../SPEC.md#5-acceptance-criteria), [ADR-0001](../adr/0001-file-based-staged-pipeline.md)

## Why

`run` exists so a partner types one thing. SPEC's first acceptance criterion is
`./setup.sh` then one command, memos out.

## Scope

- `./pipeline run --seed "<topic>"` chains all three stages in one process,
  passing run id through.
- `--replay` reuses the LLM cache end-to-end, so re-running after a template or
  rubric change costs nothing (ARCHITECTURE §4).
- **Manifest completeness.** By the end of a `run`, `manifest.json` carries
  everything ARCHITECTURE §4 lists: seed, git sha, provider + models, prompt
  versions, counts, timings, cost, per-candidate status. Verify against that list
  item by item — earlier tickets each added their slice and drift is likely.
- A run of 10–20 candidates completes, tolerates individual candidate failures
  without aborting, and records what failed (SPEC §5).
- Progress output that makes a several-minute run legible while it runs.

## Acceptance

- One command from a clean checkout with a key produces memos.
- `--replay` of that same run makes zero network calls and produces identical
  memos.
- Every field in ARCHITECTURE §4's manifest list is present and non-placeholder.

## What closing it needed that the ticket did not say

1. **`--replay` was false in two places, not one.** The known half was
   [inconsistency 84](../STATE.md) — stage 2 re-fetching — and it needed
   [ADR-0009](../adr/0009-bundles-as-artifacts.md). The unknown half was **stage
   1 searching HN again**: `--replay` had only ever meant "reuse the run
   directory and the decided plan". Four live requests, and a real risk of
   changing the run, because HN moves. Stage 1 now reads the candidates it
   already decided.
2. **`cost_usd` is present and null**, which the ticket's "non-placeholder"
   wording does not obviously cover. It is deliberate: `PRICES` ships empty
   (`src/llm/provider.ts`, [inconsistency 54](../STATE.md)) because a wrong
   list price in a committed manifest is worse than an absent one. Token counts
   are recorded and are what the provider actually reported. Everything else on
   ARCHITECTURE §4's list is present and real, checked item by item by
   `tests/pipeline.test.ts`.
3. **"Tolerates individual candidate failures" is looser than the code.** A
   provider that will not answer produces a `partial` candidate — an analysis at
   lower coverage, and a memo — not a `failed` one. `failed` means no analysis
   exists. The `run` record counts both, separately.
