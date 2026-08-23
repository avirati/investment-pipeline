# Session 0038 — 2026-08-23 — Stage 3 wired

[TICKET-0026](../tickets/0026-ticket-stage-3-wiring.md), in two commits. A memo
reaches disk for the first time, and `MemoValidationError` reaches a process
exit for the first time. **The ticket is done**; all three acceptance items are
met and were checked by running the command, not only by running the suite.

## What I asked for

Continue implementation, small reviewable commits on a feature branch, worklog
with reflection hints, ticket statuses updated.

## What landed

| Commit    | Contents                                       | Tests |
| --------- | ---------------------------------------------- | ----- |
| `a734ce9` | `src/memo/index.ts` + `tests/memo-run.test.ts` | +21   |
| `81c914a` | `src/cli.ts` + `tests/cli.test.ts`             | +4    |

**1031 tests** (1006 at the start: +25), typecheck and lint clean, offline and
with no `.env`. No token was spent, and this time that is structural rather than
incidental — stage 3 has no import path to a provider.

## Four decisions

**1 — Nothing is written until every memo has passed.** The set is rendered and
validated in memory, `assertMemosValid` throws for the whole set, and only then
does `memos/` get touched. The alternative — write, then validate — is one line
shorter and leaves a memo on disk that a reader has no reason to distrust, which
is the exact failure ADR-0003 exists to prevent. The price is real and is worth
stating: **an operator cannot open the memo that failed.** What they get instead
is the analysis JSON that produced it and a message naming every id that did not
resolve, which is enough to find the bug and not enough to see the page. Three
tests pin the choice — `memos/` stays empty, the manifest gets no stage-3
record, and a memo a previous good pass wrote is not overwritten by a failing
one.

**2 — It is synchronous.** Stages 1 and 2 are `async` because they wait on the
network and on a model. Stage 3 waits on nothing, and an `async` here would
advertise a suspension point that does not exist. TICKET-0027's `run` composes
it after two awaits, which costs nothing.

**3 — Only the cited records are read.** `evidenceFor` reads `citedIds` through
the store rather than loading `runs/<id>/evidence/`. A gathered record no memo
cites has no row to appear in, so reading the directory would make a run of two
hundred records pay for the two a memo needed. This is also the seam where
[inconsistency 92](../STATE.md) lives — the gathered set is invisible in a memo,
and this file is now the place that decides so.

**4 — An unreadable analysis costs its own memo and no others**, the same
treatment stage 2 gives a bad line in `candidates.jsonl`. A run where _nothing_
parses stops with `no_analyses`, which is a data gap (exit 2) rather than a bug.
Arguable: a file in `analyses/` that is not an `Analysis` was written by stage 2
and could be read as a broken contract, i.e. exit 3. It is not, because the
likelier cause by far is a schema version that moved under a run from last week,
and the operator's move there is to re-run `analyse`, not to file a bug.

## The exit codes, now real

`exitFor` gained stage 3's two errors and `EXIT.UNIMPLEMENTED` is now down to
one caller (`run`, TICKET-0027):

| Error                     | Exit | Means                                       |
| ------------------------- | ---- | ------------------------------------------- |
| `MemoError · no_run`      | 1    | `--run` names no finished stage-2 run       |
| `MemoError · no_analyses` | 2    | the run is there and has nothing to render  |
| `MemoValidationError`     | 3    | a memo cites a record that does not resolve |

The 3 is the first exit code in this repo that means _file a bug_. It carries
its own number on the error, as TICKET-0025 left it, so the CLI branch is
`return error.exit` rather than a second opinion about severity.

## The tests

**21 in `tests/memo-run.test.ts`**, failure path first, plus 4 in
`tests/cli.test.ts`. Inputs are TICKET-0024's two committed goldens assembled
into a run directory on a temp root — the same trick `tests/memo-validate.test.ts`
uses, because the golden ids are hand-authored and would not survive
`store.write`'s content-addressing check.

The acceptance items, literally:

- **Runs with `.env` absent and no key** — a test strips every `LLM_*`,
  `MODEL_*`, `ANTHROPIC_*`, `OPENAI_*` and `GITHUB_*` variable from the
  environment and renders both goldens.
- **The network is down** — `globalThis.fetch` is replaced by a function that
  _throws_, not one that counts. An assertion that stage 3 made no request is
  worth having only if the path could not have made one; `replayHttp` in stage 2
  takes the same position.
- **Snapshot** — the file stage 3 writes to disk is compared byte-for-byte with
  `tests/golden/memo.golden.md`, so the wiring is tied to TESTING §7's snapshot
  rather than having a second one of its own.
- **Idempotent** — two passes, byte-identical files, and the second reports
  `written: 0, unchanged: 2`. A memo somebody hand-edited is rewritten and says
  so, which is the same check from the other side.

## Read as a reader, not as a test

Per worklog 0035's rule, the command was run by hand over both goldens before
this was written. Two things only that pass showed:

- The summary prints a path per memo rather than the directory, because the
  thing an operator does next is open one and a terminal makes a path clickable.
- `unchanged` earns its place in the summary. Stage 3 is the command that gets
  re-run after a template change, and a pass reporting _fifteen unchanged memos_
  is the one that says the change did nothing. That is the failure this stage
  would otherwise hide.

Nothing in the output had to be fixed, which breaks a seven-module streak of
live output changing the code. It is also the first module in that streak whose
input was two committed artifacts rather than the world.

## Two gaps this leaves

- **A stale memo is never removed.** If a run is re-rendered after an analysis
  is deleted, `memos/<run_id>/` keeps the memo for a company the run no longer
  has. Detecting it is a `readdirSync` and a set difference; deleting somebody's
  file is a decision, and it was not this ticket's.
- **`setup.sh` step 6 is still a TODO.** `memo` no longer exits 70, so half the
  reason the step could not exist is gone; the other half — there is no
  committed sample run — is TICKET-0028's, and inconsistency 84 still stands in
  front of it.

## Reflection

Stage 3 complete, the tool should be ready for a proper run.

## Next

**TICKET-0026 is Done.** Two tickets unblock:

- [TICKET-0027](../tickets/0027-ticket-run-command-and-replay.md) — `./pipeline
run`, which is now three function calls and one manifest, and the ticket that
  retires `EXIT.UNIMPLEMENTED`.
- [TICKET-0023](../tickets/0023-ticket-missing-data-path-tests.md) — the
  missing-data paths, which need nothing decided and can be done in either
  order.

[Inconsistency 84](../STATE.md) is untouched and still blocks TICKET-0028.
