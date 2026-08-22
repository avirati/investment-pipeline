# TICKET-0016 — Company site adapter (`src/evidence/site.ts`)

Status: Blocked · 0014 · Depends on: 0008 (Done), 0014 · Blocks: 0017
Reads: [SCOPE](../SCOPE.md) in-scope #2 and cut corner #1, [ADR-0005](../adr/0005-typescript-stack.md)

## Why

Where founders, positioning, and customers come from. SCOPE is explicit that
founder identification is best-effort and that **a wrong founder is worse than a
missing one** — this module must be built to fail loudly into `unknowns[]` rather
than to guess.

## Scope

- Home page + targeted extraction of team/about/founders pages, and pricing or
  docs pages where they exist (D-4 disqualifier turns on whether a self-serve or
  open-source path exists at all).
- `cheerio` for targeted structure. No readability pass and no DOM — D-8 cut
  it; prose arrives with more boilerplate and that is the accepted cost
  ([ADR-0005 amendment](../adr/0005-typescript-stack.md)).
- Handle the failure shapes TESTING §6 names: 404, timeout, empty JS shell.
  Each becomes a `fetch_failed`-typed record, not an absence.
- English-language sources only (SCOPE cut corner #4) — detect and record when a
  site is not, rather than extracting nonsense from it.
- No people-data provider. None is free, and SCOPE already closed this.

## Acceptance

- Tests against committed page fixtures: team page yields named people; empty JS
  shell yields a record marked empty, not an exception; 404 and timeout both
  produce `fetch_failed` records.
- Extracted text is truncated per TICKET-0007's constant.
