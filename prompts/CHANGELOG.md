# Prompt changelog

Prompts live here as versioned files and are never edited inline in TypeScript
(CLAUDE.md). Every revision gets an entry below saying **why** it changed and
what it did to the golden set.

**There is no golden set.** The eval harness was cut from v1 — a deliberate
decision, recorded in [SCOPE.md](../docs/SCOPE.md) and
[TESTING.md](../docs/TESTING.md) — so the "what it did to the golden set" half of
every entry below reads *not measured*, and says so rather than implying an
evaluation nobody ran. Do not fix this by building evals; fix it by being honest
about what is and is not known.

**Versioning.** The version is in the filename (`clarify-query.v1.md`) and in the
file's front matter. A change to a prompt's text is a new version, because cache
keys include it and a stale response must never survive a change silently
(CLAUDE.md invariant 6). The wiring that puts the version into a cache key lands
with [TICKET-0018](../docs/tickets/0018-ticket-llm-provider-and-cache.md).

---

## `clarify-query` v1 — 2026-08-22 (TICKET-0011)

**Why.** First version. ADR-0008 puts one LLM call in stage 1: when a probe of
the raw seed returns too few usable hits, the model — having seen the thin
result set — proposes 3–4 rephrasings for a person to choose between. This is
the prompt for that call.

**What it does.** Explains that HN Algolia is lexical rather than semantic, shows
the seed, the two probe counts and a sample of what came back with the filter's
own rejection reasons, and asks for a JSON array of 3–4 alternative queries.

**The thesis is interpolated, not written here.** `{{thesis}}` is filled from the
rubric at call time. CLAUDE.md invariant 7 puts the thesis in exactly one place —
`src/analyse/score.ts` — and forbids restating it in a prompt as free text, while
ADR-0008 requires the clarifier to have seen it. A placeholder is what satisfies
both. The rubric does not exist yet (TICKET-0020/0021), which is one of the two
reasons this prompt is not yet wired.

**Filters are named and refused explicitly.** Tags, `points>`, date windows and
`search_by_date` are listed as things the model must not produce, and the prompt
says they would be discarded. That is belt and braces: `sanitiseOptions` in
`src/source/plan.ts` is what actually enforces it, and the model's output reaches
`query=` and nothing else regardless of what it writes. Saying so in the prompt
costs four lines and makes a compliant model produce usable proposals rather than
proposals that get thrown away.

**An empty array is a valid answer.** A model asked for four options will produce
four options. The analyst then has to read four worse queries, which is a real
cost, so "the seed is already the best phrasing" is given an explicit way to be
said.

**Effect on the golden set.** Not measured — see above. This prompt has never
been run against a live provider; the seam it plugs into
(`src/source/plan.ts`'s `Clarifier`) is tested with injected stubs only.
