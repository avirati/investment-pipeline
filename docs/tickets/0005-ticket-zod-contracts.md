# TICKET-0005 — Zod contracts in `src/contracts/`

Status: **Done** — [worklog 0008](../worklog/0008-zod-contracts.md) · Depends on: 0001, 0002 · Blocks: 0006–0027
Reads: [ARCHITECTURE §2](../ARCHITECTURE.md#2-stage-contracts), [ADR-0005](../adr/0005-typescript-stack.md), [ADR-0003](../adr/0003-evidence-store-and-citations.md)

## Why

These are the only thing stages know about each other. STATE says get them right
before any stage logic exists, and that is correct — a contract change after
three stages exist is three refactors plus a cache invalidation.

## Scope

One file per contract, shapes as listed in ARCHITECTURE §2: `QueryPlan`,
`Candidate`, `Evidence`, `Fact`, `Analysis`, `Memo`. Plus:

- `schema_version` on every contract. Bumping one invalidates caches downstream
  (CLAUDE.md invariant 6) — write the version into the file, not into a comment.
- `Fact.evidence_ids` is `z.array(z.string()).min(1)`. **Not optional.** A fact
  without ids must fail parsing, because that is the mechanism by which such
  facts are dropped (ADR-0003, ARCHITECTURE §3).
- `Analysis` carries `dimensions[]`, `score`, `coverage`, `disqualifiers[]`,
  `call`, `unknowns[]` — the enum for `call` is `PASS | WATCH | TAKE_A_MEETING`
  and lives here, once.
- `Evidence.type` enum must include `fetch_failed` (ARCHITECTURE §5) — a failed
  fetch is a record, not an absence.
- Export inferred types via `z.infer` so the pipeline types itself off one source.
- A small `parseOrDrop` helper if extraction needs per-item tolerance; keep it
  here so "dropped at parse time" is one behaviour in one place.

## Out of scope

Anything that reads or writes these. Pure schema ticket.

## Acceptance

- `pnpm typecheck` passes; every contract exports both a schema and its type.
- Unit tests: a `Fact` with no `evidence_ids` fails to parse; an `Analysis` with
  a `call` outside the enum fails to parse.
- `grep` shows `schema_version` present in all six files.
