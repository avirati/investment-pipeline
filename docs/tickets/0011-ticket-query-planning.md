# TICKET-0011 — Query planning: probe, then clarify (`src/source/plan.ts`)

Status: **Done** — [worklog 0019](../worklog/0019-query-planning.md). The probe half, the artifact and the whole of ADR-0008's context table shipped; the clarifier is an injected seam (`Clarifier`, `Chooser`) that TICKET-0018 fills, and the below-threshold branch is tested through stubs · Depends on: 0009 (Done); 0018 for the clarifier call · Blocks: 0012
Reads: [ADR-0008](../adr/0008-query-planning.md) in full, [SPEC §3.1](../SPEC.md), [TESTING §5](../TESTING.md)

## Why

Sourcing gates everything downstream, and this is the one place a human approves
what gets searched before any money is spent. It is also the more delicate half
of stage 1 — read ADR-0008 before writing any of it.

## Scope

- **Probe first, no LLM.** Raw seed against HN Algolia; count *usable* hits using
  TICKET-0009's classifier. At or above `--min-hits`, pass through with **zero
  LLM calls**.
- Below threshold and with a TTY: the model, having seen the thin result set and
  the thesis, proposes 3–4 refinements. `@clack/prompts` for the select. User
  picks one, keeps the original, or types their own.
- The LLM chooses **words**. Code always chooses **filters**. Not negotiable.
- Write `runs/<run_id>/query_plan.json` in the ADR-0008 shape: `original_seed`,
  `probe{hits,usable}`, `clarified`, `options_offered[]`, `chosen`, `chosen_by`.
- Every context in ADR-0008's table handled explicitly, including
  `chosen_by: "non-interactive"` and `chosen_by: "probe_failed"`.
- Interactive at most once per run; **never on replay**; never without a TTY.
- The clarification prompt is a versioned file in `prompts/` (CLAUDE.md), not an
  inline string — even though TICKET-0019 is where prompts get their CHANGELOG.
  Create `prompts/CHANGELOG.md` here with its first entry.

## Sequencing note

The probe is the common path and needs no LLM, so the probe-and-pass-through half
can land before TICKET-0018 exists. If it does, ship the below-threshold path as
`chosen_by: "non-interactive"` and add the clarifier when the provider seam lands
— do not stub an LLM call inside this module.

## Out of scope

Fetching candidates. Planning writes a plan; TICKET-0012 acts on it.

## Acceptance

Per TESTING §5, all offline:
- Probe above threshold → passes through, asserted by an LLM stub that **fails
  the test if invoked**.
- Probe below threshold, no TTY → raw seed, `chosen_by: "non-interactive"`.
- `--query-plan <file>` and `--no-expand` each bypass planning entirely.
- A committed `query_plan.json` is never regenerated on replay.
- Probe request failure → raw seed, `chosen_by: "probe_failed"`, run continues.
