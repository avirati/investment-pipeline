# ADR-0002 — Deterministic scoring over LLM-extracted facts

Status: Accepted · 2026-08-22

## Context

Each startup needs a 0–100 score against the thesis. The rubric explicitly asks
for scores to be "defensible". A partner will eventually ask "why 74?" and the
answer has to survive that question.

## Options

1. **Ask the model for the score.** One call, holistic judgement, sensitive to
   nuance a rubric misses.
2. **Ask the model for per-dimension scores, sum them in code.** Some structure.
3. **Model extracts facts only; code applies the rubric.** The model answers
   "does a founder have a prior exit? cite it" — never "how good is this team".

## Decision

Option 3. The LLM's output surface is a typed set of facts with evidence ids.
Scoring is a pure function `facts → dimensions → total`, living in
`src/analyse/score.ts` and nowhere else.

## Consequences

**Good.** Scores are reproducible — same facts, same score, forever. A score is
recomputable by hand from the analysis JSON and the rubric table, which is the
actual test of "defensible". Rubric changes re-score existing runs for free,
with no API calls. Score drift between runs becomes impossible, so a diff in
score always means a diff in evidence. The scoring function is unit-testable
against fixtures, which is where the 10% code-quality weight is easiest to earn.

**Bad.** The rubric cannot capture what it did not anticipate. A genuinely
unusual company gets scored by bands that do not fit it — the model would have
noticed, the rubric will not. Mitigated by the memo carrying `unknowns[]` and by
the coverage gate, but not eliminated. This is a real cost and I am accepting it
knowingly: a rubric that is sometimes blunt beats a number that cannot be
defended.

**Also bad.** Writing anchored bands is a much harder problem than writing "score
this 0–100", and it moves the difficulty from a prompt into a specification that
has to be right up front. The bands in [SPEC.md](../SPEC.md#2-the-rubric) are
unvalidated against real companies as of this ADR. If this decision proves wrong,
it will show up as candidates clustering in the middle two bands of every
dimension.

## Revisit if

A meaningful fraction of candidates land in bands that clearly misrepresent them.
The fix is better bands, not handing the number back to the model.
