# TICKET-0018 — LLM provider seam and response cache

Status: Open · Depends on: 0006 · Blocks: 0011 (clarifier call), 0020
Reads: [ADR-0006](../adr/0006-llm-provider-abstraction.md), [ARCHITECTURE §4](../ARCHITECTURE.md#4-replay)

## Why

Two properties depend on this pair: swapping providers is an env change, and
replay costs nothing. Both are load-bearing for a reviewer who has a key for a
different provider than the author, or no key at all.

## Scope

- `src/llm/provider.ts` — `createModel(role: "extract" | "analyse")`,
  `@langchain/core` + `@langchain/openai`, factory switching on `LLM_PROVIDER`.
  **Pin exact versions** (ADR-0006 names LangChain churn as the known risk).
- Only the model wrapper and `withStructuredOutput`. **No chains, agents, memory,
  or retrievers** — ADR-0006 is deliberate about this and it is the reason the
  dependency is acceptable at all.
- `src/llm/cache.ts` — file-backed, committed, human-readable, content-addressed:
  `.cache/llm/<sha256(provider|model|prompt_version|input)>.json`.
- The cache key **must** include prompt version and schema version, so a bump can
  never let a stale response survive silently (CLAUDE.md invariant 6).
- `--replay` reads the cache and makes no network call.
- Record token counts and cost per call for the manifest.

## Acceptance

- Tests offline with a stub model: a second identical call hits the cache; a
  prompt-version bump misses it; `--replay` with a cold cache fails loudly rather
  than silently calling the API.
- The cache file is readable JSON a human can open and diff.
