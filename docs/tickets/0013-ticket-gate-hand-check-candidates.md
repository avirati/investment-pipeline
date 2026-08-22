# TICKET-0013 — GATE: hand-check the candidate list before stage 2

Status: **Done** — four live runs read by hand, [worklog 0022](../worklog/0022-gate-hand-check.md) · Depends on: 0012 · Blocks: 0014–0017, 0019–0022, 0028 — **all released**
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

## Outcome — 2026-08-22

Four topics, 48 candidates, every one read by hand. Full record in
[worklog 0022](../worklog/0022-gate-hand-check.md); the headline numbers:

| Question | Answer |
|---|---|
| Junk rate | **5 of 48 (10%)** — one ACM paper, one personal blog post, one docs page inside a monorepo, one demo instance, one source file |
| Duplicates | 2 of 48 — Coroot took three slots of twelve on one run |
| Fallback names | 13 of 48 (27%), 7 of them avoidable (`torrix-ai/install` is Torrix) |
| **D-6 — `--min-hits 8`** | **Keep.** 26–35 usable of 50 on three topics; 3 of 6 on the fourth — which also produced 5 of the 5 junk. The threshold predicts junk, not just yield |
| **D-5 — sample topic** | **`AI agent infrastructure`** — 12/12 companies, 0 junk, 0 duplicates. Counter-argument (a uniformly positive memo set) recorded in the worklog |
| Were the clarification options good? | **Unanswerable.** The clarifier is a seam until TICKET-0018; all four runs recorded `probe` or `non-interactive`. Moved to 0018 |
| Repo vs company (inconsistency 22) | Not distinguishable from a url. `GET /users/<owner>` → `type: User \| Organization` separated all ten cases here; it is a **fact for the rubric**, never a stage-1 filter. Handed to TICKET-0015 |
| Expansion arms (inconsistency 38) | `show_hn` earned +59 and +23 new posts on the two high-volume topics, 0 on the two thin ones. **`funding` returned 0 hits on all four topics** — inconsistency 46 |

Five defects go back to their own tickets rather than being patched downstream:
three canonicalisation fixes reopen [TICKET-0010](./0010-ticket-url-resolution-and-dedup.md),
two classifier/naming fixes reopen [TICKET-0009](./0009-ticket-hn-algolia-adapter.md).
Estimated effect on this gate's 48: junk 5 → 1, fallback names 13 → 6.
