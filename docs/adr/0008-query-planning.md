# ADR-0008 — Query planning: probe, then clarify

Status: Accepted · 2026-08-22 · Supersedes part of [ADR-0001](./0001-file-based-staged-pipeline.md)

## Context

HN Algolia is keyword matching over post titles and text, not semantic search. A
natural-language topic seed performs badly against it: `"AI agents for SMBs"`
matches almost nothing, because the posts that matter say *"Show HN: I built a
bookkeeping bot for small businesses."* HN describes the job; the seed describes
the category.

Sourcing gates everything downstream. A weak seed produces a run full of
confidently-scored junk, and no amount of care in stages 2 and 3 recovers it.

## Options

1. **Pass the seed through verbatim.** Fully deterministic. Also frequently
   returns three results, one of which is a blog post.
2. **Static expansion.** A hand-written synonym and template table
   (`Show HN {topic}`, `{topic} launch`, …). Deterministic, but generalises
   poorly — good on topics that were tuned, weak on everything else, and the
   table becomes a maintenance surface nobody updates.
3. **Always auto-expand with an LLM.** Best recall, but drift is invisible:
   `"AI agents for SMBs"` becomes `"automation tools"`, returns generic developer
   tooling that scores *well* against our dev-infra rubric, and the pipeline looks
   productive while having answered a different question. Provenance catches this
   only after the fact.
4. **Probe, then clarify with a human in the loop.**

## Decision

Option 4.

```
seed ──► probe: raw query against HN Algolia          no LLM, ~200ms
          │
          ├─ usable hits ≥ --min-hits (default 8) ──► pass through, zero LLM calls
          │
          └─ below threshold ──► LLM proposes 3–4 refinements, having seen
                                 the thin result set and the thesis
                                 ──► user picks one / keeps original / types own
```

The trigger is **measured yield, not a model's opinion of the phrasing**. `usable`
means the hit resolves to a company site rather than a blog, paper, or personal
domain.

The exchange resolves once into `runs/<run_id>/query_plan.json`:

```json
{ "original_seed": "...", "probe": { "hits": 3, "usable": 1 },
  "clarified": true, "options_offered": ["..."],
  "chosen": "...", "chosen_by": "user" }
```

The LLM chooses **words**. Code always chooses **filters** — tags, `points>N`,
date window — from CLI flags. That split is not negotiable; it is what keeps the
search envelope under deterministic control.

## The invariant this revises

[ARCHITECTURE.md](../ARCHITECTURE.md) previously said "the LLM appears in exactly
one place." That is no longer true, and widening it quietly would be worse than
restating it. The property that actually holds, and is stronger:

> The LLM is permitted at **widening** boundaries — deciding what to look at. It
> is forbidden at **narrowing** boundaries — deciding what to conclude. Facts,
> scores, calls, and memo prose remain off-limits.

Query planning widens. Scoring narrows. A wrong widening costs a wasted fetch and
is visible in `query_plan.json`; a wrong narrowing puts an indefensible number in
front of a partner.

## Consequences

**Good.** No LLM call at all in the common case — strictly cheaper and more
deterministic than always-expanding. Drift is caught by a person *before* any
fetching, rather than by reading provenance afterwards. The clarifier is
informed: it has seen the thin results, so it explains why the query
underperformed instead of guessing at intent.

**Good.** `query_plan.json` is a runtime record of a human judgement at a real
decision point — committed, diffable, and more honest than prose describing the
same thing.

**Bad.** Stage 1 grows a two-phase shape: `plan` (interactive, once) then `fetch`
(deterministic, replayable). That is real added complexity in what was the
simplest stage, plus one small dependency for the interactive select.

**Bad.** An interactive step in a pipeline that must also run unattended. Handled
explicitly rather than by hoping:

| Context | Behaviour |
|---|---|
| TTY, thin probe | Offer options |
| No TTY (CI, tests, piped output) | Proceed with raw seed, record `chosen_by: "non-interactive"` |
| `--query-plan <file>` | Use it, skip planning entirely |
| `--no-expand` | Raw seed verbatim, skip planning |
| Replay of an existing run | Never re-prompts — the plan already exists |

It never blocks unattended, and it never silently substitutes a query the
operator did not approve.

**Bad.** The probe spends one API request before the run properly begins. At HN
Algolia's limits this is free; against a rate-limited source it would not be.

## Revisit if

A source is added whose search is semantic rather than lexical, in which case the
probe threshold means something different and may not be needed at all.
