# TICKET-0024 — Memo template and renderer

Status: **Done** — the derivation in [worklog 0035](../worklog/0035-memo-derivation.md), the template and renderer in [worklog 0036](../worklog/0036-memo-template-and-render.md). `templates/memo.md.eta`, `src/memo/render.ts`, two committed golden memos and `pnpm golden`; all three acceptance items met, 26 tests · Depends on: 0022 (In review) · Blocks: 0025, 0026
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

**What the renderer owns, and did:** the header line, the ordering of sections
as `sections` gives them, the sources table, and printing `omitted` counts
rather than swallowing them. The bullet caps are applied in stage 2, so the
template enforces nothing it could disagree with.

**One thing the renderer needed and did not get**, resolved by going back to
stage 2: SPEC §4's *Why this call*. Choosing which dimension decided a call is a
judgement, and a judgement in a template is invariant 3 broken where nobody
looks — so it is `Analysis` v4's `why_this_call`, and the template prints it.

**Citations render as memo-local labels** (`E1`, `E2`) with the full evidence id
beside them in the sources table, which keeps SPEC §4's four columns and still
lets a bullet lead to a file on disk. An id with no record behind it renders as
`unknown` rather than being dropped — TICKET-0025 fails the run over it, and can
only do that if the row is visible.
