# TICKET-0020 — Fact extraction, step 2b (`src/analyse/extract.ts`)

Status: Open · Depends on: 0018, 0019 · Blocks: 0021, 0022
Reads: [ARCHITECTURE §1 stage 2b, §5](../ARCHITECTURE.md), [ADR-0002](../adr/0002-deterministic-scoring.md), [ADR-0003](../adr/0003-evidence-store-and-citations.md), [TESTING §2](../TESTING.md)

## Why

The one narrowing-input step in the pipeline, and the only place the model's
output touches the artifact chain. Everything about its output surface is
constrained on purpose.

## Scope

- `withStructuredOutput(FactSchema)` against the Zod contract from TICKET-0005.
- **Facts without `evidence_ids` are dropped at parse time, not argued with**
  (ADR-0003). Dropping is recorded, so a reviewer can see it happened.
- **Ids not present in the supplied bundle are rejected**, not just unresolvable
  later. Closed-world means checked at the boundary.
- Invalid structure → retry once with the parse error appended; then mark the
  candidate `partial` and continue (ARCHITECTURE §5).
- Optional fields all-null is a valid response and must produce a valid,
  low-coverage analysis (TESTING §6).
- Output is facts only. If a score, a call, or memo prose ever appears in this
  module's return type, the invariant is broken.

## Acceptance

Per TESTING §2 and §6, offline with fixture model outputs:
- A fact arriving without `evidence_ids` is dropped and never rendered.
- A fact citing an id outside the bundle is rejected.
- Malformed JSON retries once, then marks `partial` — asserted, since this is the
  path that decides whether one bad candidate kills a run.
- Every-field-null response yields a parseable `Analysis` input with `unknowns[]`
  populated.
