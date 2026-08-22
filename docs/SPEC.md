# Functional Specification

Status: draft · Owner: Avinash Verma · Last updated: 2026-08-22

This document defines *what* the pipeline produces and *by what standard* it judges.
For *how* it is built, see [ARCHITECTURE.md](./ARCHITECTURE.md). For what we
deliberately are not building, see [SCOPE.md](./SCOPE.md).

---

## 1. The thesis

> **We back technical founders building AI-native infrastructure that developers
> adopt before it is sold to them.**

Every clause is load-bearing and is scored independently:

| Clause | What it means | How we observe it |
|---|---|---|
| *technical founders* | The team can build the hard part themselves, not brief it out | GitHub history, prior shipped artifacts, prior role |
| *AI-native infrastructure* | The product exists because of a capability or cost curve that did not exist ~24 months ago. Not an AI feature bolted onto an existing category | Product description, "why now" analysis |
| *adopted before it is sold* | Bottom-up pull is publicly visible before a sales motion exists | Stars/forks velocity, HN engagement, third-party integrations |

### 1.1 Anti-thesis (automatic Pass, regardless of score)

A candidate is passed on if **any** disqualifier holds. These exist so the thesis
is falsifiable rather than decorative:

- **D-1 — No technical founder.** Nobody on the founding team has shipped
  software at the layer the product operates at.
- **D-2 — No proprietary surface.** A prompt-and-UI wrapper with no model, data
  asset, runtime position, or distribution advantage it could ever own.
- **D-3 — Platform wedge.** The first product is described as a platform, an OS,
  or "infrastructure for everything" rather than one job for one user.
- **D-4 — Enterprise-only motion.** No self-serve or open-source path by which a
  developer can adopt it without a contract. This contradicts the third clause of
  the thesis directly.

A disqualifier must itself be evidence-backed. We do not pass on inference.

### 1.2 What this thesis knowingly excludes

Consumer AI, vertical SaaS, applied-AI services businesses, and enterprise
sales-led infrastructure. These may be good companies. They are not *this* fund's
companies, and a pipeline that scored them would be scoring nothing. Narrowness is
the point — a rejected good company is a correct output of a specific thesis.

---

## 2. The rubric

Score is the sum of five dimensions, 0–100. Each dimension is scored by
**deterministic code** over facts extracted from evidence — never by asking a
model for a number. See [ADR-0002](./adr/0002-deterministic-scoring.md).

Each dimension carries `evidence_ids[]`. A dimension with no supporting evidence
scores at its band floor and is marked uncovered — it is never silently zeroed.

### D1 — Founder–market fit & technical depth · 25 pts

| Band | Criteria |
|---|---|
| 0–5 | No identifiable founders, or a non-technical team building an infrastructure product |
| 6–12 | Technical team, no demonstrated exposure to this specific problem |
| 13–19 | Technical **and** direct exposure — built this internally, or lived the pain in a prior role |
| 20–25 | The above **plus** a prior shipped artifact at scale: OSS with real adoption, prior exit, or core contributor to relevant infrastructure |

### D2 — Wedge specificity · 20 pts

| Band | Criteria |
|---|---|
| 0–4 | Describes a category or platform, not a job |
| 5–10 | One job, but the job is a feature an incumbent will ship |
| 11–15 | One job, painful, and the incumbent is *structurally* unable to serve it |
| 16–20 | The above **plus** a named first user already paying for something worse |

### D3 — Evidence of pull · 25 pts

Signals must be **public and dated**. Undated claims score 0 for this dimension.

| Band | Criteria |
|---|---|
| 0–5 | A launch post and nothing else |
| 6–12 | One credible signal — HN front page, >200 stars, a named design partner |
| 13–19 | Two *independent* signals, both within 90 days |
| 20–25 | Sustained pull — star or commit velocity across ≥3 months, third-party integrations, or unsolicited community usage |

### D4 — Why now · 15 pts

| Band | Criteria |
|---|---|
| 0–3 | Could have been built in 2021 |
| 4–8 | Rides a capability shift but does not require it |
| 9–12 | Requires a capability or cost curve crossed in the last ~18 months |
| 13–15 | The above **plus** timing defensible against fast-followers for ≥12 months |

### D5 — Path to defensibility · 15 pts

| Band | Criteria |
|---|---|
| 0–3 | None identified |
| 4–8 | Execution speed or design taste only |
| 9–12 | An accumulating asset — proprietary eval set, workload data, runtime position |
| 13–15 | The above **plus** a compounding loop already visible in public artifacts |

---

## 3. The call

```
disqualifier present            → PASS
score ≥ 72 and coverage ≥ 60%   → TAKE A MEETING
score 55–71                     → WATCH
score < 55                      → PASS
```

**Coverage gate.** `coverage` is the share of the five dimensions supported by at
least one primary source. If coverage < 60%, the call is capped at **Watch** no
matter the score. We do not spend partner time on inference. This is the
pipeline's central concession to bad and missing data: thin evidence produces an
honest *"we don't know enough yet"*, not a confident wrong answer.

Every Watch must state the specific, checkable trigger that would upgrade it.

---

## 3.1 Seed handling

Two seed forms: a topic query or a file of URLs. Only topic seeds are planned;
a URL list is already concrete. The sourcing surface these are planned against is
fixed by [ADR-0004](./adr/0004-source-selection.md).

A topic seed is probed against the source before the run begins. If it yields
fewer than `--min-hits` usable results, the operator is offered 3–4 refinements
and may pick one, keep the original, or type their own. The outcome — including
the original seed and how it was approved — is recorded in `query_plan.json` and
committed with the run.

The interaction happens at most once per run and never on replay. Without a TTY
the raw seed is used and the fact is recorded. Details:
[ADR-0008](./adr/0008-query-planning.md).

## 4. Memo contract

One page. A partner must reach the call in under 60 seconds.

```
# <Name> — <CALL>                          score 74/100 · coverage 80%
<url> · <one-line description>

## Why this call
≤ 3 sentences. Leads with the decisive factor.

## Team              ≤ 5 bullets, every bullet cited [E1]
## Product           ≤ 5 bullets, plain language, no jargon
## Market            ≤ 5 bullets — size hint, competitive set, why now
## Risks             ≤ 5 bullets — what would kill this

## What would change my mind
2–3 falsifiable, checkable statements.

## What we could not verify
Explicit list. Empty section is deleted, never faked.

## Sources
| id | url | retrieved | type |
```

**Hard rules**, enforced by a validator that fails the run:

1. Every factual claim carries an evidence id.
2. Every evidence id resolves to a record in the run's evidence store.
3. Score is arithmetic over the rubric — reproducible from the analysis JSON.
4. Unknown is written as "unknown", never smoothed into prose.

---

## 5. Acceptance criteria

A partner can:
- [ ] Run `./setup.sh` once, then `./pipeline run --seed "<topic>"`, and get
      memos out.
- [ ] Open any memo and understand the call in 60 seconds.
- [ ] Discover every option from `./pipeline --help` without reading the source.

A reviewer can:
- [ ] Trace any claim in a memo to a URL and a retrieval timestamp.
- [ ] Re-render every memo from committed artifacts with zero API calls.
- [ ] Recompute any score by hand from the analysis JSON and this rubric.
- [ ] Run `pnpm test` on a fresh clone with no API key configured.
- [ ] Read [docs/worklog/](./worklog/) and see how the thing was actually built.

A run of 10–20 candidates completes in one command, tolerates individual
candidate failures without aborting, and records what failed.
