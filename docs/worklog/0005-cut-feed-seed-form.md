# Session 0005 — 2026-08-22 — Cutting the `feed` seed form

[TICKET-0002](../tickets/0002-ticket-cut-feed-seed-form.md) only. Docs-only:
`SPEC.md` §3.1, `ARCHITECTURE.md` §1 and §7, `ADR-0004`, `STATE.md`.

## What I asked for

Continue implementation. Small, reviewable commits, stop before committing,
keep the worklogs going.

## What the AI produced

The `feed` seed form is gone. The seed surface is `topic` and `urls`.

A partial edit to `ARCHITECTURE.md` — the §1 data-flow header and the two §7
help sketches — was already sitting uncommitted in the working tree from the
previous session, and was left as-is rather than redone. The rest:

- **`SPEC.md` §3.1** now names two seed forms and points at ADR-0004 for the
  sourcing surface they are planned against.
- **`ADR-0004`** gains a consequence paragraph recording that the CLI had
  promised `--seed yc:w25` — the YC directory, the source this ADR rejected —
  and that the seed form was cut rather than the ADR reopened. No new ADR:
  per the ticket, this is an alignment to an accepted decision, not a new one.
- **`STATE.md`** drops D-3 from the open-decision table, strikes known
  inconsistency #1, and gains a *Recently closed* section.

Two judgement calls in it:

- **The SPEC does not record the removal, only the result.** The first draft
  had §3.1 explain what a feed seed form would have been and why it was cut.
  That is a changelog, and a spec that accumulates the ghosts of cut features
  gets longer every ticket and less useful every time. The record lives in
  ADR-0004, STATE, and here; the SPEC states what is.
- **D-1 was removed from the open-decision table too**, which is outside this
  ticket. It was taken at its default in TICKET-0001 and recorded in worklog
  0004, but its row survived, so the table was claiming a decision was open
  that the previous session had closed. Leaving it there for one more ticket
  while adding a *Recently closed* section directly above it would have made
  STATE contradict itself in the same commit.

## What went wrong

Nothing failed. One defect was found and **not** fixed, because it belongs to a
different ticket:

- `docs/worklog/README.md` advertises `docs/evals/` — *"how prompt and rubric
  changes were evaluated … arrives with the first golden set"*. There is no
  golden set and there will not be one: SCOPE §"An eval harness — considered
  and cut" and CLAUDE.md both say so, and CLAUDE.md specifically warns against
  quietly reintroducing one. A reviewer following that row finds a promise the
  project deliberately did not keep. Logged as known inconsistency #5 in STATE,
  for TICKET-0029 (docs closeout).

## Decisions taken

**D-3** — cut, at its documented default. `topic` and `urls` only.

No other open decision was touched. D-1 was already closed in TICKET-0001; this
session only removed its stale table row.

## Attribution

All four file edits and the factual sections of this entry: AI-written
end-to-end from one prompt, reviewed by me before the commit. The two judgement
calls above were the AI's, surfaced before commit. The `ARCHITECTURE.md` edit
was carried over from the previous session unchanged.

## Reflection

TODO(author).

- The ticket's acceptance criterion was a literal `grep`: *no reference to a
  feed seed form survives in `docs/`*. Satisfying it literally would have meant
  deleting the record of the cut, which is the opposite of what this project is
  graded on. Is that the ticket being wrong, or the criterion being read too
  literally?
- Four files changed to remove one line of CLI surface. Was the separate
  docs-only ticket worth it, or would this have been fine folded into
  TICKET-0003 where the CLI actually gets written?

## Next

[TICKET-0003](../tickets/0003-ticket-cli-skeleton-and-help.md) — CLI skeleton
and the `--help` contract. First `src/`. The help output must match the
ARCHITECTURE §7 sketch exactly, as amended by this ticket.
