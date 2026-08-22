# TICKET-0024 — Memo template and renderer

Status: Open · Depends on: 0022 · Blocks: 0026
Reads: [SPEC §4](../SPEC.md#4-memo-contract), [STATE](../STATE.md) D-2, [CLAUDE.md](../../CLAUDE.md) invariant 3

## Why

The deliverable a partner actually reads. One page, call clear in 60 seconds.

## Scope

- Take **D-2**'s documented default: `eta` templates in `templates/memo.md.eta`,
  so a partner can edit a memo without reading TypeScript.
- `src/memo/render.ts` — `Analysis` → markdown. **No LLM call in this stage**
  (CLAUDE.md invariant 3). If a memo needs prose the analysis does not have, that
  is a stage-2 bug, not a reason to add a call here.
- Exact section set from SPEC §4: header line with call, score and coverage; Why
  this call; Team; Product; Market; Risks; What would change my mind; What we
  could not verify; Sources table.
- Bullet caps enforced (≤5 per section, ≤3 sentences for the call).
- **An empty section is deleted, never faked** (SPEC §4).
- Unknowns are written as "unknown", never smoothed into prose.
- Every Watch must state the specific, checkable trigger that would upgrade it
  (SPEC §3) — the template has nowhere for that to hide.

## Acceptance

- A committed golden `Analysis` renders a memo whose call is legible in the first
  two lines.
- An analysis with an empty `unknowns[]` renders no "could not verify" section.
- Rendering makes zero network and zero API calls — asserted with a stub.

## Decisions taken

**D-2** — `eta`, per its documented default.
