# Session 0003 — 2026-08-22 — Ticket breakdown

Still no code. This session converted the committed specification into an
executable backlog: [docs/tickets/](../tickets/), 30 tickets in dependency order.

## What I asked for

Read the current state of the project and derive tickets from it. Granular, no
duplicated content — reference the existing docs rather than restating them — and
each ticket must leave a runnable artifact.

## What the AI produced

Thirty tickets plus an index, derived from `SPEC`, `ARCHITECTURE`, `SCOPE`,
`TESTING`, `STATE`, and the eight ADRs. Shape of each: `Why` (two or three lines,
no more), `Scope`, `Out of scope`, `Acceptance`, and a `Reads` header linking the
doc sections it implements. The stated rule is that if a ticket and a doc
disagree, the doc wins and the ticket is the bug — the tickets are not a second
source of truth.

Structural choices worth recording:

- **The stage-1 gate survived as a ticket.**
  [TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md) is not a
  coding ticket; its deliverable is a written finding — junk rate as a number,
  the D-6 verdict, the D-5 choice. `STATE.md` says do not build stages 2 and 3
  before this reports back, and a backlog that quietly dropped the gate would
  have inverted the instruction it was derived from.
- **Every open decision from STATE is carried by a ticket**, taking its
  documented default, with a table in the index mapping decision → ticket →
  default taken. D-4 is in that table specifically to say the reflections are
  *not* to be written by an assistant.
- **Tests ship with the module they test**, not batched into a later ticket. The
  two exceptions are cross-cutting by nature: fixture capture and the
  missing-data paths.
- **No eval-harness ticket.** The index says so explicitly and calls adding one a
  scope change requiring an ADR, because `SCOPE.md` and `CLAUDE.md` both warn
  about it reappearing quietly.

## Two ordering problems it surfaced

1. **`setup.sh` step 6 cannot exist yet.** ARCHITECTURE §7.1 ends the setup
   script by re-rendering the committed sample run — which does not exist until
   the pipeline works. Split: steps 1–5 land in TICKET-0004 with a `TODO(0028)`
   comment naming the ticket that closes it; step 6 lands in TICKET-0028
   alongside the sample run. The gap is visible in the script rather than
   forgotten.
2. **Query planning needs the LLM seam it precedes.** The clarifier in stage 1
   needs `src/llm/provider.ts`, which sits in stage 2's group. Rather than
   renumbering, TICKET-0011 carries a sequencing note: the probe-and-pass-through
   half — the common path, and the one with no LLM call at all — ships first, and
   the below-threshold path runs as `chosen_by: "non-interactive"` until the seam
   lands. Explicitly: do not stub an LLM call inside the module.

Both are consequences of ADR-0008 and ARCHITECTURE §7.1 being written before any
code existed. Neither is a defect in those documents; they only became visible
when the work was put in an order.

## One place a ticket says more than the docs do

[TICKET-0019](../tickets/0019-ticket-extraction-prompt.md) spells out a failure
mode that CLAUDE.md's invariant 7 implies but does not name: a prompt that
restates the thesis as free text turns the model back into the scorer through the
back door. The invariant says the thesis lives in one place; the ticket says what
violating it would look like in practice.

## Decisions taken

None of STATE's open decisions were resolved here — they were assigned to the
tickets that will resolve them. No defaults were consumed in this session.

## Attribution

The ticket set, the index, and this entry's factual sections: AI-written
end-to-end from one prompt, reviewed by me before commit. The breakdown rules —
granular, no duplication, every ticket runnable — were mine.

## Reflection

TODO(author) — after the backlog has actually been worked.

- Was 30 tickets the right granularity, or did the small ones cost more in
  overhead than they bought in reviewability?
- Did the gate at 0013 hold, or did I build stage 2 anyway?
- Did the tickets stay accurate as the code diverged, or did they become a second
  stale source of truth alongside STATE?

## Next

[TICKET-0001](../tickets/0001-ticket-repo-scaffold.md).
