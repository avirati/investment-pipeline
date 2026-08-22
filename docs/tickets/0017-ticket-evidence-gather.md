# TICKET-0017 — Evidence gather, step 2a (`src/analyse/gather.ts`)

Status: Open · Depends on: 0015, 0016 · Blocks: 0020
Reads: [ARCHITECTURE §1 stage 2a, §3](../ARCHITECTURE.md), [ADR-0003](../adr/0003-evidence-store-and-citations.md)

## Why

2a is deterministic, cached, and has no LLM in it. Keeping it a separate module
from extraction is what makes that property checkable rather than asserted.

## Scope

- For one candidate: company site + GitHub org + the HN thread → a bundle of
  `Evidence` records, each already written to the store with its id.
- Bounded concurrency across candidates — a `Promise.all` with a cap is the
  entire concurrency requirement (SCOPE: no queue).
- The bundle handed to extraction carries **ids alongside text**. That is the
  mechanism of closed-world citation; the model can only cite what it was given.
- Bundle size bounded by per-record truncation and by preferring targeted
  extraction over whole-page dumps (ADR-0003's stated cost).
- A candidate with zero usable evidence still produces a bundle — an empty one —
  and continues. It becomes a low-coverage analysis, not a crash.

## Acceptance

- Tests: a bundle from fixtures contains ids matching files on disk; a candidate
  whose site and GitHub both fail yields a bundle of `fetch_failed` records and
  the run continues.
- Assert **no LLM call** happens in 2a, via a stub that fails the test if invoked.
