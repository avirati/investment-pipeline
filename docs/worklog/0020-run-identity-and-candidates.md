# Session 0020 — 2026-08-22 — Run identity, and posts become candidates

[TICKET-0012](../tickets/0012-ticket-stage-1-wiring.md) — stage 1's wiring, and
the first ticket in this repo that will spend a real request. This session took
the three pieces the wiring *needs to already exist* before `./pipeline source`
can be written as a straight line: the contract question the ticket owed
(inconsistency 25), the run identity every stage shares, and the pure step that
turns a group of posts into a `Candidate`. The command itself, the manifest and
the run-level failure decision are not in this session.

## What I asked for

Continue implementation, stop for review, small commits, keep the worklogs and
reflection hints coming, update the ticket statuses.

## What the AI produced

Three commits, in dependency order.

| Commit                  | What it is                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `contracts(candidate)`  | `provenance` becomes a non-empty list; `schema_version` 1 → 2           |
| `feat(run)`             | `src/run.ts` — run ids, artifact paths, the run directory guard         |
| `feat(source)`          | `src/source/candidate.ts` — `ResolvedSite` → `Candidate` without guessing |

| Export                                       | What it is                                                        |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `deriveRunId`, `validateRunId`, `resolveRunId` | `<utc-day>-<seed-slug>`, and what `--run` is allowed to be        |
| `runPaths`, `createRunDir`                   | ARCHITECTURE §4's layout in one place, plus ADR-0001's guard       |
| `deriveName`, `looksLikeName`, `fallbackName` | Where a candidate's name comes from, and where it does not         |
| `slugFor`                                    | One slug per candidate per run, deduplicated                        |
| `toCandidates`                               | The whole step, contract-parsed, with drops as data                 |

## Four judgement calls

**1. `provenance` is a list, not a primary plus an `also_seen`.** STATE.md
inconsistency 25 offered both. Dedup produces a group and the group is ordered —
primary first, by the ranking `resolve.ts` already applies — so one field with a
documented order is one shape to read, where a singular-plus-list is two shapes
that a reader has to merge and a writer can let disagree. It is expressed as a
Zod tuple with a rest element rather than `z.array().min(1)` so the *type*
carries the guarantee too: `provenance[0]` is the primary and needs no undefined
check under `noUncheckedIndexedAccess`. A v1 artifact fails to parse, which is
the point of the bump — and nothing has written a `candidates.jsonl` yet, so the
bump cost nothing today and would not have been free next session.

**2. A name is lifted or it is the domain. It is never composed.** The rule is
that a title is read as a name only when its *shape* marks one: a separator
splitting a short head from a tail. `Show HN: Acme Traces – OTel-native tracing`
names a product; `We rewrote our tracer in Rust` does not, and the domain is
used instead with the whole title kept as the one-liner. The alternative —
title-casing `acmetraces.dev` into "Acme Traces", or asking a model — is stage 1
concluding something, and stage 1 is the widening half of the pipeline
(CLAUDE.md invariant 1). The documented cost is a real name that opens with an
article: "The Browser Company" is rejected by the sentence-opener rule and falls
back to its domain. A plain memo heading beats a wrong one.

**3. The run id is derived from the seed as typed, not from the query chosen.**
The id has to exist before `planQuery` runs, because the plan is written *into*
`runs/<run_id>/query_plan.json`. An id that changed when a person picked a
refinement would mean the artifact could not be filed under the run that
produced it. It also makes the two guards on the same thing — the run directory
and `writeQueryPlan`'s `wx` — nest properly rather than race.

**4. `--replay` is the one caller allowed to reuse a run directory.** ADR-0001
names refusing to overwrite as the concurrency guard, and `createRunDir` is a
bare `mkdir` rather than an `existsSync` check precisely because the check has a
race in the gap. But a replay is by definition a second look at a decided run,
and `planQuery`'s first branch already reads an existing plan rather than
re-prompting. So the guard takes an `allowExisting` flag, the flag is
`--replay`, and the refusal message says so. Note what this does *not* yet
settle: on a replay, `candidates.jsonl` would be rewritten from a fresh search
(served largely from the 24-hour HTTP cache). Whether stage 1 should instead
read the existing candidates back is TICKET-0027's replay semantics, and it is
flagged in STATE.md rather than decided here.

## Three fields the wiring found the contract needed

`Provenance` gained `title`, `posted_url` and `posted_at`, all in the same
unreleased `schema_version` 2.

`title` is the post title verbatim — the input the name was derived from, so
TICKET-0013's hand-check can see the derivation beside its source rather than
re-deriving it by eye. `posted_url` is the link as submitted, before
canonicalisation and redirect resolution, which is the only way a reviewer
reading one JSONL line can see that `acme-traces.launch.page` became
`acmetraces.dev`. `posted_at` is the post's own date and is **null** when the
hit carried none; `at` stays the run clock. Two fields rather than one because
they are two facts, and collapsing them would mean writing the run clock into a
post date on every hit that has no timestamp — a substituted value where there
was an absence, which is invariant 4's exact prohibition.

## What this session did not do

The ticket's four owed items are one-and-a-half done:

- **Inconsistency 25 (provenance plurality)** — closed.
- **The run-level failure decision (inconsistency 24)** — not started.
  `searchHn` still returns failures as data and nothing yet fails the run.
- **`dedupeHits` → `--limit` → `resolveSites` ordering** — not written; the
  pieces it composes now all exist.
- **Whether `--no-expand` also cuts the four search arms (inconsistency 31)** —
  still open, still 0012's call.

`./pipeline source` still exits 70, and the manifest does not exist.

## Verification

- `pnpm test` — **320 passed** (258 at the start of the session: +4 contract
  tests for the plural provenance, +24 for run identity, +34 for candidate
  derivation). Offline, no key, no network in any of them.
- `pnpm typecheck` and `pnpm lint` clean.
- Nothing in this session touches the network or an API key, so none of the
  ticket's acceptance rows — all of which need a live run — are covered yet.

## What went wrong

`RUNS_ROOT` was about to be defined twice, once in `src/run.ts` and once in
`src/evidence/store.ts` where TICKET-0007 had put it. It now lives in `run.ts`,
which owns the layout, and is re-exported from the store so its callers keep one
import. That leaves a wrinkle worth knowing about before the wiring:
`evidenceStore(id, root)` takes the **runs** root and `runPaths(id, root)` takes
the **repo** root. Both are documented at their definitions; neither was changed,
because renaming a parameter in a Done module to suit an unwritten one is the
wrong direction.

Two smaller ones. `slugFor` originally reserved the slug it returned, so a site
that failed the contract parse would have pushed the next real candidate to
`-2`; it now reads the set and the caller records the slug after the parse
succeeds. And the first draft's own doc comment used "The Graph Protocol" as an
example of a name that fits the length budget, while the sentence-opener rule
rejects it — the comment was wrong, not the code, and the test that caught it
now asserts the fallback explicitly.

## Decisions taken

No open decision in STATE.md was answered. Two new numbers were introduced and
both are labelled guesses in the code: `MAX_SEED_SLUG_LENGTH` (48) and the
name-shape budget (`MAX_NAME_WORDS` 4, `MAX_NAME_LENGTH` 40). The first real
run at TICKET-0013 is what gives them a number.

**TICKET-0012 is In progress.**

## Attribution

`src/run.ts`, `src/source/candidate.ts`, both contract changes, all three test
files and this worklog's factual sections are AI-written end-to-end. All four
judgement calls above were made by the AI.

## Reflection

TODO(author) — hints, not prose. Worth a paragraph on:

- Whether "lift the name or use the domain" is the right call for a memo a
  partner reads, or whether a plain `acmetraces.dev` heading undersells a
  candidate badly enough to justify letting stage 2 rename it from evidence.
- Whether the sentence-opener rule earns its false negatives ("The Browser
  Company"), or whether the cheaper rule is: no separator, no name.
- Whether `--replay` reusing a run directory is the semantics you want, given
  that stage 1 would re-search and rewrite `candidates.jsonl` inside it.
- Whether three commits with no runnable command at the end of them is the right
  size to review, or whether you would rather see the wiring in the same PR.

## Next

The wiring itself: `./pipeline source` as `resolveRunId` → `createRunDir` →
`planQuery` → `searchHn` → `dedupeHits` → `--limit` → `resolveSites` →
`toCandidates` → `candidates.jsonl` + `manifest.json`. It still owes the
run-level failure decision (inconsistency 24), the `--no-expand` question
(inconsistency 31), the `urls` seed form, and the fallback for a thin candidate
yield that the ticket asks to be visible in the manifest. Then the gate at
[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md).
