# TICKET-0025 — Citation validator (`src/memo/validate.ts`)

Status: **Done** — [worklog 0037](../worklog/0037-memo-validator.md). `src/memo/validate.ts` reads the ids and labels back out of the *rendered markdown* rather than trusting `Memo.citations`; all three acceptance items met, 21 tests, failure path first. The `exitFor` branch that turns `MemoValidationError` into a process exit is TICKET-0026's, because `memo` is still `notImplemented` · Depends on: 0007, 0024 (Done) · Blocks: 0026
Reads: [ADR-0003](../adr/0003-evidence-store-and-citations.md), [ARCHITECTURE §5](../ARCHITECTURE.md#5-failure-policy), [TESTING §2](../TESTING.md)

## Why

The enforcement end of the citation contract. Everything else in the design makes
inventing a source *hard*; this makes it *fatal*. It is also the one failure in
the whole pipeline that is a **hard fail** rather than a degradation — a memo
citing a source that does not exist is a correctness bug, not a data gap.

## Scope

- Parse every evidence id out of a rendered memo; resolve each against the run's
  evidence store on disk.
- Any unresolvable id → **abort the run**, non-zero exit, message naming the memo
  and the id.
- Distinguish "no file" from "file present but unreadable" — both fail, with
  different messages, because they have different causes.
- Verify the Sources table lists every id the body cites and no id it does not.
- Verify the score in the header equals the arithmetic sum of the dimensions in
  the analysis JSON (SPEC §4 hard rule 3). A rendering that disagrees with its
  own source data is the same class of bug.

## Acceptance

Per TESTING §2, with the **failure path tested first**:
- A memo citing an id with no file behind it aborts the run with a non-zero exit.
- A valid memo passes and every citation resolves to a readable record.
- A header score that disagrees with the summed dimensions fails.
