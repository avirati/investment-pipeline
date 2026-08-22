# Scope

Status: draft · Last updated: 2026-08-22

The brief says boundaries are deliberately loose and that scoping is part of what
is being evaluated. This document is the answer: what is in, what is out, and why.

---

## In scope

| # | Item | Standard |
|---|---|---|
| 1 | HN (Algolia) sourcing, done properly | Date-windowed, paginated, query-expanded, deduped by canonical domain |
| 2 | GitHub + company-site enrichment | Org stats, commit cadence, contributors, licence; team/about page extraction |
| 3 | Evidence store with resolvable citations | Every memo claim traceable to a URL and a timestamp |
| 4 | LLM fact extraction against a typed schema | Facts only — never scores, never prose for the memo |
| 5 | Deterministic rubric scoring | Recomputable by hand from the analysis JSON |
| 6 | One-page memos with a Pass / Watch / Take-a-meeting call | Skimmable in 60 seconds |
| 7 | Replay from committed artifacts | Re-render with zero API calls |
| 8 | Committed sample run | Reviewer never has to obtain an API key |
| 9 | Tests on the parts that can be wrong quietly | Scoring, citation validation, dedup, extraction parsing, missing-data paths. Offline, no API key. [TESTING.md](./TESTING.md) |
| 10 | Query planning — probe, then clarify | No LLM when the raw seed yields enough; a human decision when it doesn't. [ADR-0008](./adr/0008-query-planning.md) |
| 11 | `setup.sh` and a `./pipeline` wrapper | Idempotent, self-verifying against the committed sample run with no API key |
| 12 | `--help` on every command | Seed forms and worked examples where someone will actually see them |

---

## Out of scope, and why

**Additional sources — Product Hunt, Crunchbase, Twitter/X, LinkedIn.**
The brief names "a 12-source sourcing layer where each source returns 2 garbage
results" as an anti-pattern, and it is the correct warning. Product Hunt needs
OAuth for marginal additional signal; Crunchbase is paid; X's API is paid and its
free tier is unusable; LinkedIn is hostile to scraping and against its terms. Two
sources with real depth beats six with shallow coverage — and the thesis is
specifically about *developer* adoption, which is precisely what HN and GitHub
measure. The source interface is an adapter, so adding a third is a contained
change, but adding one is not the work.

**A database.** Under 20 records per run, written once, read once. JSONL and
files are queryable with `jq`, diffable in review, and committable so a reviewer
can read outputs without running anything. A database would take all three of
those properties away and give nothing back.

**Embeddings / RAG / a vector store.** The whole evidence bundle for one company
fits comfortably in a context window. Retrieval over 20 documents is a solution
to a problem this pipeline does not have.

**A job queue or scheduler.** A run is a single process, bounded, minutes long.
Concurrency is a bounded `Promise.all` over candidates, which is the entire
requirement.

**A web UI.** Explicitly ruled out by the brief. Memos are markdown, which reads
fine in a terminal, an editor, GitHub, or a Slack paste.

**Agentic browsing / a research agent loop.** Tempting and largely a trap here:
non-deterministic cost, non-reproducible outputs, and it breaks the citation
guarantee that the whole design rests on. Deterministic retrieval with one
constrained extraction call is more auditable and cheaper.

**Auth, multi-tenancy, deployment.** Internal tool, one operator, run locally.

**Fine-tuning.** Not remotely the constraint here.

**An eval harness — considered and cut.** A hand-labelled golden set, scored
before and after each rubric or prompt change, would be the direct evidence that
the rubric was tuned rather than guessed. It was designed and then dropped from
v1 on time grounds: the labelling has to be done by a human, independently, or
the eval measures the rubric against itself and proves nothing.

The cost of cutting it, stated plainly rather than buried: **the rubric bands in
[SPEC.md](./SPEC.md#2-the-rubric) are unvalidated against real companies, and
nothing in the test suite will catch it if they are wrong.** The likely symptom
is candidates clustering in the middle two bands of every dimension. In its place
`prompts/CHANGELOG.md` records why each prompt revision happened and what was
observed after it — weaker evidence, and labelled as weaker rather than dressed
up as equivalent. This is the first thing I would build in v2.

---

## Corners deliberately cut

These are compromises made knowingly, not oversights. They are listed so a
reviewer can judge the judgement.

1. **Founder identification is best-effort.** No people-data provider is free.
   We extract from team/about pages and GitHub profiles, and when we cannot,
   coverage drops and the memo says "founder background unverified". A wrong
   founder is worse than a missing one.
2. **Market sizing is a hint, not a model.** No TAM spreadsheet. The memo states
   a comparable, a directional size, and its source. Bottom-up sizing on public
   data alone would be a fabricated number wearing a suit.
3. **One thesis, hardcoded in one module.** The rubric is not configurable by
   YAML. A second thesis is a second scoring module — but the fund has one thesis
   today, and premature parameterisation would blur the thing being evaluated.
4. **English-language sources only.**
5. **No temporal tracking across runs.** Each run is a snapshot. "This company's
   stars grew since last month" would need a run history; the value is real but
   it is a second version's feature.

---

## Risks

| Risk | Mitigation |
|---|---|
| HN yields candidates that are projects, not companies | Filter on site resolution + company signals; explicitly reject and record why |
| The model asserts facts the evidence does not support | Facts require evidence ids; validator fails on unresolvable ids; spot-check a sample by hand and record it |
| Thesis is narrow enough that most candidates Pass | That is a correct outcome. The memo still has to justify each Pass. A run of mostly Passes with good reasoning is a working triage layer |
| Sourcing returns fewer than 10 candidates | Query expansion plus a widened date window, both recorded in the manifest so the reviewer sees the fallback fired |
| Query clarification drifts the run off-thesis | Human approves the query before any fetching; `query_plan.json` records the original seed alongside the chosen one, so drift is visible in a diff |
| Rate limits during a demo run | Committed sample run means the demo never depends on live APIs |
