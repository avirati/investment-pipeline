# TICKET-0029 — Docs closeout and submission checklist

Status: **Done** — [worklog 0041](../worklog/0041-docs-closeout.md). Two acceptance items are qualified rather than met; both are below · Depends on: 0028 (Done) · Blocks: 0030
Reads: [STATE](../STATE.md) submission checklist, [CLAUDE.md](../../CLAUDE.md) working rules, [worklog/README](../worklog/README.md)

## Why

The trail is 40% of the grade and the brief warns against trails assembled after
the fact. Most of it should already exist by now — this ticket is the sweep for
what drifted, not a writing session.

## Scope

- `STATE.md` — phase updated from "specification complete" to what is now true.
  Every open decision closed or restated with what settled it. Every known
  inconsistency struck or explained.
- `README.md` — remove the "Status: specification" banner; the quickstart must
  match the CLI that actually shipped.
- Worklog entries for every session that made a real decision, factual sections
  filled in, **reflections left as `TODO(author)`** — CLAUDE.md is explicit that
  ghostwritten reflection is both obvious and penalised. This includes D-4's two
  outstanding reflections; do not fill them in.
- Attribution per module: what was AI-written end-to-end, AI-drafted then
  reworked, or hand-written. Honest, per CLAUDE.md.
- New ADRs for anything decided during implementation that was hard or
  reversible-at-cost. If the probe threshold moved, if the rubric bands were
  re-tuned, or if LangChain was dropped, each is an ADR — not a silent diff.
- `prompts/CHANGELOG.md` — one entry per revision that actually happened.
- Walk the submission checklist in STATE and tick what is genuinely done. An
  unticked box is a better artifact than a ticked one that is not true.

## Acceptance

- No doc claims something the code does not do. Specifically: nothing claims the
  rubric is validated, and no eval harness has quietly appeared (CLAUDE.md).
- Every internal link resolves.
- The submission checklist reflects reality, including its unticked items.

## How the acceptance came out

- **"No doc claims something the code does not do."** Met, and it cost more than
  edits: SPEC §5's eight boxes were *checked* rather than ticked from memory,
  including "recompute any score by hand", which was verified for all twelve
  candidates in the committed run. Nothing claims the rubric is validated and no
  eval harness has appeared; `docs/worklog/README.md` used to promise
  `docs/evals/` and now says plainly that there is none.
- **"Every internal link resolves."** **Not met, on purpose.** One link is
  broken: `docs/worklog/0014` points at `tests/fixtures/hn/README.md`, a file
  that was never written. The worklog is not edited except by explicit
  `Correction:` notes, so the sentence stands with a correction under it.
  Rewriting history to make a `grep` pass is the opposite of what the trail is
  for.
- **"The submission checklist reflects reality, including its unticked items."**
  Met. Five ticked, **two left unticked**: the author's worklog reflections
  (D-4) and the walkthrough video (TICKET-0030).
- **New ADRs.** Only [ADR-0009](../adr/0009-bundles-as-artifacts.md), from
  TICKET-0027's session. The three triggers this ticket names — the probe
  threshold moving, the bands being re-tuned, LangChain being dropped — **none
  happened**, and an ADR for a decision that was not made is padding
  (`docs/adr/README.md`).

## What the sweep found that it was not looking for

Documenting `--replay` in the README meant running it, and running it showed
`runs/…/manifest.json` modified: **the documented command for reproducing the
committed run was damaging that run's manifest.** Logged an hour earlier as
inconsistency 96 and scheduled for later; it stopped being later once it turned
out to sit on the path a reviewer is told to walk. Fixed here — a replay writes
`stages.analyse_replay` and `stages.run_replay` beside the records it
reproduces, never over them. Then the same rule a third time, one layer down:
`./setup.sh` step 6 re-renders the sample run, writes nothing, and was rewriting
`stages.memo`'s timestamps anyway — so a fresh clone's first `git status` after
setup showed a committed artifact modified. Stage 3 now leaves the record alone
when nothing was written. +4 tests (1062).
