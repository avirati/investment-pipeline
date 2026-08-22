# Session 0006 — 2026-08-22 — CLI skeleton and the `--help` contract

[TICKET-0003](../tickets/0003-ticket-cli-skeleton-and-help.md). First real
`src/`: `src/cli.ts`, `src/exit-codes.ts`, `tests/cli.test.ts`, and one edit to
`ARCHITECTURE.md` §7. Four commands that parse their flags correctly and then
refuse to do anything.

## What I asked for

Continue implementation, stop for review before committing, keep the diff small
enough to read, keep adding worklogs.

## What the AI produced

`src/cli.ts` — `commander`, four sub-commands, flags exactly as pinned in
ARCHITECTURE §7 minus the feed seed form. `--help` works on the top-level
command and on all four sub-commands. Every action prints one line to stderr
naming the ticket that will implement it and exits 70.

`src/exit-codes.ts` — five codes:

| | |
|---|---|
| `0` | success |
| `1` | usage or configuration error |
| `2` | data gap — the run completed but found too little to act on |
| `3` | invariant violation — a contract or citation check failed (ADR-0003) |
| `70` | not implemented yet — temporary, `EX_SOFTWARE` from sysexits |

The ticket asked for two or three codes and specifically for a hard invariant
failure to be distinguishable from a data gap. 2 vs 3 is that split, and it is
the one that carries operator meaning: 2 means widen the seed or the window, 3
means file a bug. 70 is scaffolding — it disappears when tickets 0012, 0022,
0026 and 0027 land, and the last one out takes the constant with it.

`tests/cli.test.ts` — 17 tests, all offline, spawning the CLI as a subprocess so
what is asserted is the real exit code rather than a mocked one. They cover the
`--help` contract (both seed forms present, worked examples present, every exit
code documented, no surviving `--feed`), `--help` exiting 0 on each sub-command,
and the exit codes for unimplemented stages, a missing required flag, an unknown
command, and a non-numeric `--limit`.

Three choices in it that were judgement, not transcription:

- **The ARCHITECTURE §7 sketch was replaced by the program's real output, not
  matched by hand.** The ticket allowed either — "fix whichever is wrong and say
  which". Reproducing commander's layout by hand-rolling the help formatter
  would have pinned the contract at the cost of a formatter to maintain, and the
  differences were all cosmetic: commander adds an `Options:` block and an
  `[options]` suffix to each command row, and writes `(default: 15)` where the
  sketch wrote a right-aligned `[default: 15]`. The section now says it is
  pasted verbatim, and `tests/cli.test.ts` asserts the parts that are contract
  rather than formatting, so the two can only drift as far as the tests allow.
- **`memo` has no `--replay`.** Stage 3 makes no LLM calls, so there is nothing
  to replay. The ticket listed `--replay` in the flag set without saying which
  commands take it; offering it on `memo` would have implied stage 3 has a cache,
  which is the CLAUDE.md invariant 3 stated backwards. `analyse` and `source`
  both take it. Noted in `ARCHITECTURE.md` §7 so the omission reads as a decision
  rather than an oversight.
- **`--limit`, `--min-hits` and `--since` are validated at parse time.** A
  positive-integer parser that raises commander's `InvalidArgumentError`, so
  `--limit twelve` is a usage error with exit 1 rather than a `NaN` that reaches
  stage 1 and silently carries zero candidates forward.

## What went wrong

- The first version put the title line in commander's `beforeAll` help slot,
  which propagates to sub-commands. `pipeline memo --help` printed
  "investment-pipeline — startup triage" above its own usage line. Caught by
  reading all four sub-command outputs rather than only the top-level one.
  `before` is command-local; `after` already was.
- `pnpm lint` failed on the first run — biome reformatting of a long `it.each`
  table in the test file. Formatting only, fixed by `pnpm format`. Worth noting
  that `pnpm typecheck` and `pnpm test` both passed at that point, so running
  only two of the three gates would have committed a lint failure.

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0. The suite makes no
network call and reads no API key. The four sub-command help outputs and the
top-level output were each read, not just exit-code checked.

## Decisions taken

None of the open decisions in `STATE.md` were touched. D-2 (memo templating) and
D-6 (the `--min-hits` default of 8) both stay open; 8 is now a default value in
code as well as in prose, which does not make it any more validated than it was.

## Attribution

`src/cli.ts`, `src/exit-codes.ts`, `tests/cli.test.ts` and the `ARCHITECTURE.md`
§7 rewrite: AI-written end-to-end from one prompt, reviewed by me before the
commit. The three judgement calls above were the AI's, surfaced before commit.
The factual sections of this entry are AI-written.

## Reflection

TODO(author).

- The help text now documents a temporary exit code (70). It is honest, and it
  is also a small piece of scaffolding in a user-facing contract. Better than
  overloading exit 1, or should the unimplemented commands have exited 1 and the
  code arrived with the first real stage?
- 17 tests for a CLI that does nothing. Is that the right ratio this early, or
  is it test mass that will need rewriting the moment the actions become real?

## Next

[TICKET-0004](../tickets/0004-ticket-setup-script-and-wrapper.md) — `setup.sh`
and the `./pipeline` wrapper. Note that ARCHITECTURE §7.1 step 6 verifies the
install by running `./pipeline memo --run <committed_sample>`, which now exits 70
and will keep doing so until TICKET-0026. The setup script's self-verification
step cannot pass yet; 0004 has to say what it does in the meantime.
