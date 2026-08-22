# TICKET-0013 — GATE: hand-check the candidate list before stage 2

Status: Open · Depends on: 0012 · Blocks: 0014–0022
Reads: [STATE](../STATE.md) next-step 4, D-5, D-6; [ADR-0008](../adr/0008-query-planning.md); [SCOPE](../SCOPE.md) risks

## Why

STATE is explicit: *do not build stages 2 and 3 speculatively before this reports
back.* Stage 1 gates everything downstream, and two things in the spec are
labelled guesses that only real output can settle. Building on top of an
unvalidated candidate list is how a pipeline ends up confidently scoring junk.

This is not a coding ticket. Its deliverable is a written finding.

## Scope

Run stage 1 against 3–4 real topics and read the output by hand.

- **Record the junk rate.** How many candidates were projects, blog posts, or
  personal sites rather than companies? That number is the honest measure of
  TICKET-0009's classifier.
- **D-6 — the `--min-hits` default of 8.** Did the clarifier fire when it should
  have? Did it stay quiet when the seed was fine? Keep 8 unless the data
  contradicts it; if it changes, say what data changed it.
- **D-5 — pick the committed sample run topic.** Whichever yields the cleanest
  10–15 candidates. State why in the worklog. TICKET-0028 consumes this.
- Were the clarification options actually good, or was "keep my original" always
  the right answer? Worklog 0002 asks this question directly; answer it.
- Any classifier or canonicalisation bug found here is fixed in TICKET-0009 or
  TICKET-0010 — reopen them rather than patching downstream.

## Acceptance

- A worklog entry with the junk rate as a number, the D-6 verdict, and the D-5
  choice with its reason.
- `STATE.md` updated: D-5 and D-6 closed or restated with what was learned.
- Fixture capture (TICKET-0014) has real responses to work from.
