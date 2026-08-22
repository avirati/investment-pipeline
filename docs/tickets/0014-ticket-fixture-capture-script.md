# TICKET-0014 — `pnpm capture-fixtures`

Status: Open · Depends on: 0013 · Blocks: 0015, 0016, 0023
Reads: [TESTING — Fixtures](../TESTING.md#fixtures)

## Why

TESTING commits to this script by name. It is what keeps the suite offline as
stage 2 adds three more external surfaces, and the fixtures double as a record of
what the external APIs actually returned on the day the code was written.

Placed after the gate deliberately: capture from a run whose output has been
looked at, not from a guess about what the APIs return.

## Scope

- Script that captures and normalises real responses into `tests/fixtures/`:
  Algolia result pages, GitHub org and repo payloads, a handful of company home
  and team pages.
- Also commit **deliberately malformed** model outputs — TESTING lists them, and
  the extraction failure path (TICKET-0020) needs them.
- Run manually and rarely. Not wired into `pnpm test`, not run in CI.
- Strip anything credential-shaped from captured headers before writing.
- A short `tests/fixtures/README.md`: what each fixture is, when captured, and
  the command that produced it.

## Acceptance

- `pnpm capture-fixtures` refreshes fixtures without hand editing.
- `pnpm test` still passes with the network unplugged and no `.env`.
- No token, cookie, or key appears anywhere under `tests/fixtures/`.
