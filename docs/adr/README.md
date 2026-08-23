# Architecture Decision Records

One file per decision that was hard to make or would be expensive to reverse.
Format is MADR-lite: Context → Options → Decision → Consequences → Revisit if.

A decision belongs here if a reasonable engineer would have chosen differently,
or if I would have chosen differently a week earlier. Decisions with one obvious
answer are not recorded — that would be padding.

| # | Decision | Status |
|---|---|---|
| [0001](./0001-file-based-staged-pipeline.md) | File-based staged pipeline with content-addressed artifacts | Accepted |
| [0002](./0002-deterministic-scoring.md) | Deterministic scoring over LLM-extracted facts | Accepted |
| [0003](./0003-evidence-store-and-citations.md) | Evidence store and the citation contract | Accepted |
| [0004](./0004-source-selection.md) | Source selection: Hacker News + GitHub | Accepted |
| [0005](./0005-typescript-stack.md) | TypeScript / Node stack | Accepted · amended 2026-08-22 (D-8: `@mozilla/readability` cut) |
| [0006](./0006-llm-provider-abstraction.md) | LangChain as a provider seam | Accepted |
| [0007](./0007-thesis-selection.md) | Investment thesis as an executable rubric | Accepted |
| [0008](./0008-query-planning.md) | Query planning: probe, then clarify | Accepted |
| [0009](./0009-bundles-as-artifacts.md) | The evidence bundle is an artifact, and a replay reads it | Accepted |
