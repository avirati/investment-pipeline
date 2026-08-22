# Session 0001 — 2026-08-22 — Scoping, thesis selection, and architecture

No code this session. Brief in, specification set out.

## Goal

Turn a deliberately loose take-home brief into a specification concrete enough to
build against: thesis, rubric, stage contracts, stack, and an explicit list of
what not to build.

## Approach

Worked with Claude (Opus 5) in Claude Code. I gave it the full brief and asked
for architecture, system design, tech stack, and scope — deliberately asking for
discussion before any files were written, because the failure mode I wanted to
avoid was a plausible-looking repo scaffolded before the thesis existed.

Its first move was to read the rubric as the actual spec: 40% process visibility,
10% code quality. It flagged that this inverts the normal build order — docs and
decision records are the primary deliverable, not overhead — and that two lines
in the brief ("spot-check one analysis and trust where its claims came from",
"commit them so we don't need to re-run") are load-bearing architectural
requirements rather than polish. That framing set the rest of the session.

## What the AI proposed, and what I did with it

It presented four decisions and asked me to choose. I took two of its
recommendations and overrode two.

**Accepted — thesis: AI-native dev infrastructure with observable pull.**
The argument that decided it was not that this is the best investment thesis, but
that it is the only one of the three options whose evidence is *public*. A thesis
about SMB back-office agents cannot be scored from HN and GitHub, so the scores
would be inference wearing a number. Thesis and sourcing had to be chosen
together. That is now [ADR-0007](../adr/0007-thesis-selection.md).

**Accepted — sources: HN Algolia + GitHub.** Free, keyless, and they measure
exactly what the thesis claims to care about. [ADR-0004](../adr/0004-source-selection.md).

**Overrode — stack.** It recommended Python with Pydantic and made a reasonable
case: better HTML extraction via `trafilatura`, stronger data-pipeline ecosystem.
I chose TypeScript without arguing the point — I will maintain this, and I am
faster in TypeScript.

What is interesting is what happened next. Asked to write the ADR for a decision
it had recommended against, it produced a justification stronger than either of
the ones it had offered before: Zod does three jobs at once here — stage
contract, LLM structured-output schema, and runtime validator — and for a system
whose central property is typed artifacts crossing stage boundaries, that
collapses a whole class of contract-validator drift. That is now the deciding
argument in [ADR-0005](../adr/0005-typescript-stack.md). I am recording this
because the reasoning is real and I want it in the record, but also flagging it:
a model asked to justify a decision already made will find the best available
argument for it. That is useful for writing an ADR and dangerous for making the
decision. The `trafilatura` disadvantage it raised first is genuine and is still
in the ADR's consequences section — I made sure it stayed there.

**Overrode — LLM layer.** It recommended calling Claude directly, tiering Sonnet
for judgement and Haiku for extraction. I chose LangChain with an OpenAI adapter,
because provider lock-in in an internal tool is a cost the fund pays later and a
reviewer without the right API key pays immediately. It kept the tiering idea and
folded it in as env-driven role routing — `MODEL_EXTRACT` and `MODEL_ANALYSE` —
which preserved what was good about its proposal inside my constraint.
[ADR-0006](../adr/0006-llm-provider-abstraction.md).

## The one design idea I would not have reached alone

Deterministic scoring: the LLM extracts facts with evidence ids, and code applies
the rubric. The brief says "Score (0–100) against your stated thesis", which
reads naturally as something you ask a model for, and that is how I had been
reading it. The AI proposed the inversion unprompted, with the argument that
"why 74?" needs an answer that survives a partner asking it twice — and a model's
number changes on re-run, so it has no such answer.

The consequence is that the anchored bands in SPEC §2 now have to carry the
entire thesis, which is a much harder writing problem than a scoring prompt would
have been. They are written but untested. If this design fails, it fails there.
[ADR-0002](../adr/0002-deterministic-scoring.md).

## What got cut

Attribution matters here, so: the first two were the AI's own calls, made while
drafting and surfaced to me in the output. The third was mine.

- **Agentic browsing / a research-agent loop.** It raised this as an option and
  then argued against it in the same breath — non-reproducible cost, and it
  breaks the citation guarantee the rest of the design rests on. I agreed. It is
  written into [SCOPE.md](../SCOPE.md) so the omission reads as a decision
  rather than an oversight.
- **A YAML-configurable rubric.** Also its own call, on the grounds that the fund
  has one thesis and parameterising it early would blur the thing being graded.
- **ADR count.** Its working list had nine; it cut two itself as decisions nobody
  would have disagreed with. I have not yet pressure-tested whether the remaining
  seven all clear that bar — 0005 and 0006 are the ones I would look at first if
  a reviewer told me this was padded.

## Attribution

- `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/SCOPE.md`, all seven ADRs,
  `CLAUDE.md`: drafted end-to-end by Claude Opus 5 from my brief and my four
  decisions, then reviewed by me before commit.
- The thesis clauses, rubric weights, and band anchors: AI-drafted from my
  selection among three options it generated. This is the part I scrutinised
  hardest, since the rubric is what gets graded for being "specific and
  defensible" — but I want to be accurate that I selected and reviewed here, I
  did not write the bands myself. They are unvalidated against real companies
  until the first run.
- Stack and LLM-layer decisions: mine, against its recommendation.
- This worklog: factual sections drafted by the AI from the session it
  participated in; reflection below is mine.

## Reflection

TODO(author) — write after the first real run, not now. Open questions I want to
answer honestly rather than pre-empt:

- Did the anchored rubric bands hold up against real companies, or did I spend a
  session writing bands that all collapse into the middle two?
- The coverage gate caps thin-evidence candidates at Watch. Does that produce a
  useful signal or a pile of Watches that a partner ignores?
- Deterministic scoring is the bet of this design. What did it cost me in
  nuance, concretely, on a company where a model would have seen something the
  rubric could not?

## Next

1. Repo scaffold — `package.json`, `tsconfig`, `biome`, `vitest`, contracts.
2. Stage 1 against live HN, hand-check the candidate list for junk before
   writing a line of stage 2.
3. Fixtures from that run, so tests stay offline from the start.
