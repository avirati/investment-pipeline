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

---

## `extract` v1 — 2026-08-22 (TICKET-0019)

**Why.** First version. This is stage 2b: the one narrowing-input step in the
pipeline and the only place model output touches the artifact chain
(ARCHITECTURE §1). It is handed the evidence bundle for one candidate and asked
for facts — `key`, `statement`, `value`, `evidence_ids`, `confidence` — and
nothing else.

**What it does.** States what a fact is (one observation, one sentence, tied to
the record it came from), shows the company, lists the evidence records with
their ids, lists the fact keys that have somewhere to go, and gives eight rules.
The rules that carry weight are 1 (cite, from the listed ids only), 2 (only what
these records say — *not* what the model knows about the company), 6 (omission is
how you say unknown) and 8 (no scoring, ranking or recommending).

**Three interpolations, no free text.** `{{company}}`, `{{keys}}` and
`{{evidence}}`. The bundle format is not described in prose and then produced
separately: `bundleItems(bundle)` in `src/analyse/gather.ts` is the shape, and
TICKET-0020 renders it into `{{evidence}}`. `{{keys}}` is filled from the
extraction schema's key vocabulary, for the same reason `{{thesis}}` is filled
from the rubric in `clarify-query` — one source of truth, and a prompt that
cannot drift from the schema it is asked to fill.

**The rubric is not in here, and that was checked by hand.** TICKET-0019 names
the failure mode explicitly: a prompt that restates the thesis turns the model
back into the scorer through the back door (CLAUDE.md invariant 7). The file was
read line by line against SPEC §1–2 looking for any of it. What is absent: the
thesis sentence and all three of its clauses, the five dimensions and their
names, every band and every threshold, the four disqualifiers, the coverage gate
and the three calls. What is *present* and deliberately so: neutral observation
prompts — who built it, what it does, who is using it, when things happened,
what the company owns — which is the "widening yes, narrowing no" half of
invariant 1. The model is told what to look at. It is never told what counts as
good.

`tests/prompt.test.ts` keeps a list of scoring vocabulary and fails if any of it
appears in the file. That is a tripwire, not the check — the check is reading it,
and the tripwire is what stops the next revision from undoing the reading.

**The line that is doing the most work is rule 2.** These are companies with a
public HN presence, and a model that has seen them can produce a fluent,
accurate-sounding fact with a citation attached to a record that does not support
it. That is worse than a wrong fact with no citation, because the citation is
what makes a reviewer stop checking. The rule says so in those terms rather than
saying "be accurate".

**Confidence is about the evidence, not the company.** Stated explicitly,
because `high`/`medium`/`low` invites the model to grade the *opportunity* if
nobody says otherwise, and that grade would then be a score arriving under
another name.

**Effect on the golden set.** Not measured — there is no golden set, and there
will not be one in v1 (see the header of this file). Stronger: this prompt has
never been sent to a provider. `tests/prompt.test.ts` renders it and asserts what
is in it; nothing yet asserts what a model does with it. The first real signal
will be TICKET-0020's fixtures, captured from a live call, and whatever they show
belongs in a v2 entry here.
