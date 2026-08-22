# Session 0007 — 2026-08-22 — `setup.sh` and the `./pipeline` wrapper

[TICKET-0004](../tickets/0004-ticket-setup-script-and-wrapper.md). Two new
executables at the repo root — `setup.sh` and `pipeline` — and one paragraph
added to `ARCHITECTURE.md` §7.1. No TypeScript changed.

## What I asked for

Continue implementation, stop for review before committing, keep the diff small
and easy to read, keep adding worklogs.

## What the AI produced

`./pipeline` — six lines. `cd` to the script's own directory, then
`exec pnpm exec tsx src/cli.ts "$@"`. The `cd` is the only addition to what
ARCHITECTURE §7.1 specifies: without it the wrapper only works when invoked from
the repo root, which is not what "a thin wrapper so nobody needs to know pnpm
exists" is for.

`./setup.sh` — steps 1–5 of ARCHITECTURE §7.1, `set -euo pipefail`, each step
announcing what it is doing and what it found:

1. **Node** — reads `node --version`, compares the major to 22. On failure the
   message names both the version found and the path it came from, because on a
   machine with nvm the interesting question is usually _which_ node.
2. **pnpm** — `corepack enable pnpm` first (it ships with node and honours
   `packageManager` in `package.json`, so the version is pinned), then a third
   path the ticket did not ask for: if corepack fails but pnpm is already on
   PATH, use it and say so. Only if both miss does it `npm i -g pnpm`. Installing
   a global package over a working local one would be rude on a machine that
   already had pnpm from Homebrew.
3. **Install** — `pnpm install --frozen-lockfile`, output not swallowed.
4. **`.env`** — copied from `.env.example` **only if absent**; otherwise it says
   "already present — left untouched". When it does create one, it names the four
   variables that need filling in and notes that `memo` needs none of them.
5. **Typecheck** — `pnpm typecheck`.

**Step 6 is deliberately absent.** ARCHITECTURE §7.1 ends with
`./pipeline memo --run <committed_sample>`, an offline self-verification. `memo`
exits 70 until TICKET-0026 and there is no sample run until TICKET-0028, so the
step would fail every time it ran. The script ends with a `TODO(0028)` comment
naming the ticket, and — the part that matters more — prints a closing line
telling whoever ran it that the verification is not wired up yet. A gap the
operator can see beats a gap only the docs know about.

`ARCHITECTURE.md` §7.1 gained a paragraph saying steps 1–5 exist and step 6 does
not, and why. This is STATE.md known-inconsistency #5; it is now recorded in the
document that makes the promise rather than only in the handoff note.

## Verification

All four acceptance criteria were run, not reasoned about:

| Criterion                                     | Result                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `./setup.sh` on a fresh clone exits 0         | 0 — five steps, install and typecheck both clean                                           |
| Second run exits 0 and reports `.env` present | 0 — `.env already present — left untouched`                                                |
| Node < 22 fails naming the version found      | exit 1, `Node 22+ is required, found v20.11.1 (<path>)`, via a stub `node` earlier on PATH |
| `./pipeline --help` works                     | prints the help block; `./pipeline memo --run x` exits 70                                  |

The `.env`-creation branch was exercised by moving the real `.env` aside, running
the script, diffing the result against `.env.example`, and restoring the
original. The stub-node test used a shell script printing `v20.11.1` on a
scratch `PATH` entry, so no real toolchain was touched.

`pnpm typecheck`, `pnpm lint` and `pnpm test` all still pass.

## What went wrong

Nothing that survived to the diff. Worth recording that the `.env` test is the
one that could have destroyed something the repo cannot regenerate — a filled-in
`.env` is gitignored and holds the operator's keys — so it was run by moving the
file rather than by letting the script decide, and the restore was verified by
diffing against `.env.example` afterwards.

## Choices that were judgement, not transcription

- **The `cd "$(dirname "$0")"` in both scripts.** Makes `../investment-pipeline/pipeline`
  work from anywhere. Costs nothing; the alternative is a wrapper that only works
  from one directory.
- **The "pnpm already on PATH" branch.** The ticket said corepack with an `npm i -g`
  fallback. Two options where a third obviously-correct one exists is a spec gap,
  not an instruction to install a global package over a working one.
- **Step 4 does not prompt for the model names.** `.env.example` and STATE D-1
  both said `setup.sh` would prompt for `MODEL_EXTRACT` and `MODEL_ANALYSE`. It
  does not. A shell prompt that writes an API key into a file is more surface
  than the problem needs, and this project already spends its one interactive
  budget on stage 1's clarification step, which has rules attached (never
  without a TTY, never on replay). Step 4 names the four variables that need
  filling in and gets out of the way. `.env.example` was corrected to match the
  code rather than the code bent to match the comment, and the divergence is
  STATE.md inconsistency 7 — the author can have the prompt for a few lines if
  they want it.
- **No test file.** Testing `setup.sh` properly means running `pnpm install`,
  which is slow and not offline in the way `docs/TESTING.md` requires. Testing it
  improperly means grepping the script for strings, which pins the wording rather
  than the behaviour. The four acceptance runs above are the verification, and
  they are recorded here rather than automated. This is a real gap: a future edit
  to `setup.sh` will not be caught by `pnpm test`.

## Decisions taken

No open `STATE.md` decision was touched. D-2 and D-6 stay open.

## Attribution

`setup.sh`, `pipeline`, the `ARCHITECTURE.md` §7.1 paragraph and the factual
sections of this entry: AI-written end-to-end from one prompt, reviewed by me
before the commit. The three judgement calls above were the AI's and were
surfaced before commit.

## Reflection

The setup script ensures proper environment is present, installs dependencies and prepares .env file (and skips if .env exists). The runner script runs wraps the cli commands and abstracts out pnpm usage.

## Next

[TICKET-0005](../tickets/0005-ticket-zod-contracts.md) — the Zod contracts in
`src/contracts/`. Six schemas, `schema_version` on each, and the two parse
failures that are load-bearing: a `Fact` without `evidence_ids` and an `Analysis`
with a `call` outside the enum. STATE.md is right that these come before any
stage logic — a contract change after three stages exist is three refactors plus
a cache invalidation.
