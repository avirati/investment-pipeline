# ADR-0005 — TypeScript / Node stack

Status: Accepted · 2026-08-22

## Context

Stack is free choice. The work is IO-bound retrieval, schema-constrained LLM
calls, and markdown rendering. The code-quality weight is 10%, so the stack
should make correctness cheap rather than showcase anything.

## Options

1. **Python + Pydantic.** The default for data pipelines. Best-in-class HTML
   extraction (`trafilatura`). Strong LLM ecosystem.
2. **TypeScript + Zod on Node 22.** One schema definition serves as the stage
   contract, the LLM structured-output schema, and the runtime validator.

## Decision

TypeScript on Node 22, ESM, `pnpm`.

The deciding factor is Zod's triple duty. In Python the same three jobs need
Pydantic models plus a separate JSON-schema export step; in TypeScript one Zod
object is the contract at the stage boundary, the schema handed to the model, and
the parser that rejects malformed output — with the static type flowing through
every stage for free. For a system whose central property is *typed artifacts
crossing stage boundaries*, that is the ergonomics that matter.

## Consequences

**Good.** One schema, no drift between contract and validator. `z.infer` types
the whole pipeline off the same source. `vitest` is fast enough to run on save.
`biome` replaces the eslint+prettier pair.

**Bad.** HTML-to-text extraction is weaker than `trafilatura`. Mitigated with
`cheerio` for targeted extraction (which is what we mostly want — team pages,
meta tags, repo metadata) and `@mozilla/readability` for article text. Accepted:
our extraction is mostly structured, not prose.

**Bad.** The LLM tooling ecosystem is thinner than Python's. Sufficient for what
we need, which is one structured-output call per candidate.

**Neutral.** ESM plus TypeScript plus Node still has rough edges. `tsx` for
execution, `tsc --noEmit` for typechecking, no bundler.

## Revisit if

The pipeline grows a data-analysis stage (cohort statistics, temporal modelling),
where Python's ecosystem would decisively win.
