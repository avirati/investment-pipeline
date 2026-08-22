# Session 0019 — 2026-08-22 — Query planning, and TICKET-0011 closed

[TICKET-0011](../tickets/0011-ticket-query-planning.md) — the probe half of
[ADR-0008](../adr/0008-query-planning.md), and the last piece of stage 1 before
[TICKET-0012](../tickets/0012-ticket-stage-1-wiring.md) can wire it. The ADR
calls this the more delicate half of the stage: it is the one place a person
approves what gets searched before any money is spent.

## What I asked for

Continue implementation, small reviewable commits, keep the worklogs coming,
update the ticket statuses.

## What the AI produced

Three commits.

| Commit                  | What it is                                                            |
| ----------------------- | --------------------------------------------------------------------- |
| `contracts(query-plan)` | `probe` becomes nullable; `schema_version` 1 → 2                      |
| `feat(source)`          | `src/source/plan.ts` (~340 lines) and `tests/plan.test.ts` (34 tests) |
| `docs(prompts)`         | `prompts/clarify-query.v1.md` and `prompts/CHANGELOG.md`              |

| Export                                                 | What it is                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `probeSeed(seed, opts)`                                | The raw seed, one page, `story` tagged, counted through `classifyHits` |
| `planQuery(seed, opts)`                                | The whole of ADR-0008's context table, in its order                    |
| `Clarifier`, `Chooser`                                 | The two injected functions this module does **not** implement          |
| `sanitiseOptions`, `cleanOption`                       | Where "the LLM chooses words" stops being a convention                 |
| `readQueryPlan`, `loadQueryPlanFile`, `writeQueryPlan` | The artifact, read before it is written                                |
| `PlanError`                                            | A named file that cannot be used — a usage error, exit 1               |

## Five judgement calls

**1. The contract was wrong for three of its own paths, so it was bumped.**
`--query-plan <file>`, `--no-expand` and a failed probe all produce a plan where
no probe ever ran, and v1 of `QueryPlan` required `probe: { hits, usable }`.
Those paths would have had to write `{ hits: 0, usable: 0 }` — a measured zero
standing in for an absence, which is exactly the substitution CLAUDE.md
invariant 4 forbids. A seed nobody searched for is not a seed that returned
nothing. `probe` is now nullable and the version is 2. Nothing reads the
contract yet, so the bump cost nothing today; after TICKET-0012 writes the first
artifact it would not have been free.

**2. The probe runs the raw seed, not the four expansion arms.** `expandQuery`
exists and the probe deliberately ignores it. The probe asks _"does the seed as
the operator typed it already work?"_; running the arms answers a different
question — it measures the expansion's yield and then offers to fix a seed that
was never the problem. It also costs one request rather than eight, which is
what makes it cheap enough to run before the run.

**3. `probe.hits` counts the page the probe read, not Algolia's `nbHits`.**
`nbHits` is the size of a result set nobody looked at, and pairing it with a
`usable` count taken from 50 hits would produce a ratio that means nothing. The
number in the artifact is therefore a count of what was actually classified, and
`usable ≤ hits` holds by construction.

**4. The clarifier is a seam, not a call.** The ticket's sequencing note is
explicit that an LLM call must not be stubbed inside this module, so `Clarifier`
and `Chooser` are injected function types. TICKET-0018 supplies the first and
the interactive select supplies the second. The consequence worth noting is that
the below-threshold _branch_ is real and fully tested — a stub clarifier
proposes, a stub chooser picks, `chosen_by: "user"` is recorded — while the
concrete wiring is absent. `@clack/prompts` was **not** added: a dependency for
a UI nothing can feed yet is a dependency added early, and CLAUDE.md's rule is a
line in the relevant ADR per runtime dependency.

**5. Planning is an optimisation, never a gate.** Every failure — a dead probe
request, a clarifier that throws, a chooser that throws, proposals that are all
junk, no TTY, no provider wired — ends with the raw seed and a `chosen_by` that
says which one happened. A thin seed produces a worse run; a failed plan must
not produce no run. This is the opposite policy to the one ARCHITECTURE §5 sets
for the source API itself, and deliberately so: the probe is a measurement, and
losing a measurement is not losing the data.

## Where the model output is narrowed

`sanitiseOptions` is the enforcement point for ADR-0008's non-negotiable split.
A proposal survives only if it is a string, is non-empty after control
characters and newlines collapse to spaces, is at most 120 characters, is not
the seed (the chooser offers "keep the original" itself), and is not a duplicate
of an earlier proposal. At most four survive. Whatever the model returns reaches
`query=` and nothing else — no tag, no date window, no page number, no hit
count, all of which are built by code from CLI flags.

The prompt also names the filter syntaxes and says they would be discarded. That
is belt and braces and is worth the four lines: the sanitiser is what makes it
true, the prompt is what makes a compliant model produce proposals that are not
thrown away.

## The prompt is written and not wired

`prompts/clarify-query.v1.md` exists because CLAUDE.md says prompts are
versioned files rather than inline strings, and the ticket asks for
`prompts/CHANGELOG.md` to start here. Two things keep it from being called:
TICKET-0018 has no provider yet, and `{{thesis}}` has nothing to interpolate
from until the rubric lands at TICKET-0020/0021.

That placeholder is the interesting part. ADR-0008 wants the clarifier to have
seen the thesis; invariant 7 says the thesis lives in exactly one place and is
not restated in a prompt as free text. Interpolating it from the rubric is what
satisfies both, and it is recorded in the CHANGELOG rather than decided quietly.

## What the record should be honest about

**`chosen_by: "non-interactive"` now does three jobs.** ADR-0008's table gives it
one meaning — "no TTY" — and the code reaches it from three places: no TTY, no
clarifier wired, and a clarifier or chooser that threw. All three are honestly
described by "nobody was asked", and none of them is distinguishable in the
artifact. A reviewer who wants a run to be able to say _the provider was down_
rather than _nobody was there_ needs a fourth enum value. Recorded as
inconsistency 29 in STATE.md rather than added on a guess.

**The probe threshold is still an unmeasured guess and is now load-bearing.**
D-6's default of 8 decides whether a run spends an LLM call, and `usable` is a
count from a classifier that errs towards accepting (inconsistency 21). Both
halves of the comparison are generous, in the same direction. The first real run
at TICKET-0013 is where that gets a number.

**`--no-expand` is honoured here for planning only.** It skips the probe and the
clarifier. Whether it _also_ cuts `expandQuery`'s four arms in the search that
follows is TICKET-0012's call — the flag's help text says "use the raw seed
verbatim", which reads like it should.

**One request, and the cache is on by default.** The probe goes through
`httpGet`, so a same-day re-run of the same seed and window is served from the
cache and costs nothing. That also means a probe result can be up to 24 hours
stale (inconsistency 16), which for a yield measurement is fine and is not fine
for anything that reads `retrieved_at`. Nothing here writes evidence.

## Verification

- `pnpm test` — **258 passed** (221 at the start of the session; +3 contract
  tests for the nullable probe, +34 for planning). Offline, no key, stub
  transport throughout.
- `pnpm typecheck` and `pnpm lint` clean.
- Ticket acceptance, all five rows covered: probe above threshold passes through
  with a call-counting stub asserting zero LLM calls; below threshold with no
  TTY records `non-interactive`; `--query-plan` and `--no-expand` each bypass
  planning and make no request; a committed `query_plan.json` is returned
  verbatim on replay with nothing searched and nobody asked; a failed probe
  request records `probe_failed` and the run continues.

## What went wrong

Two things, both mechanical. The first draft of the option sanitiser wrote
literal control characters into the source file rather than an escape sequence —
a regex that lints clean and puts a NUL byte in a `.ts` file. Replaced with the
`\p{C}` property escape. The second was `chosenOrSeed` calling `sanitiseOptions`
with a sentinel seed string to reuse its cleaning; the shared half is now
`cleanOption` and both callers use it.

## Decisions taken

None of STATE.md's open decisions were answered. D-6 is now _measurable_ against
the number this module computes, and is still a guess.

**TICKET-0011 is Done.** TICKET-0012 is Ready, and it is the last ticket before
the gate at TICKET-0013.

## Attribution

`src/source/plan.ts`, `tests/plan.test.ts`, the contract bump, both prompt files
and this worklog's factual sections are AI-written end-to-end. All five
judgement calls above were made by the AI.

## Reflection

Assuming user's query will yield good results, is incorrect. We need to probe HN using the query, and check the number of results. If the required threshold is not reached, LLM shows options to choose from. Makes the tool a bit more interactive, but improves the quality of results. An accepted trade-off.

## Next

[TICKET-0012](../tickets/0012-ticket-stage-1-wiring.md) — wire `./pipeline
source`. It owes three things beyond the wiring: the run-level failure decision
`searchHn` deliberately does not make (inconsistency 24), the
`Candidate.provenance` plurality question (inconsistency 25), and the
`dedupeHits` → `--limit` → `resolveSites` ordering that keeps redirect
resolution to one request per candidate. Then the gate at
[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md).
