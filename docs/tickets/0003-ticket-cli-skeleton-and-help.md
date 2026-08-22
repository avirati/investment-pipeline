# TICKET-0003 — CLI skeleton and the `--help` contract

Status: Open · Depends on: 0001, 0002 · Blocks: 0004, 0012, 0022, 0026, 0027
Reads: [ARCHITECTURE §7](../ARCHITECTURE.md#7-cli), [SCOPE](../SCOPE.md) in-scope #12

## Why

The help text was written before the code precisely so the contract is pinned
rather than discovered. This ticket makes the committed help sketch executable.
Landing it early means every later stage ticket wires into a CLI that already
exists instead of growing one.

## Scope

- `src/cli.ts` — `commander`, four sub-commands: `run`, `source`, `analyse`,
  `memo`. Each command parses its flags, prints a "not implemented yet" line, and
  exits non-zero.
- Flags exactly as pinned in ARCHITECTURE §7, minus the feed seed form
  (TICKET-0002): `--seed`, `--limit` (15), `--min-hits` (8), `--query-plan`,
  `--no-expand`, `--since` (180), `--run`, `--replay`.
- `-h` / `--help` works on the top-level command **and every sub-command**.
- Seed forms and worked examples appear in the top-level help, per SCOPE #12.
- Exit codes: 0 success, non-zero on any failure. Pick two or three and document
  them in the help epilogue — a hard invariant failure (ADR-0003 citation check)
  should be distinguishable from a data-gap failure.

## Out of scope

Any stage logic. This ticket ships a CLI whose commands do nothing.

## Acceptance

- `pnpm exec tsx src/cli.ts --help` reproduces ARCHITECTURE §7's help sketch,
  allowing for the feed-form removal. If the sketch and the output differ, fix
  whichever is wrong and say which in the commit message.
- `--help` on each of the four sub-commands exits 0 and lists that command's flags.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
