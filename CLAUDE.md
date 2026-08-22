# CLAUDE.md

Operating guide for AI assistants working in this repo.

**Starting a new session? Read [docs/STATE.md](docs/STATE.md) first** — it holds
current phase, open decisions with a safe default for each, known inconsistencies,
and the next concrete step. Then read [docs/SPEC.md](docs/SPEC.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything in `src/`.

## What this is

An internal triage pipeline for a seed-stage VC firm. Sources startups from
Hacker News, enriches from GitHub and company sites, scores them against one
fixed thesis, and emits a one-page memo per company ending in
Pass / Watch / Take a meeting.

Three stages, file-based handoff: `source → analyse → memo`.

## Invariants

Violating any of these is a bug, not a style disagreement.

1. **Widening yes, narrowing no.** The LLM may decide *what to look at* (query
   planning, 1a). It may never decide *what to conclude*. Scores, calls, and memo
   prose are never model output — `src/analyse/score.ts` is the only place a
   score comes into existence. (ADR-0002, ADR-0008)
2. **Every fact carries `evidence_ids`.** Facts without them are dropped at parse
   time. The model may only cite ids present in the bundle it was given. (ADR-0003)
3. **Stage 3 contains no LLM calls.** Memos are rendered from the analysis JSON.
   If a memo needs prose the analysis does not have, fix stage 2.
4. **Missing data lowers coverage; it never becomes a zero or a guess.** Unknown
   is written as "unknown". (SPEC §3)
5. **Stages communicate only through files and Zod contracts.** No stage imports
   another stage's internals.
6. **A prompt or schema change bumps its version.** Cache keys include it;
   stale responses must never survive a change silently.
7. **The thesis lives in exactly one place** — the rubric in `src/analyse/score.ts`,
   specified in SPEC §1–2. Do not restate it in prompts as free text.

## Commands

```bash
./setup.sh                                       # idempotent; self-verifies offline

./pipeline run     --seed "<topic>" --limit 15   # all three stages
./pipeline source  --seed "<topic>"
./pipeline analyse --run <run_id>
./pipeline memo    --run <run_id>                # no network, no API calls
./pipeline --help                                # -h works on every command

pnpm test          # vitest, offline, committed fixtures
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome
```

**Never add a test that requires a network call or an API key.** The suite must
pass on a fresh clone with nothing configured. See [docs/TESTING.md](docs/TESTING.md).

Stage 1 may prompt once for query clarification when the probe yields too little.
It must never prompt without a TTY, and never on replay.

## Conventions

- TypeScript, ESM, Node 22. `pnpm` only.
- Zod schemas in `src/contracts/` are the stage boundary. Change one, bump its
  `schema_version`, and check what it invalidates downstream.
- Prompts live in `prompts/` as versioned files with a `CHANGELOG.md` entry per
  revision, saying **why** it changed and what it did to the golden set. Prompts
  are not edited inline in TypeScript.
- Fetching goes through `src/evidence/fetch.ts` so everything is cached and
  recorded. Never call `fetch` directly from a stage.
- No new runtime dependency without a line in the relevant ADR justifying it.
- `setup.sh` is a setup script, not a task runner. `./pipeline` is a wrapper, not
  a framework. Resist both.
- There is no eval harness in v1 — this was a deliberate cut, recorded in
  [docs/SCOPE.md](docs/SCOPE.md). Do not quietly reintroduce one; do not claim
  the rubric is validated. It is not.

## Working rules for AI assistants

- **Ask before scoping up.** This project is graded partly on cutting the right
  corners. Suggest the smaller version first; check [docs/SCOPE.md](docs/SCOPE.md)
  before proposing anything on the out-of-scope list.
- **Commits are atomic and small.** One logical change per commit. Do not mix a
  refactor with a feature. Do not commit without the author's review.
- **Leave a trail.** A session that made a real decision gets a worklog entry in
  `docs/worklog/`. A decision that was hard or reversible-at-cost gets an ADR.
- **Update `docs/STATE.md` at the end of every session.** It is the handoff, and
  it is the one document allowed to go stale. If you took a documented default
  for an open decision, say so there and in the worklog.
- **Prefer a stated assumption to a blocked session.** Every open decision in
  STATE.md has a default. Take it, record it, keep moving.
- **Do not write the reflective sections of worklogs.** Fill in the factual
  record — what was attempted, what failed, what changed. The judgement and
  reflection paragraphs are the author's, and ghostwritten reflection is both
  obvious and explicitly penalised by the brief. Leave them marked `TODO(author)`.
- **Attribution is honest.** If a module was written end-to-end by an assistant,
  the worklog says so. That is not penalised here; hiding it is.
