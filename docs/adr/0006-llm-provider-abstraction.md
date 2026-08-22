# ADR-0006 — LangChain as a provider seam

Status: Accepted · 2026-08-22

## Context

The pipeline makes one kind of LLM call: evidence bundle in, typed facts out.
Model choice should not be a rewrite — an internal tool at a fund will change
models as pricing and capability move, and a reviewer may only have keys for one
provider.

## Options

1. **Call the provider SDK directly.** Fewest layers. Rebinding to another
   provider means rewriting the call sites and re-solving structured output.
2. **Hand-rolled adapter interface.** Total control, but structured output,
   retries, and token accounting all get reimplemented per provider.
3. **`@langchain/core` + provider packages.** `withStructuredOutput(zodSchema)`
   is uniform across providers, and the Zod schema from ADR-0005 is passed
   straight in.

## Decision

`@langchain/core` with `@langchain/openai` as the default adapter, behind a
factory in `src/llm/provider.ts`:

```ts
createModel(role: "extract" | "analyse")   // env-driven
LLM_PROVIDER=openai            # openai | anthropic | ollama
MODEL_EXTRACT=...              # cheap, mechanical
MODEL_ANALYSE=...              # judgement-heavy
```

Swapping providers is an env change. Adding one is a package install and a case
in the factory.

## Consequences

**Good.** `withStructuredOutput` plus Zod removes the entire retry-and-reparse
layer we would otherwise own. Role-based model routing lets mechanical extraction
run on a cheap model and judgement run on a stronger one, tuned without touching
call sites. A reviewer with any supported provider's key can run the pipeline.

**Bad.** LangChain is a heavy dependency for one call type, and its abstractions
leak — provider-specific behaviour around structured output differs in ways the
interface does not fully hide. We are using a narrow slice of it and should be
honest that a hand-rolled adapter would be ~150 lines. The slice is narrow enough
to replace if it becomes a liability.

**Bad.** Version churn in the LangChain ecosystem is real. Pinned exact versions.

**Deliberate.** No LangChain chains, agents, memory, or retrievers. Only the
model wrapper and structured output. Everything else — caching, prompting,
orchestration — is ours, because those are exactly the parts that must stay
inspectable for the citation and replay guarantees to hold.

**Caching is ours, not LangChain's.** Its caches are in-memory or
Redis/SQLite-backed. We need a committed, human-readable, content-addressed cache
so replay works from a fresh clone with no services running. See
[ADR-0001](./0001-file-based-staged-pipeline.md).

## Revisit if

The dependency's churn costs more than the ~150 lines it saves, or the pipeline
settles permanently on one provider.

---

## Amendment — 2026-08-22 · the packages, pinned, and where the seam leaked

Recorded in [TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md), the
first code behind this ADR. CLAUDE.md wants a line in an ADR for every runtime
dependency; these are the three, at exact versions:

| Package | Version | Why |
|---|---|---|
| `@langchain/core` | 1.2.9 | `withStructuredOutput`, the message and runnable types |
| `@langchain/openai` | 1.5.10 | `LLM_PROVIDER=openai`, the default adapter |
| `@langchain/anthropic` | 1.5.8 | `LLM_PROVIDER=anthropic`, the second provider `.env.example` and `LLM_PROVIDERS` already name |

Exact, not caret: the "version churn is real" line above is the reason, and a
range would let a minor bump change structured-output behaviour under a cache
whose keys do not include a library version. `ollama` still has no adapter and
the sketch line above stays aspirational (STATE inconsistency 10).

**Both are loaded behind `await import`**, not at module top level, so the
offline paths — `memo`, a replay, the whole test suite — never load a provider
SDK they will not call.

**Two places the abstraction leaked**, both predicted by the "leak" paragraph
above and both worth naming rather than discovering twice:

1. `usage_metadata` is typed off a message-structure generic and resolves to
   `never` on the `BaseMessage` a runnable returns, so token counts are read
   through one narrow structural type in `src/llm/provider.ts`.
2. `withStructuredOutput` requires an **object** schema (`RunOutput extends
   Record<string, any>`). A prompt whose natural answer is a bare JSON array —
   `prompts/clarify-query.v1.md` is one — needs a wrapper object, and therefore
   a prompt revision to match. Handed to TICKET-0011's clarifier wiring rather
   than papered over here.
