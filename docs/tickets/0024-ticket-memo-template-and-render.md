# TICKET-0024 — Memo template and renderer

Status: **In progress — the stage-2 half is in review** ([worklog 0035](../worklog/0035-memo-derivation.md)). `Analysis` v3 carries SPEC §4's sections, the change-my-mind list and the Watch upgrade trigger, derived by `src/analyse/derive.ts`; STATE inconsistency 9 is closed and the decision this ticket inherited is taken. **Outstanding: `templates/memo.md.eta`, `src/memo/render.ts` and the three acceptance items**, all of which now read an analysis that already has a body · Depends on: 0022 (In review) · Blocks: 0025, 0026
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

**Inconsistency 9 — the derivation lives in stage 2** (worklog 0035). Sections,
the "what would change my mind" list and the upgrade trigger are `Analysis` v3
fields written by `src/analyse/derive.ts`, not by the renderer. Stage 3 is
therefore a rendering of the analysis and of nothing else, and the ticket's
"if a memo needs prose the analysis does not have, fix stage 2" clause has
nothing left to trip on. Risks is built from fired disqualifiers, dimensions in
the rubric's lowest band, and — below the coverage gate only — uncovered ones.

**What the renderer still owns:** the header line, the ordering of sections as
`sections` gives them, the sources table, and printing `omitted` counts rather
than swallowing them. The bullet caps are already applied and recorded in the
analysis, so the template enforces nothing it could disagree with.
