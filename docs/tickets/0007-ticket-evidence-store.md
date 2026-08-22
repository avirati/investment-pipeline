# TICKET-0007 — Evidence store (`src/evidence/store.ts`)

Status: **Done** — [worklog 0010](../worklog/0010-evidence-store.md) · Depends on: 0005 · Blocks: 0008, 0017, 0025
Reads: [ADR-0003](../adr/0003-evidence-store-and-citations.md), [ARCHITECTURE §3](../ARCHITECTURE.md#3-evidence-store-and-citations)

## Why

The citation guarantee is structural, and this module is the structure. Everything
downstream — extraction, the memo validator, a reviewer opening a JSON file — is
reading what this writes.

## Scope

- `Evidence.id = sha256(url + retrieved_at)`, truncated. One helper, used
  everywhere an id is produced; never recomputed inline.
- Content-addressed read/write under `runs/<run_id>/evidence/<id>.json`.
- Writing the same record twice is a no-op, not a duplicate.
- `read(id)` returns the record or a typed miss — the validator (TICKET-0025)
  needs to distinguish "no file" from "unreadable file".
- Per-record text truncation with the limit named in one constant, since ADR-0003
  identifies bundle length as the known cost.
- Records are committed to the repo. Raw HTTP bodies are not (`.gitignore`).

## Acceptance

- Tests: id is stable for the same `(url, retrieved_at)` and differs when either
  changes; double-write produces one file; `read` of an unknown id returns a miss
  rather than throwing; truncation is applied and recorded.
- Written records round-trip through the `Evidence` schema.
