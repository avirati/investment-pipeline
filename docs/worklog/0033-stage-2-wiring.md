# Session 0033 — 2026-08-23 — Stage 2, wired

[TICKET-0022](../tickets/0022-ticket-stage-2-wiring.md), in four commits.
`./pipeline analyse --run <id>` is a real command: it reads stage 1's
`candidates.jsonl`, gathers evidence, extracts facts, scores them and writes one
`runs/<id>/analyses/<slug>.json` per candidate plus the manifest's `analyse`
record. It is the first time the three stage-2 modules have been in the same
process, and the first ticket where a candidate can fail without the run failing.

## What I asked for

Continue implementation, stop for review, small commits on feature branches,
keep the worklogs going with reflection hints, update ticket statuses.

## What landed

| Commit    | Contents                                                           | Tests |
| --------- | ------------------------------------------------------------------ | ----- |
| `2172694` | `requireLlmNames` / `replayModel` — a replay needs no API key      | +8    |
| `f282357` | `Analysis` v2 — `status`, `status_reason`, `inputs`                | +3    |
| `73098b5` | `src/analyse/index.ts` — the stage, the manifest record, the files | +15   |
| `8ec661e` | `./pipeline analyse` wired, exit codes, the run summary            | +5    |

**913 tests** (883 before this ticket: +30), typecheck and lint clean, offline
and with no `.env`. No live run yet — see gap 1, which is the same gap
[worklog 0029](./0029-evidence-gather.md) opened and did not close.

## Five decisions

**1 — Gathering is a barrier; extraction is not.** `gatherRun` divides the
request budget by the candidate count _before_ it touches any candidate, which
is what makes the allowance uniform rather than first-come-first-served
([inconsistency 60](../STATE.md)). That only works if the count is known, so the
gather phase completes for everybody before extraction starts. Extraction then
fans out at its own width — three, against gathering's four — because a gather
is four small reads of somebody's web server and an extraction is one large call
to a provider that bills per token. Both numbers are politeness settings rather
than measurements, and both are options so a run that knows better does not have
to edit the file.

**2 — A candidate's failure is never the run's, and there are exactly two
exceptions.** Everything inside stage 2 already returns failures as data: both
adapters, the fetch layer, and `extractFacts`. So the catch in this layer is for
the cases none of them predicted — and the two errors that _must_ escape it are
the operator's rather than the candidate's. A cold cache under `--replay` and a
cache entry a moved schema left behind both mean the run should stop and be
re-issued, so `LlmCallError` passes straight through and the CLI maps it to a
usage error.

**3 — `--replay` spends nothing in either currency.** The ticket says the LLM
cache; the acceptance says _zero network calls, asserted, not assumed_. So a
replay suspends the HTTP cache's staleness rule — a run re-read a week later is
exactly the case `HTTP_CACHE_MAX_AGE_MS` exists to expire, and expiring it would
turn a replay into a re-fetch — and replaces the transport with one that
refuses. The assertion is then structural: the code path cannot make a request,
including in tests, where the stub transport passed in is deliberately never
reached.

That is also why `replayModel` exists. `callModel` answers a replay entirely
from the cache and never touches the adapter, and the cache key holds only the
provider's and the model's _names_ — so demanding `OPENAI_API_KEY` for a request
that will not be sent is `config.ts` rule 1 broken in the direction nobody
notices. A fresh clone with a committed cache and no key can now re-run stage 2.

**4 — The `Analysis` had to learn the difference between silence and absence.**
A candidate the model failed to answer about and a candidate there was nothing
to find about both arrive at stage 3 as zero facts, scoring at the unknown
floors with 0% coverage and a PASS. Stage 3 has no LLM and may not guess
(invariant 3), so v2 carries `status`, a `status_reason` a memo can print
verbatim, and an `inputs` record: evidence gathered, evidence readable, gather
failures, and the extraction's own status, attempts and drops by kind. This is
the third of the three things STATE handed this ticket, and it is deliberately
_not_ a second copy of the manifest — a memo for one company must render from
that company's analysis alone.

**5 — Drops are counted in both places.**
[Inconsistency 77](../STATE.md): `extractFacts` reported its own `dropped[]` and
nothing summed them, so a run where the model produced twelve facts a candidate
and eleven were refused read, from the manifest, exactly like a run with thin
evidence. Per candidate the count is in the analysis; run-wide it is in the
manifest, by kind.

## The tests

15 new in `tests/analyse-run.test.ts`, all offline against committed fixtures,
plus five CLI cases that exit before a request is made:

- **The ticket's acceptance, literally.** One candidate's site 404s and another
  candidate's model call fails twice; the run completes, the first is `ok` with
  a gather failure recorded and the second is `partial` with `attempts: 2`, and
  the manifest carries both.
- **Replay makes zero of both.** A cold run warms an HTTP cache and an LLM
  cache; the replay's transport records no call, the stub model records no
  input, every call is served `from_cache`, and the scores are identical. A
  second case runs the same replay from a keyless environment.
- **A cold LLM cache under `--replay` stops the run** with `replay_miss` rather
  than quietly calling the provider.
- **Nothing readable means the model is not asked at all**: `no_evidence`, zero
  attempts, coverage 0, and unknowns written out.
- **Every id an analysis cites resolves to a file in the run's evidence store**
  (ADR-0003, and the thing TICKET-0025's validator will enforce).
- **A candidate that throws is a `failed` row and the run still finishes.**
  Provoked with an unwritable `analyses/` directory, because nothing inside
  stage 2 throws per candidate by design — see gap 3.

## Gaps

1. **Still no live run.** [Inconsistency 69](../STATE.md) again, and it now has
   a name: every stage-2 module except the two adapters has been built and
   tested entirely against stubs. Both live runs that _did_ happen changed the
   code, twice each. The prompt has still never been sent to a provider
   ([72](../STATE.md)), `MODEL_EXTRACT` is still empty, and `./pipeline analyse`
   has never spent a token. This is the ticket where that was supposed to
   happen; it is deferred again, deliberately, because the first call is the
   author's to authorise and the sample run at TICKET-0028 is where it belongs.
2. **The `unknown_evidence_id` drop is unreachable in production.** Found by a
   test, not by reading. `extractionSchema` makes the citable ids an enum, so an
   out-of-enum id fails the whole response inside `createModel`'s own
   `schema.parse` and costs the retry; the client-side check in `parseFacts`
   then has nothing left to catch, because the two routes its comment names — a
   provider that treats the schema as advice, and a cached answer written before
   the schema moved — are both closed. A hand-edited cache entry is the only one
   left. The check stays (it is cheap and it is the ADR-0003 guarantee written
   down), but it is now a documented dead branch rather than a live one. New
   STATE inconsistency 83.
3. **`failed` has no natural cause.** Every module underneath returns failures
   as data, so the only things that can throw per candidate are a filesystem
   error and a bug. That is the design working, but it means the `failed` row is
   tested against a permissions error rather than against anything a real run
   would produce, and a reviewer should read it as "something we did not
   predict" rather than as a category with known members.
4. **A replay writes new `fetch_failed` records when the HTTP cache is cold.**
   The refusing transport becomes evidence, which is honest — _we did not look_
   rather than _we looked and found nothing_ — but it means a replay of a run
   whose HTTP cache has been cleared adds records to the run's evidence
   directory rather than reproducing it exactly. `.cache/http/` is not
   committed, so this is the state a fresh clone is in. New STATE
   inconsistency 84.
5. **The memo's own fields are still missing.** [Inconsistency
   9](../STATE.md) is only half closed: the artifact now says how it was
   produced, and it still does not carry SPEC §4's Team / Product / Market /
   Risks split, the "what would change my mind" list, or the checkable upgrade
   trigger every Watch owes. All three have to be _derived_, not written by a
   model (invariant 1) and not invented by stage 3 (invariant 3) — which makes
   them a design decision about what can be mechanically said, not a schema
   change. Left for review rather than taken unilaterally; see **Next**.

## Attribution

`src/analyse/index.ts`, the two additions to `src/config.ts` and
`src/llm/provider.ts`, the `Analysis` v2 fields, the CLI wiring, all 30 tests
and this worklog's factual sections are AI-written end to end. No human has read
the stage-2 output of a real run, because there has not been one.

## Reflection

We can now do a live run with LLM. The run should cache LLM responses while omitting HTTP responses (expected, as per ADR)

## Next

**TICKET-0022 is in review.** Two things follow it, and one decision is owed
before the second can start:

- [TICKET-0023](../tickets/0023-ticket-missing-data-path-tests.md) — the
  missing-data paths — is unblocked and needs nothing decided.
- [TICKET-0024](../tickets/0024-ticket-memo-template-and-render.md) is unblocked
  only in part. It renders an `Analysis` and the `Analysis` still lacks the four
  section lists and the two derived lists SPEC §4 asks for (gap 5). The proposal
  is to derive all of them mechanically in stage 2 — sections by grouping facts
  under the memo's headings, "what would change my mind" and the Watch upgrade
  trigger from the rubric's own next-band-up labels and the arithmetic distance
  to the next threshold — which keeps every sentence in a memo either a cited
  fact or a statement about the rubric. That is a `schema_version` bump and one
  new module, and it is the author's call.
- The first live run and the first captured model output — TICKET-0020's
  outstanding acceptance item — are still the author's, and are now the same
  action: `./pipeline analyse --run <a real stage-1 run>`.
