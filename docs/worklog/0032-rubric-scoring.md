# Session 0032 — 2026-08-23 — The rubric

[TICKET-0021](../tickets/0021-ticket-rubric-scoring.md), in one commit.
`src/analyse/score.ts` is SPEC §1–3 as behaviour: facts and signals in, five
dimensions, a score, a coverage share, cited disqualifiers and a call out. It is
the only place in the repo where a score comes into existence, and the first
module that had to decide what the thesis _does_ rather than what it says.

## What I asked for

Continue implementation, stop for review, small commits on a feature branch,
keep the worklogs going with reflection hints, update ticket statuses.

## What landed

| Commit    | Contents                                                               | Tests |
| --------- | ---------------------------------------------------------------------- | ----- |
| `325bf98` | `src/analyse/score.ts` — five dimensions, four disqualifiers, the call | 98    |

**883 tests** (785 before this ticket: +98), typecheck and lint clean, offline
and with no `.env`. The module makes no network call and reads no clock, so
there is nothing here that behaves differently on a reviewer's machine.

## Six rules

**1 — It switches on keys, never on English.** A band predicate may ask whether
a `founder.prior_exit` fact exists and what `github.stars` said. It may never
read a `statement`. A rubric that pattern-matches prose is the model scoring the
company through a regex, which is what ADR-0002 exists to prevent (STATE
inconsistency 8, which is where `Fact.key` came from). The `Observed` interface
that band predicates are handed has no accessor returning a statement, so this
is structural rather than remembered — and a test rewrites every statement to
"AN EXCEPTIONAL, WORLD-CLASS TEAM" and asserts the score does not move.

**2 — A number comes from the signal, never from the fact.**
`traction.github_stars` is a sentence the model wrote about a star count;
`github.stars` is the star count, read off the payload with no model involved
and dated by `as_of`. Where both exist the rubric reads the signal and the fact
is only a citation and a sentence for the memo. This closes
[inconsistency 58](../STATE.md), which TICKET-0020 half-answered and left here;
a test gives the rubric a fact claiming pull beside a signal saying four stars,
and D3 scores zero.

**3 — A band pays its top; a gap pays the floor of the second band.** SPEC gives
ranges. A band is a claim that has been _met_, so meeting it pays in full, and
five top bands come to exactly 100 — which is what makes the ≥72 threshold
reachable at all.

The other half is the one that took the thinking. The ticket and SPEC §2 both
say an uncovered dimension "scores at its band floor", and CLAUDE.md invariant 4
says missing data never becomes a zero. Read literally those contradict: the
bottom band's floor is 0 in every dimension. The reading taken is that **every
bottom band in SPEC §2 is a negative finding** — _no identifiable founders_,
_could have been built in 2021_, _none identified_ — and a finding needs
evidence. Absence cannot land there. So an uncovered dimension is not graded at
all: it takes the floor of the _second_ band, one band above the worst finding,
and is marked `covered: false`.

The visible consequence is deliberate and slightly odd, so it is written down in
the module: a company whose team page names nobody scores 5 on D1, and a company
with no site at all scores 6 — and loses a fifth of its coverage. The first is
an observation and the second is a gap, and only the gap can cap the call.

**4 — A disqualifier is cited or it does not fire.** SPEC §1.1 says _we do not
pass on inference_, and all four disqualifiers are absences in prose — _nobody
has shipped_, _no proprietary surface_, _no self-serve path_. An absence cannot
be cited. Each is therefore written as **the observation that makes the absence
damning**, plus the absence: we read the pricing page and it says contact sales,
with no signup, no published prices, no licence and no repository beside it. The
citation is always the positive half, and `scoreCandidate` skips any
disqualifier whose citation resolves to nothing — so an uncitable disqualifier
is structurally unable to reach the output, not merely discouraged.

**5 — `confidence` is not scored.** [Inconsistency 78](../STATE.md)'s answer.
The model's own confidence is the model's judgement, and letting it move a band
lets the model move the score at one remove — invariant 1 with an extra step. It
is carried to the memo where a partner can see it. A test scores the same facts
at `low` and at `high` and asserts the two results are identical.

**6 — One key list per dimension drives both the citation and the coverage.** A
dimension declares the keys it reads; its `evidence_ids` are the ids behind
those keys, and `covered` is whether that set is non-empty. There is no way to
score a dimension off a key it did not declare and no way to claim coverage for
evidence that did not reach the number. A consequence worth knowing: keys are
shared, so `product.job` covers D2 and D5 at once. That is the mechanism
working, not a leak.

## The tests

TESTING §1's list, in full and table-driven. 98 tests:

- **Every band of every dimension**, and both sides of every numeric edge that
  exists: 200/201 stars, 11/12/13 active weeks, 89/90/91 days since push, 4/5/6
  human contributors, 547/548/549 days of repository age, 9/10/11 contributors
  for D5's loop. SPEC says _>200 stars_ and the test would catch that quietly
  becoming `>=`.
- **Each disqualifier independently**, against a baseline that scores 100 and
  takes a meeting. Each variant still scores at or above 72, so the PASS is
  demonstrably the disqualifier's doing and not the score falling.
- **Coverage arithmetic**: nothing read at all leaves all five dimensions above
  zero, coverage 0 and a PASS; a fact citing only a `fetch_failed` record counts
  for nothing; the ids a dimension carries are the ids its number came from.
- **The call**, at every threshold and one either side, and the coverage gate at
  40%, 20% and 0%.
- **Four properties over 400 generated fact sets** (a seeded LCG, so a failure
  is reproducible without recording a seed): the total is the sum of its parts
  and stays in 0–100, no dimension exceeds its weight, coverage and `unknowns`
  agree with `covered`, and no case reaches TAKE_A_MEETING below the gate.

The last property is doing double duty — see gap 2.

## Gaps

1. **It reads presence, not meaning.** Rule 1's price, and the largest thing
   wrong with this module. SPEC D1 asks whether the team is _technical_; what
   the code can ask is whether anybody is named and whether a named person is
   stated to have built something before. A marketing hire with a prior role
   scores what a kernel maintainer with a prior role scores. Every band where an
   observation was substituted for SPEC's criterion carries a comment saying so
   — _the incumbent is structurally unable to serve it_ became "the job leans on
   a capability or a runtime position", _defensible against fast-followers for
   ≥12 months_ became "the timing thesis is attached to something that
   accumulates". Those comments are the list of places this rubric is weakest.
2. **The coverage gate is correct and unreachable.** Below 60% coverage at most
   two of five dimensions carry evidence, and two dimensions cannot reach 72
   with the other three at their unknown floors: the ceiling is D1 + D3 at 25
   each plus 5 + 4 + 4, which is 63. SPEC §3's gate is implemented, tested
   through `decideCall`, and never fires through `scoreCandidate`. It was left
   as SPEC writes it rather than tuned into reachability — moving a floor to
   make a rule fire, before a single real run, is choosing a number to fit a
   rule we also invented. The property test pins the claim so it fails loudly if
   it stops being true. New STATE inconsistency 80.
3. **Hacker News contributes prose and no metric.** [Inconsistency
   67](../STATE.md) biting exactly where it said it would: points and comment
   counts never reach the rubric, so SPEC D3's "HN front page" is not
   observable, and a Show HN with 400 points is worth what one with 4 points is
   worth. Both cost D3 a band. Two cheap fixes exist and neither was taken here.
4. **Every quantity but one is invented.** SPEC names _>200 stars_. The other
   six constants are this file's, chosen to make prose mechanical: 12 weeks, 90
   days, 548 days, 5 contributors, 10 contributors. Twelfth hand-written list of
   guesses in this codebase (inconsistency 59).
5. **The bands are unvalidated and no test here can help.** No eval harness in
   v1 (SCOPE). The predicted symptom is candidates clustering in the middle two
   bands of every dimension; TICKET-0028 is where that gets looked at, and the
   ticket asks for what was actually observed to be recorded.

## What this ticket did not do

- **No wiring.** Nothing calls `scoreCandidate` yet; `./pipeline analyse` still
  exits 70. TICKET-0022, which is where `gatherRun` → `extractFacts` →
  `scoreCandidate` gets joined and the first live stage-2 run belongs.
- **No `Analysis` writing.** `ScoreResult` has the fields `Analysis` needs and
  is not that schema; assembling the artifact is 0022's, along with STATE
  inconsistency 9 — the fields SPEC §4's memo wants that `Analysis` still lacks.
- **No `{{thesis}}`.** TICKET-0011's reopened clarifier prompt wants the thesis
  interpolated from the rubric. `RUBRIC` and `DISQUALIFIERS` are exported and
  carry ids, names and weights, which is the handle it needs; rendering them as
  prose is 0011's.

## Attribution

`src/analyse/score.ts`, all 98 tests and this worklog's factual sections are
AI-written end to end. The band predicates are an assistant's reading of SPEC
§1–2 and have had no human review at the time of writing. The reading in rule 3
— that an uncovered dimension takes the floor of the _second_ band — is the one
decision here that changes numbers and was not stated in any document.

## Reflection

The score rubrik looks good at first glance, but we need to test it against real data, and credible startups to see if it holds. If not, some slight tweaks may be needed.

## Next

**TICKET-0021 is in review.** [TICKET-0022](../tickets/0022-ticket-stage-2-wiring.md)
is now Ready: both modules it joins exist, and it is where the first live stage-2
run, the run manifest and the `Analysis` artifact belong. TICKET-0020's one
outstanding acceptance item — the first captured model output — is still the
author's and is the natural companion to that run.
