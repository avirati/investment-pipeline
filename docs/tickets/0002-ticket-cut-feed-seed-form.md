# TICKET-0002 — Cut the `feed` seed form

Status: Open · Depends on: — · Blocks: 0003, 0005
Reads: [STATE](../STATE.md) D-3 and known inconsistency #1, [ADR-0004](../adr/0004-source-selection.md)

## Why

`ARCHITECTURE.md` §7 advertises `--seed yc:w25` and `SPEC.md` §3.1 names three
seed forms, but no feed adapter is specified anywhere and ADR-0004 explicitly
*rejected* the YC directory as a source. The docs currently promise a CLI surface
that contradicts an accepted ADR. Fix it before the CLI encodes it.

Docs-only ticket. Deliberately first, and deliberately separate from the CLI
work, so the diff that removes a promised feature is readable on its own.

## Scope

Take **D-3**'s documented default: support `topic` and `urls` only.

- `SPEC.md` §3.1 — two seed forms, not three.
- `ARCHITECTURE.md` §7 — remove `--seed yc:w25` from the help sketch.
- Anywhere else `feed` survives a `grep -rn "feed\|yc:w25" docs README.md`.
- `STATE.md` — move D-3 out of open decisions; strike inconsistency #1.
- Add a line to ADR-0004's consequences, or a one-line note in the worklog,
  saying the seed form was cut to match it. Do not open a new ADR for this —
  it is an alignment to an existing decision, not a new one.

## Out of scope

The `urls` seed form's implementation (TICKET-0012).

## Acceptance

- No reference to a feed seed form survives in `docs/`, `README.md`, `CLAUDE.md`.
- STATE's open-decision table and inconsistency list both reflect the cut.

## Decisions taken

**D-3** — cut, per its documented default.
