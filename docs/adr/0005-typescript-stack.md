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
our extraction is mostly structured, not prose. — *Amended 2026-08-22: the
readability half is cut. See the amendment below.*

**Bad.** The LLM tooling ecosystem is thinner than Python's. Sufficient for what
we need, which is one structured-output call per candidate.

**Neutral.** ESM plus TypeScript plus Node still has rough edges. `tsx` for
execution, `tsc --noEmit` for typechecking, no bundler.

## Amendment — 2026-08-22 · `@mozilla/readability` cut, `cheerio` alone

Closing **D-8**, raised in [worklog 0011](../worklog/0011-cached-fetch-layer.md)
while building the fetch layer. The original consequence above reads as two
small libraries. It is three: `@mozilla/readability` does not parse HTML, it
takes a DOM `Document`, so in Node it needs `jsdom` (or `linkedom`, or
`happy-dom`) underneath it. That would make the largest runtime dependency in
this project one added for article prose — in a pipeline whose own consequence
paragraph says *"our extraction is mostly structured, not prose"*.

So the mitigation is `cheerio` alone: strip `script/style/nav/footer/aside`,
read `<title>`, `og:` tags and the main content block. That covers what stage 2
actually reads — a team page, a meta description, repo metadata — and it is
worse on long-form article prose, which this pipeline barely reads.

**What this costs.** Article-heavy pages (a founder's long blog post, a launch
write-up) extract with more boilerplate than readability would leave. If facts
start arriving with navigation text attached, the fix is one library and a DOM,
and this paragraph is the record of what it would buy.

The decision is recorded and the extraction itself is not written yet — the
fetch layer shipped its transport half only. It lands with TICKET-0008's
remaining half.

## Revisit if

The pipeline grows a data-analysis stage (cohort statistics, temporal modelling),
where Python's ecosystem would decisively win.

Or: extraction quality on prose pages becomes the thing limiting fact coverage,
which is when the amendment above gets reversed.
