# TICKET-0027 — `./pipeline run` and replay

Status: **Ready** — 0026 is Done; 0022 is shipped and with the author. It is also the ticket that retires `EXIT.UNIMPLEMENTED`, whose last caller is now `run` alone · Depends on: 0012 (Done), 0022 (In review), 0026 (Done) · Blocks: 0028
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
