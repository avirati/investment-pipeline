# Session 0002 — 2026-08-22 — Query planning, tests, CLI, setup

Still no code. Four additions to the spec, two of which came from me catching
gaps in what the AI produced in session 0001.

## What I raised

1. Should the raw query be rephrased by a light LLM to suit each source?
2. Have tests been accounted for?
3. The CLI needs `--help`.
4. A setup script, so running this doesn't depend on knowing `pnpm`.

## Query planning — where the design actually improved

The AI's first answer was auto-expansion: LLM rewrites the topic into
source-specific queries, cached and committed for replay. Reasonable, and it
flagged the drift risk itself — `"AI agents for SMBs"` expands to
`"automation tools"`, returns generic developer tooling that scores *well*
against our dev-infra rubric, and the pipeline looks productive while having
answered a different question. Its mitigation was provenance: every candidate
records the query that found it, so drift is traceable afterwards.

Traceable afterwards is not the same as prevented. I proposed the interactive
version instead — pass a clear query through, and when it isn't clear, present
generated options and let the user pick one or keep their original. Same safety
mechanism, but a human sits at the decision point instead of auditing it later.

It then improved on my version in a way I want to record, because it is the
better idea and it is not mine: **don't let a model decide whether the query is
"clear enough."** Probe the raw query against HN first and count usable hits. The
trigger becomes measured yield, not a model's opinion about phrasing. Two
consequences fall out, both good — in the common case there is now *no LLM call
in stage 1 at all*, and the clarifier has seen the thin result set so it can
explain why the query underperformed rather than guessing at intent.

Sequence worth noting: its first proposal → my correction → its correction of my
correction. The final design is better than what either of us started with, and I
would not have got there by accepting its first answer or by insisting on mine.

It also flagged, unprompted, that this breaks a property it had written into
`ARCHITECTURE.md` the session before — "the LLM appears in exactly one place" —
and proposed restating the invariant rather than quietly widening it. The
replacement (permitted at *widening* boundaries, forbidden at *narrowing* ones)
is sharper than the original. [ADR-0008](../adr/0008-query-planning.md).

## Tests — a gap in session 0001

It named `vitest` in the architecture and wrote nothing about what would be
tested. It called this its own omission when I raised it, which is the correct
read: "appropriately tested" is in the brief's rubric and there was no strategy.

The resulting [TESTING.md](../TESTING.md) organises around "test what fails
silently" — rubric band edges, disqualifier precedence, the citation validator's
*failure* path, URL canonicalisation, and the missing-data paths. That last
group is the one I care most about: the brief asks for robustness to bad data,
and this makes it a tested behaviour rather than a claim in a README.

Two things I want on the record. First, this gap existed because I asked for
architecture and scope in session 0001 and did not ask for a test strategy —
it produced a thorough answer to the question I asked and did not volunteer the
question I hadn't. Second, the whole exchange is an argument for reading what an
AI produces against the *brief* rather than against the *prompt*.

## Evals — cut

The harness for judgement quality (hand-labelled golden set, agreement reported
before and after rubric changes) was designed in this session and cut from v1 on
time grounds. The AI pushed for it and, when I asked, gave a fair
counter-argument against its own recommendation.

The cost is real and is written into [SCOPE.md](../SCOPE.md) and
[TESTING.md](../TESTING.md) rather than omitted: the rubric bands are unvalidated
against real companies, and no test will catch it if they are wrong. I would
rather ship that stated than ship it hidden.

## CLI and setup

Both straightforward. Two details worth keeping:

- The `--help` output is **written into the architecture doc before the code
  exists**. Writing help text first is a cheap way to pin a CLI contract, and it
  surfaced that seed forms needed documenting somewhere a user would actually
  look.
- `setup.sh` ends by re-rendering the committed sample run — offline, no API key.
  Its suggestion, and a good one: it turns "did the install work?" into an
  assertion rather than a hope, and a reviewer gets a working pipeline before
  obtaining any credential.

## Attribution

- [ADR-0008](../adr/0008-query-planning.md), [TESTING.md](../TESTING.md), the CLI
  help sketch, and the `setup.sh` design: AI-drafted, from my four prompts and
  the probe-threshold decision.
- The interactive-clarification idea: mine. The probe-based trigger that replaced
  my "is it clear enough" check: its.
- The revised widening/narrowing invariant: its, raised unprompted when the new
  feature contradicted its own earlier design.
- Edits to `ARCHITECTURE.md`, `SPEC.md`, `SCOPE.md`, `CLAUDE.md`, `README.md`:
  AI-applied, reviewed by me before commit.

## Reflection

TODO(author) — after the first real run.

- The probe threshold defaults to 8 usable hits. That number is a guess. What did
  real topics actually return, and did the clarifier fire when it should have?
- Did the clarification options turn out to be *good*, or did I keep choosing
  "keep my original" — and if so, was that the options being weak or my query
  being fine all along?
- I cut evals for time. Did that decision cost me anything I could point at, or
  did the rubric hold up without it?

## Next

Unchanged from session 0001, plus `setup.sh` and `./pipeline` alongside the
scaffold so the repo is runnable from the first code commit.
