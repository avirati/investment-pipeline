# ADR-0007 — Investment thesis as an executable rubric

Status: Accepted · 2026-08-22

## Context

The brief requires a thesis that is specific and defensible, and names "a thesis
so broad that the score is meaningless" as an anti-pattern. The thesis is not
flavour text — it is the specification the scoring code implements, so it must be
narrow enough to reject things and observable enough to measure from public data.

## Options

1. **"AI agents for SMB back-office."** The brief's own example. Commercially
   sensible, but SMB-facing companies surface poorly on HN and GitHub, so the
   evidence available would not support the scores. A thesis we cannot measure
   produces confident guesses.
2. **"Services-as-software" — replacing a line item paid to an agency or BPO.**
   Sharp and fashionable. The decisive signal is contract displacement, which is
   almost entirely private. Same failure as (1): scores would rest on inference.
3. **"Technical founders building AI-native infrastructure that developers adopt
   before it is sold to them."** Every clause maps to a signal that HN and GitHub
   actually expose.

## Decision

Option 3, expressed as five weighted dimensions with anchored bands and four
disqualifiers, in [SPEC.md](../SPEC.md).

The selection criterion was **measurability against the chosen sources**. A
thesis whose evidence is private makes the pipeline dishonest, however good the
thesis is as an investment strategy. Thesis and sourcing were chosen together,
not in sequence — that is the actual decision recorded here.

## Consequences

**Good.** Every dimension is observable: founder depth from commit history and
prior artifacts, pull from stars and HN engagement, why-now from the product's
own dependency on recent capability. The four disqualifiers give the rubric teeth
— it can reject a high-scoring company outright, which a weighted-average alone
cannot. Consistency is enforced by construction, since one scoring module is the
only place the thesis exists as behaviour.

**Bad.** It excludes most of venture. Consumer, vertical SaaS, applied-AI
services, and enterprise sales-led infrastructure all score badly or trip D-4.
This is intended, and a reviewer should read a run of mostly Passes as the
thesis working rather than the pipeline failing — but it does mean the pipeline
is useless to a generalist fund.

**Bad.** It is biased toward companies that perform in public. A quiet team with
real revenue and no GitHub presence scores poorly. That is a genuine false
negative, and the coverage gate mitigates it only by refusing to be confident —
it does not find them. Stated in [SCOPE.md](../SCOPE.md) as a known limitation
rather than papered over.

## Revisit if

The fund's thesis changes. A second thesis is a second scoring module against the
same evidence store — the architecture supports it; this version does not build
it.
