# TICKET-0012 — Stage 1 wiring: `./pipeline source`

Status: Blocked · 0009, 0010, 0011 · Depends on: 0003, 0009, 0010, 0011 · Blocks: 0013, 0027
Reads: [ARCHITECTURE §1, §4, §5](../ARCHITECTURE.md), [ADR-0001](../adr/0001-file-based-staged-pipeline.md)

## Why

First end-to-end artifact. After this ticket the repo does something real against
a live source, which is what TICKET-0013 needs in order to check anything.

## Scope

- `./pipeline source --seed "<topic>"` → plan → fetch → resolve → dedup →
  `runs/<run_id>/candidates.jsonl`.
- The `urls` seed form (one URL per line) — the other survivor of TICKET-0002.
- **Run id**: date-and-seed-derived slug; `--run` overrides. Refuse to overwrite
  an existing run directory (ADR-0001 names this as the concurrency guard).
- `manifest.json` v1: seed, git sha of the producing code, provider + models,
  prompt versions, counts, timings, per-candidate status. Later stages append;
  completeness is TICKET-0027's job.
- `--limit` and `--since` honoured here.
- Failure policy per ARCHITECTURE §5: source API 429/5xx retries then fails the
  run (no candidates means no pipeline); everything softer degrades and records.
- Candidate yield below 10 fires the documented fallback — widened window and
  expansion — and the fallback firing is recorded in the manifest so a reviewer
  sees it (SCOPE risks table).

## Acceptance

- A live topic run produces 10–20 deduped candidates and a readable
  `candidates.jsonl` (`jq` over it, per ADR-0001's whole argument).
- Re-running with the same run id refuses rather than overwrites.
- `manifest.json` records the git sha, and re-running the same seed after a code
  change shows a different sha.
- Offline tests cover the wiring against fixtures; the live run is manual.
