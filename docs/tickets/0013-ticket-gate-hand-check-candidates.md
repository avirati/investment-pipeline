# TICKET-0013 — GATE: hand-check the candidate list before stage 2

Status: Blocked · 0012 · Depends on: 0012 · Blocks: 0014–0017, 0019–0022, 0028
Reads: [STATE](../STATE.md) next-step 4, D-5, D-6; [ADR-0008](../adr/0008-query-planning.md); [SCOPE](../SCOPE.md) risks

## Why

STATE is explicit: *do not build stages 2 and 3 speculatively before this reports
back.* Stage 1 gates everything downstream, and two things in the spec are
labelled guesses that only real output can settle. Building on top of an
unvalidated candidate list is how a pipeline ends up confidently scoring junk.

This is not a coding ticket. Its deliverable is a written finding.

**TICKET-0018 is deliberately outside this gate.** It used to read
`Blocks: 0014–0022`, which included it — but TICKET-0011 needs the provider seam
for its clarifier call, and 0011 is upstream of 0012, which is upstream of this
gate. The range was a cycle. 0018 is mechanism with no thesis content in it: a
model factory and a response cache are equally correct whatever the junk rate
turns out to be, so building it early risks nothing this gate exists to protect.
What the gate protects is stages 2 and 3 — extraction, the rubric, the memo —
and those stay behind it.

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
