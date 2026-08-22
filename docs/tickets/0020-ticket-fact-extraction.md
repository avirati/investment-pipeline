# TICKET-0020 — Fact extraction, step 2b (`src/analyse/extract.ts`)

Status: **In review** — the module, the vocabulary and 47 tests are in ([worklog 0031](../worklog/0031-fact-extraction.md)). Three of the four acceptance items are met offline; **the first captured model output is outstanding** — it needs `MODEL_EXTRACT` set (D-1's default leaves it empty) and a live call that spends money, so it is the author's · Depends on: 0018 (Done), 0019 (Done) · Blocks: 0021, 0022
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

## What landed, against the acceptance list

- ✅ `withStructuredOutput` against the contract — `extractionSchema(ids)` is
  built per bundle and names the citable ids as an enum, so a hallucinated id is
  a shape the model cannot produce as well as a fact we drop.
- ✅ Facts without `evidence_ids` are dropped at parse time, recorded with the
  index, the claimed key and the reason.
- ✅ Ids outside the bundle are rejected — and the world is narrowed further to
  what was *shown*, so a `fetch_failed` record's id is not citable either.
- ✅ Invalid structure retries once with the parse error appended, then marks the
  candidate `partial`, asserted.
- ◐ An all-null response parses to valid, cited facts, asserted against
  `facts-unknown.json`. The other half — `unknowns[]` populated on the
  `Analysis` — cannot be asserted here: nothing builds an `Analysis` until
  TICKET-0022, and this module deliberately emits facts and nothing else.
- ❌ **The first captured model output.** Not done: no live call has been made.

Two additions the ticket did not ask for and that a reviewer should agree with
before this closes: the key vocabulary is **enumerated** (`src/analyse/keys.ts`),
so an invented key is dropped; and a bundle with no readable evidence returns
`no_evidence` without calling the model at all.
