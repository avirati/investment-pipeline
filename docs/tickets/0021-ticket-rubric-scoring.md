# TICKET-0021 — The rubric (`src/analyse/score.ts`)

Status: Open · Depends on: 0005, 0020 · Blocks: 0022
Reads: [SPEC §1, §2, §3](../SPEC.md), [ADR-0002](../adr/0002-deterministic-scoring.md), [ADR-0007](../adr/0007-thesis-selection.md), [TESTING §1](../TESTING.md)

## Why

The highest-value module in the repo and the only place a score comes into
existence. TESTING calls it the highest-value test target for the same reason: an
off-by-one on a band edge quietly changes a partner's call and nobody finds out.

## Scope

- Pure function: `facts → dimensions[] → total, coverage, disqualifiers, call`.
  No IO, no LLM, no clock.
- The five dimensions with the anchored bands from SPEC §2, weighted 25/20/25/15/15.
- The four disqualifiers from SPEC §1.1. A disqualifier must itself be
  evidence-backed — **we do not pass on inference**. Precedence over score is
  absolute: a 90 with D-2 present returns `PASS`.
- Coverage = share of the five dimensions supported by ≥1 primary source. A
  dimension with no evidence scores at its **band floor** and is marked
  uncovered. Never zeroed, never omitted (CLAUDE.md invariant 4).
- The call thresholds from SPEC §3 including the coverage gate: score ≥ 72 with
  coverage < 60% caps at `WATCH`.
- Every dimension carries its `evidence_ids[]` through to the output, so the
  score is recomputable by hand from the analysis JSON.
- **This is the only place the thesis exists as behaviour** (CLAUDE.md invariant
  7). Not configurable by YAML (SCOPE cut corner #3).

## Acceptance

The full TESTING §1 list, table-driven:
- Each of the five dimensions tested at each band edge and one either side.
- Each of the four disqualifiers tested independently against a high score.
- Uncovered dimension → band floor + coverage reduction, not zero.
- Coverage gate: score ≥ 72, coverage 40% → `WATCH`.
- Property-style: `total === sum(dimensions)` across generated fact sets.

## Known and accepted

The bands are **unvalidated against real companies** and no test here will catch
it if they are wrong (ADR-0002, SCOPE). Do not add prose claiming otherwise. The
predicted symptom is candidates clustering in the middle two bands of every
dimension — watch for it at TICKET-0028 and record what was actually observed.
