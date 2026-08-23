# Session 0037 — 2026-08-23 — The memo validator

[TICKET-0025](../tickets/0025-ticket-memo-validator.md), in one commit.
`src/memo/validate.ts` is the enforcement end of the citation guarantee: the one
place in this pipeline where a failure is a **hard fail** rather than a
degradation. **The ticket is done**; all three acceptance items are met, and the
half that turns a thrown error into a process exit belongs to TICKET-0026.

## What I asked for

Continue implementation, small reviewable commits on a feature branch, worklog,
ticket statuses updated.

## What landed

| Commit    | Contents                                               | Tests |
| --------- | ------------------------------------------------------ | ----- |
| `bbfd68d` | `src/memo/validate.ts` + `tests/memo-validate.test.ts` | +21   |

**1006 tests** (985 at the start: +21), typecheck and lint clean, offline and
with no `.env`. No token was spent — stage 3 cannot spend one.

## Three decisions

**1 — It validates the markdown, not the `Memo` object.** The obvious
implementation resolves `Memo.citations`, which is a one-line loop and is
worthless: `citations` is the _renderer's own account_ of what it cited. A
template that drops the sources table, a label that never reaches a bullet, a
`forEach` that stops one row short — none of those touch `citations`, and all of
them produce a memo whose claims a reader cannot follow. So the validator parses
the ids and the labels back out of the rendered markdown, which is the artifact
a reader actually gets, and then checks `citations` _against_ that as one more
thing that can disagree (`citation_list_mismatch`).

The cost is honest and worth writing down: the validator now knows the memo's
layout. Three regexes — a sources row, a bracketed citation, the header's score
— encode what `templates/memo.md.eta` prints. CLAUDE.md's argument for a
template was that a partner can edit a memo without reading TypeScript, and a
partner who moves the id out of the first column of the sources table will now
fail their own memo. That is the right failure — a table whose ids the validator
cannot find is a table a reader cannot follow either — but it is a coupling that
did not exist before this commit, and it is named in the module header.

**2 — Three misses, three messages.** `EvidenceStore.read` already distinguished
`not_found`, `unreadable` and `invalid`; the ticket asked for two of them and the
store had a third. They stay distinct all the way to the operator's terminal
because they have three different causes and three different fixes: an id nobody
wrote is a citation bug (file it), a file that will not open is an environment
problem (check the disk), a file that is not a record is a store something else
has written to (find out what). Collapsing them into "citation did not resolve"
would be tidier and would send an operator to the wrong place two times in three.

The malformed-id case falls out of this for free. The sources-row regex captures
whatever sits between the backticks rather than sixteen hex characters, so
`` `../secrets` `` is reported as a citation that does not resolve — which is
what it is — instead of being skipped by the regex and vanishing. The store's
own id check is what judges the shape, which keeps path traversal out of the
join in exactly one place.

**3 — The whole set fails at once.** `assertMemosValid` takes every memo's
result rather than one memo's, because fixing a run one exit code at a time is
not a workflow. A run with three bad memos reports three problems, names all
three memos, and exits once.

`MemoValidationError` carries `EXIT.INVARIANT` on itself rather than leaving the
CLI to pick a number. It is not yet in `exitFor` in `src/cli.ts`: the `memo`
command is still `notImplemented`, so a branch for an error nothing can throw
would be dead code with no test behind it. That line is TICKET-0026's, and its
acceptance is the same acceptance.

## The tests

**21 in `tests/memo-validate.test.ts`**, failure path first per TESTING §2. The
fixtures are TICKET-0024's two committed goldens run through the real renderer,
so what is validated is a memo this pipeline actually emits; the evidence store
is a real `evidenceStore` on a temp directory, and every failure is staged by
editing the markdown of a memo that passes.

The acceptance items, literally:

- **An id with no file behind it aborts the run** — `deadbeefdeadbeef` swapped
  into the sources table; `MemoValidationError`, `exit === EXIT.INVARIANT`,
  message naming `acme-traces.md` and the id.
- **A valid memo passes and every citation resolves** — both goldens, `ok`,
  `resolved === citations.length`, and the printed table equal to
  `Memo.citations`.
- **A header score that disagrees with the summed dimensions fails** — in both
  directions: the header edited away from the analysis, and the analysis's
  dimensions edited away from its own total.

Three that are not in the acceptance and are the reason this module exists:

- A bullet citing `[E9]` with no row for it fails (`missing_source_row`).
- A row nobody cites fails (`orphan_source_row`) — a source row nobody cites
  reads as a source somebody used.
- A record on disk that the memo never cites is **not** a problem. The table is
  the cited set, not the gathered set, and the thin golden's dead site is
  exactly that case. This is the line between this validator and inconsistency
  92, which is about the gathered set being invisible and is still open.

The `unreadable` case is staged by putting a _directory_ where the record should
be rather than by `chmod 000`, so it fails the same way for a suite running as
root.

## What is not checked, deliberately

Whether the _right_ records were cited, whether a bullet's text is supported by
the record behind it, whether the call is defensible. Those need a reader, and
claiming them would be claiming the rubric is validated — which
[SCOPE](../SCOPE.md) says it is not. The validator checks that everything the
memo points at exists and that the memo agrees with itself, which is the part a
machine can be certain about.

## Reflection

N/A
