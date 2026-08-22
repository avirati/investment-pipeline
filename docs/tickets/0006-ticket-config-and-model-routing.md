# TICKET-0006 — `src/config.ts`: env parsing and model routing

Status: **Done** — [worklog 0009](../worklog/0009-config-and-model-routing.md) · Depends on: 0001, 0005 · Blocks: 0018
Reads: [ADR-0006](../adr/0006-llm-provider-abstraction.md), [ARCHITECTURE §6, §8](../ARCHITECTURE.md)

## Why

Model choice is an env change, not a code change (ADR-0006). That only holds if
env parsing is one typed module rather than `process.env` reads scattered across
call sites.

## Scope

- Parse and validate env with Zod: `LLM_PROVIDER`, `MODEL_EXTRACT`,
  `MODEL_ANALYSE`, provider API key, `GITHUB_TOKEN` (optional).
- **Fail late, not at import.** No stage that runs offline may throw because a
  key is absent — `./pipeline memo` and `pnpm test` must work with an empty
  `.env`. Validate LLM config only at the point an LLM call is about to happen.
- `GITHUB_TOKEN` absent is a degraded mode, not an error (ADR-0004: generous
  unauthenticated limits). Say so in the run manifest.
- Missing config messages name the variable and point at `.env.example`.

## Acceptance

- Tests: valid env parses; missing `MODEL_EXTRACT` produces a message naming it;
  importing `config.ts` with a completely empty env does **not** throw.
- `pnpm test` passes with no `.env` present at all.
