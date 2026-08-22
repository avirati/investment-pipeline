# ADR-0001 — File-based staged pipeline with content-addressed artifacts

Status: Accepted · 2026-08-22

## Context

Three stages must be separable, individually re-runnable, and replayable. A
reviewer must be able to read outputs without running anything, and re-run
without spending money. The dataset is 10–20 records per run.

## Options

1. **In-memory pipeline, one process.** Simplest. But a change to the memo
   template means re-sourcing and re-analysing — re-paying for LLM calls to fix a
   heading. Nothing intermediate is inspectable.
2. **SQLite with a table per stage.** Real queries, transactional. But outputs
   stop being readable in a diff, the reviewer needs a client to look at anything,
   and we would be committing a binary blob to satisfy "commit the outputs".
3. **File-based handoff — JSONL and JSON under `runs/<run_id>/`.** Each stage
   reads the previous stage's file and writes its own.

## Decision

Option 3. Stage boundaries are files with Zod contracts. Artifacts are
content-addressed where identity matters (evidence, LLM cache).

## Consequences

**Good.** Every intermediate state is a file a reviewer can open, `jq`, and
diff. Re-running one stage is trivial and free. Committed outputs satisfy the
brief directly rather than as an extra export step. Debugging a bad memo means
reading three JSON files, not attaching a debugger.

**Bad.** No cross-run queries without writing a script. Concurrent runs must not
share a `run_id` — enforced by making `run_id` date-and-seed derived and
refusing to overwrite. At 10k candidates this design would fail; at 20 it is
correct.

**Cost.** The repo carries its artifacts. Raw HTML is excluded from git for this
reason; normalised records are small and stay.

## Revisit if

Runs exceed a few hundred candidates, or cross-run temporal comparison becomes a
requirement. Both point at SQLite, and the file layout migrates into it cleanly.
