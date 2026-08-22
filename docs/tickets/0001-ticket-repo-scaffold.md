# TICKET-0001 — Repo scaffold and toolchain

Status: **Done** — [worklog 0004](../worklog/0004-repo-scaffold.md) · Depends on: — · Blocks: everything
Reads: [ARCHITECTURE §6, §8](../ARCHITECTURE.md), [ADR-0005](../adr/0005-typescript-stack.md), [STATE](../STATE.md) next-step 1

## Why

Nothing is installed and there is no `package.json`. Every other ticket assumes a
working toolchain. This one exists so "runnable" is true from the first code
commit rather than eventually.

## Scope

- `package.json` — ESM (`"type": "module"`), `engines.node >= 22`,
  `packageManager: pnpm@…`. Scripts: `test`, `typecheck`, `lint`, `format`.
- `tsconfig.json` — `strict`, `NodeNext`, `noEmit`. No bundler (ADR-0005).
- `biome.json`, `vitest.config.ts`.
- Toolchain + always-needed deps only: `typescript`, `tsx`, `vitest`, `biome`,
  `zod`, `commander`. Everything else in ARCHITECTURE §8 lands with the ticket
  that first uses it, so the lockfile shows when each dependency was actually
  earned.
- `.env.example` — resolves **D-1** by taking its documented default: values left
  empty, with comments naming the two roles (`MODEL_EXTRACT` cheap/mechanical,
  `MODEL_ANALYSE` judgement-heavy) and `LLM_PROVIDER`. Also fixes known
  inconsistency #2 in STATE.
- Pin exact versions for the LangChain packages when they arrive (ADR-0006), but
  nothing LangChain lands here.

## Out of scope

`setup.sh`, `./pipeline`, any `src/` module. Separate tickets.

## Acceptance

- `pnpm install` succeeds on a fresh clone.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0 (test with
  `--passWithNoTests` until TICKET-0009 lands the first suite).
- `.env` is gitignored; `.env.example` is committed and contains no secret.

## Decisions taken

**D-1** — default taken as written in STATE. Record it in the session worklog.
