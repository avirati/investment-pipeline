# ADR-0009 — The evidence bundle is an artifact, and a replay reads it

Status: Accepted · 2026-08-23 · Extends [ADR-0001](./0001-file-based-staged-pipeline.md) and [ADR-0003](./0003-evidence-store-and-citations.md)

## Context

ARCHITECTURE §4 has claimed since day one that everything needed to reproduce a
run is committed, and that `--replay` costs nothing. With the first live run
committed, that claim was measured from a fresh `git clone` with no `.env` and
no `.cache/http/`, and it was false in the worst available way. Recorded as
[STATE inconsistency 84](../STATE.md), worklog
[0034](../worklog/0034-first-live-run.md):

> All three analyses went from `TAKE_A_MEETING 75 / WATCH 63 / WATCH 55` to
> `PASS 25` at 0% coverage, the manifest was rewritten, and seven new
> `fetch_failed` records appeared. The committed LLM cache was never consulted
> — `0 calls, 0 from cache` — because an empty bundle short-circuits at
> `no_evidence` before a call is made.

The mechanism is simple once seen. `--replay` suspended the HTTP cache's
staleness rule and swapped the transport for one that refuses. That stops a
replay *spending*; it does nothing about a replay having nothing to read.
`.cache/http/` is gitignored (bulky, and re-fetchable — for a live run, not for
a committed one), so a reviewer's clone is exactly the state where every fetch
refuses, every bundle comes back empty, and stage 2 dutifully writes fifteen
honest 0%-coverage passes over the run it was asked to reproduce.

Two submission-checklist lines depended on this: *the sample run's outputs are
readable without running anything* — true, but one documented command destroys
them — and *re-render from committed artifacts with zero API calls*, which held
for stage 3 and not for stage 2.

Underneath it is a smaller, older defect. The `Bundle` — the thing that carries
evidence ids to extraction, and therefore *what the model was shown* — was a
value passed between two functions and never written anywhere
([inconsistency 70](../STATE.md)). Stage 2a was the only step in a file-based
pipeline (ADR-0001) whose output was not a file.

## Options

1. **Refuse to overwrite an existing analysis without a flag.** Cheapest. Stops
   the destruction and fixes nothing: a replay on a clone still cannot
   reproduce a run, it just fails louder. Worth having regardless.
2. **Commit `.cache/http/` too.** No new code, and a replay reproduces exactly.
   Measured at **20 MB for a three-candidate run**, most of it stage 1's HN
   result pages; a fifteen-candidate run is several times that. It also puts
   raw third-party HTML in git, which is the thing `.gitignore`'s comment and
   ADR-0006 both say we are not doing.
3. **Rebuild the bundle from `runs/<id>/evidence/` on replay.** Principled —
   the evidence *is* committed — but incomplete. Evidence records carry the
   text and the transport metadata; they do not carry what the adapters
   *derived* from the raw payloads: the join, and the signals the rubric scores.
   Re-deriving those means re-parsing payloads the repo does not keep.
4. **Write the bundle as an artifact, and have a replay read it.**

## Decision

Option 4, with option 1 alongside it.

`runs/<run_id>/bundles/<slug>.json` is a seventh Zod contract
(`src/contracts/bundle.ts`, `schema_version: 1`) written by stage 2 for every
candidate it gathers. `--replay` reads those files instead of gathering, so it
makes no request because there is no code path on which it could.

The split inside the artifact is the whole design, and it is what option 3
missed:

- **Evidence is referenced by id, never copied.** The text lives once, in
  `evidence/<id>.json`, already content-addressed and already committed
  (ADR-0003). A second copy would double the repo and give a reviewer two texts
  to reconcile.
- **Everything the adapters derived is stored inline** — the join and which
  direction it was made in, the signals with their `as_of` and `evidence_id`,
  the unknowns, the people, the per-pool request counts, the failures. This is
  the half that is computed from payloads git does not hold, and it is why
  referencing the store alone was not enough.

**Order is part of the contract.** `evidence_ids` is stored in gather order,
because `bundleItems` is the extraction prompt's input and the LLM cache key is
a hash over that rendered input. A bundle rehydrated in a different order would
miss a cache entry it should hit, and a replay would ask to spend money.

Option 1 lands as well, at the run directory rather than the file: `analyse`
refuses when `analyses/` already holds anything, unless `--replay` (which now
reproduces what it overwrites) or `--force` (the operator saying they meant it).
The guard is the directory's because a partial overwrite — three of fifteen
replaced, twelve left from the previous pass — is a run directory describing two
different runs with nothing to tell a reader which is which.

## Consequences

- A fresh clone can replay a committed run to identical analyses and identical
  memos, with no key, no network and no `.cache/http/`. That is the acceptance
  criterion of [TICKET-0027](../tickets/0027-ticket-run-command-and-replay.md)
  and it is now testable rather than asserted.
- Inconsistency 70 closes as a side effect: a reviewer opens one file and sees
  what the model was shown, instead of reconstructing it from an analysis's
  `evidence_ids` plus the store.
- The manifest's `analyse.budget` is now **null on a replay**, and a new
  `analyse.bundles` record says whether stage 2b's input came from `gather` or
  from `bundles`. A replay that reported a plan it never executed would be a
  number a reader would believe.
- **A run directory gets bigger.** One JSON file per candidate, holding no
  evidence text — kilobytes, against the megabytes option 2 would have cost.
- **A bundle that names a record the store has lost fails the whole replay**,
  not the candidate. A run directory that has lost half of itself is not a thin
  company, and reporting it fifteen times would look like fifteen thin ones.
- **Runs gathered before this exist and cannot be replayed.** The error says
  so and names the fix (`without --replay`). The committed sample run is
  re-gathered under TICKET-0028 rather than migrated; there is one of them.
- The bundle is now a schema that can drift from the in-memory `Bundle` it
  serialises. `tests/bundles.test.ts` pins the round-trip with an equality
  assertion over a fully-populated bundle, which is the cheapest guard
  available and not a proof.

## Revisit if

- A bundle grows large enough that `bundles/` is a repo-size problem in its own
  right. It carries no evidence text today; a change that puts text in it is
  the thing to argue about, not the file's existence.
- Stage 1 ever needs replaying too. `candidates.jsonl` and `query_plan.json`
  already make it replayable in the same sense; nothing has tested that from a
  cold clone, and the claim should not be made until something has.
- A second consumer of `bundles/` appears. It is written for replay and for a
  reader; if the rubric or the memo starts reading it, the "nothing downstream
  branches on it" property is gone and the contract needs a harder look.
