# Session 0039 — 2026-08-23 — Bundles as artifacts, and `./pipeline run`

[TICKET-0027](../tickets/0027-ticket-run-command-and-replay.md), plus the
blocker it shared with [TICKET-0028](../tickets/0028-ticket-committed-sample-run.md):
[STATE inconsistency 84](../STATE.md). Three commits on two branches. **Both
tickets' code is done**; the sample run itself is [worklog 0040](./0040-sample-run-and-hand-check.md).

## What I asked for

Continue implementation, small reviewable commits on feature branches, worklogs
with reflection hints, ticket statuses updated. Complete tickets 27, 28 and 29
in one go.

## The fork, asked before any code was written

Inconsistency 84 blocks TICKET-0028 **and** collides with TICKET-0027's own
acceptance criterion — *`--replay` makes zero network calls and produces
identical memos*. STATE listed three fixes; I put a fourth to the author with
the measurement that decides between them: **the HTTP cache is 20 MB for a
three-candidate run**, so option (b), committing it, scales badly.

| Option | Chosen |
|---|---|
| (a) Refuse to overwrite an existing analysis without a flag | as well |
| (b) Commit `.cache/http/` | no — 20 MB for 3 candidates |
| (c) Rebuild bundles from `evidence/` | incomplete, see below |
| (d) **Write the bundle as an artifact and have a replay read it** | **yes** |

The author took (d) with (a) alongside it, and kept D-5's topic at its default.
Recorded in [ADR-0009](../adr/0009-bundles-as-artifacts.md).

**Why (c) is not enough, which is the part worth carrying forward.** Evidence
records carry text and transport metadata. They do *not* carry what the adapters
**derived** from the raw payloads — the join, and the signals the rubric scores.
Those come out of GitHub and site payloads that `.gitignore` deliberately drops.
So "the evidence is committed, rebuild from it" sounds right and loses every
number in D3. The artifact had to hold both halves: evidence **by id**, and the
derived material **inline**.

## What landed

| Commit | Contents | Tests |
|---|---|---|
| `65e0857` | `src/contracts/bundle.ts`, `src/analyse/bundles.ts`, stage 2 wiring, `--force` | +18 |
| `a910973` | ADR-0009, ARCHITECTURE §4, `.gitignore` | — |
| `7e3790c` | `src/pipeline.ts`, stage-1 replay, `onCandidate`, `EXIT.UNIMPLEMENTED` retired | +9 |

**1058 tests** (1031 at the start: +27), typecheck and lint clean, offline and
with no `.env`.

## Five decisions

**1 — Order is part of the bundle contract.** `evidence_ids` is stored in gather
order because `bundleItems` is the extraction prompt's input and the LLM cache
key is a hash over that rendered input. A bundle rehydrated in a different order
misses a cache entry it should hit, and a replay that was supposed to cost
nothing asks to spend money. This is asserted rather than commented.

**2 — A missing evidence record fails the whole replay, not the candidate.** A
bundle naming an id the store does not have is a run directory that has lost
half of itself, and every other candidate in it is as likely to be missing
something. Failing once says that; failing per-candidate would print fifteen
lines that look like fifteen thin companies.

**3 — The overwrite guard is the directory's, not the file's.** `analyse`
refuses when `analyses/` already holds anything, unless `--replay` or `--force`.
A partial overwrite — three of fifteen replaced, twelve left from the previous
pass — is a run directory describing two different runs with nothing to tell a
reader which is which.

**4 — `analyse.budget` is null on a replay**, and a new `analyse.bundles` record
says whether stage 2b's input was `gather` or `bundles`. Reporting a plan the
invocation never executed would be a number a reader would believe.

**5 — `run` is thin, and calls the same entrypoints the sub-commands call.** So
`./pipeline run` and the three commands separately produce byte-identical
artifacts, which is what makes the three-command path a real debugging tool
rather than a documented fiction.

## What went wrong

**1 — TICKET-0027's replay acceptance was false for a second reason nobody had
written down.** With bundles landed, the pipeline test still recorded six live
requests on a replay: **stage 1 was searching HN again.** `--replay` had only
ever meant "reuse the run directory and the decided plan". Four requests is the
small half of it — the large half is that **HN moves**, so a replay of last
week's seed can find a company last week's run never saw and write it into a
directory whose analyses do not mention it. Stage 1 now reads the candidates it
already decided and rewrites nothing, so the manifest's `source` record still
describes the search that actually happened. `tests/source-run.test.ts` had a
test asserting the old behaviour; it was rewritten, not deleted.

**2 — I re-ran a live pipeline from the test suite and wrote it into the repo.**
`tests/cli.test.ts` had a case that spawned `run --seed x` for real to assert it
exited 70. I wired `run` before removing that case, so `pnpm test` sourced 15
junk candidates from HN, spent 15 model calls on them, and committed
`runs/2026-08-23-x/`, `memos/2026-08-23-x/` and 14 cache entries. Caught in
`git status` on the commit, reset and cleaned. **The comment directly above that
test says this happened once before, to the same file, for the same reason** —
"Which is what it did for exactly one commit." A warning written by the person
who was bitten did not stop the next person, because I read the list of command
names and not the paragraph above it. The list is now empty and the test asserts
that 70 stays out of the contract.

**3 — A replay overwrites the manifest's `analyse` and `run` records.** Found by
replaying into the committed sample run: the record of the *gather* — 16 site, 6
GitHub, 12 HN requests — was replaced by the replay's `budget: null`. The
per-candidate request counts survive in `bundles/*.json`, so nothing is
unrecoverable, but the run-level totals and `over_planning_ceiling` are gone.
Not fixed; logged as inconsistency 96, and worked around for the sample run by
re-running it clean.

**4 — The ticket's wording about candidate failures is not what the code does.**
SPEC §5 and TICKET-0027 say a run "tolerates individual candidate failures". A
provider that will not answer for one candidate does not produce a `failed`
candidate: `extractFacts` catches it after two attempts and returns `partial`,
so an analysis is still written and a memo still rendered. `failed` is the
narrower case where no analysis exists at all. The `run` record now counts both,
separately, and the test says which one a provider error produces.

## Attribution

`src/contracts/bundle.ts`, `src/analyse/bundles.ts`, `src/pipeline.ts`,
`tests/bundles.test.ts` and `tests/pipeline.test.ts` were **written end to end
by the assistant** and reviewed by me. ADR-0009 was assistant-drafted from the
measurement and the option list in STATE; the decision between the options was
mine, made before any code existed. The stage-1 replay change was the
assistant's finding and its own fix. The four "what went wrong" items were all
found by running the thing.

## Reflection

TODO(author)

TODO(author) — the pattern in "what went wrong" #2 is worth a paragraph: this
is the second time this exact test has spent money, and the second time it was
caught by reading a diff rather than by a guard. Is a guard worth building, or
is the honest answer that the suite should never be able to reach a provider at
all?
