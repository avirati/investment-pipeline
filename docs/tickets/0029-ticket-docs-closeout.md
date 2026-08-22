# TICKET-0029 — Docs closeout and submission checklist

Status: Blocked · 0028 · Depends on: 0028 · Blocks: 0030
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
