# TICKET-0004 — `setup.sh` and the `./pipeline` wrapper

Status: **Done** — [worklog 0007](../worklog/0007-setup-script-and-wrapper.md) · Depends on: 0003 · Blocks: 0028
Reads: [ARCHITECTURE §7.1](../ARCHITECTURE.md#71-setup-and-the-wrapper-script), [SCOPE](../SCOPE.md) in-scope #11

## Why

A reviewer should not need to know `pnpm` exists. `setup.sh` is the difference
between "clone and run" and "clone, read, install, guess".

## Scope

- `./pipeline` — `exec pnpm exec tsx src/cli.ts "$@"`. A wrapper, not a task
  runner (CLAUDE.md). Executable bit committed.
- `./setup.sh` — steps 1–5 of ARCHITECTURE §7.1: node version check that *names
  the version it found* on failure, `corepack enable pnpm` with an
  `npm i -g pnpm` fallback, `pnpm install --frozen-lockfile`, `.env` from
  `.env.example` **only if absent**, `pnpm typecheck`.
- Idempotent and safe to re-run. Never overwrites an existing `.env`.
- `set -euo pipefail`; each step prints what it is doing and what it found.

## Out of scope

**Step 6** — the offline self-verification (`./pipeline memo --run <sample>`).
It cannot exist until a sample run is committed. It lands in TICKET-0028, and
that ticket is what closes the SCOPE #11 promise. Leave a `TODO(0028)` comment at
the end of the script naming it, so the gap is visible rather than forgotten.

## Acceptance

- `./setup.sh` on a fresh clone exits 0.
- `./setup.sh` run a second time exits 0 and reports `.env` already present.
- `./setup.sh` on Node < 22 fails with a message naming the version found.
- `./pipeline --help` works from a shell that has never heard of pnpm.
