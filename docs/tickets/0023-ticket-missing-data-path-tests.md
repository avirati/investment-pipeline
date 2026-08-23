# TICKET-0023 — Missing-data path tests

Status: **Ready** — 0026 is Done; 0022 is shipped and with the author · Depends on: 0022 (In review), 0026 (Done) · Blocks: 0028
Reads: [TESTING §6](../TESTING.md), [SPEC §3](../SPEC.md), [CLAUDE.md](../../CLAUDE.md) invariant 4

## Why

"Robust to bad or missing data" is in the brief. Worklog 0002 says this is the
group the author cares most about, because it turns a README claim into a tested
behaviour. It is a cross-cutting ticket on purpose — the property is end-to-end,
not per-module.

## Scope

Each case below must produce a **valid memo with reduced coverage and an explicit
entry in `unknowns[]`** — never a crash, never a fabricated value:

- No GitHub org found.
- Company site returns 404.
- Company site times out.
- Company site serves an empty JS shell.
- Zero founders identifiable.
- HN thread with no comments.
- Model returns valid JSON with every optional field null.

Each runs offline from committed fixtures, end-to-end through analyse and memo.

## Acceptance

- Seven cases, seven passing tests, each asserting on `coverage`, `unknowns[]`,
  and a rendered memo that says "unknown" in words.
- No case produces a thrown exception or a zeroed dimension.
- Add any additional failure shape found during TICKET-0013 or TICKET-0028.
