# Architecture

Status: draft · Last updated: 2026-08-22

Three stages, file-based handoff, no shared mutable state. Each stage is a
function from one on-disk artifact to another with a Zod contract at the
boundary. A stage can be run alone, and any stage can be re-run from the
previous stage's output without re-running the ones before it.

---

## 1. Data flow

```
seed  (topic query | url list)
  │
  ▼
┌─ STAGE 1 · SOURCE ────────────────────────────────────────────┐
│  a. plan     probe raw seed against HN          no LLM        │
│              ├ usable hits ≥ min-hits ──► pass through        │
│              └ below threshold ──► LLM proposes refinements,  │
│                     user picks / keeps original / types own   │
│              ──► runs/<run_id>/query_plan.json                │
│              interactive at most once; never on replay        │
│                                                                │
│  b. fetch    HN Algolia ──► resolve site ──► dedup            │
│                                                                │
│  out: runs/<run_id>/candidates.jsonl                          │
│       { name, url, one_liner, provenance[{source,query,at}] } │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ STAGE 2 · ANALYSE ───────────────────────────────────────────┐
│  a. gather   company site + GitHub org + HN thread            │
│              ──► runs/<run_id>/evidence/<sha256>.json         │
│              deterministic, cached, no LLM                    │
│                                                                │
│  b. extract  LLM(evidence bundle) ──► facts + evidence_ids[]   │
│              structured output against a Zod schema           │
│                                                                │
│  c. score    rubric(facts) ──► dimensions, total, coverage    │
│              pure function, no LLM                            │
│                                                                │
│  out: runs/<run_id>/analyses/<slug>.json                      │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ STAGE 3 · MEMO ──────────────────────────────────────────────┐
│  render(analysis) ──► markdown     no LLM in this stage       │
│  validate(memo)   ──► every citation resolves, or fail        │
│                                                                │
│  out: memos/<run_id>/<slug>.md                                │
└────────────────────────────────────────────────────────────────┘
```

### Where the LLM is allowed

> The LLM is permitted at **widening** boundaries — deciding what to look at. It
> is forbidden at **narrowing** boundaries — deciding what to conclude.

Two places, and only two:

| Step | Boundary | What it produces |
|---|---|---|
| **1a** query planning | widening | search terms, when the probe yields too little |
| **2b** fact extraction | narrowing input, constrained output | facts, each bound to an evidence id |

Everything else is retrieval, arithmetic, or templating. Scores, calls, and memo
prose are never model output. A wrong widening costs a wasted fetch and is
visible in `query_plan.json`; a wrong narrowing puts an indefensible number in
front of a partner. See [ADR-0008](./adr/0008-query-planning.md).

---

## 2. Stage contracts

Contracts live in `src/contracts/` as Zod schemas and are the only thing stages
know about each other. Each carries a `schema_version`; a version bump
invalidates the caches downstream of it.

```ts
QueryPlan   { original_seed, probe{hits,usable}, clarified,
              options_offered[], chosen, chosen_by }
Candidate   { slug, name, url, one_liner, provenance[] }
Evidence    { id, url, type, retrieved_at, status, title, text, meta }
Fact        { key, statement, value, evidence_ids: string[], confidence }
Analysis    { candidate, facts, dimensions[], score, coverage,
              disqualifiers[], call, unknowns[],
              status, status_reason, inputs{} }
Memo        { markdown, citations[] }
```

`Evidence.id` is `sha256(url + retrieved_at)` truncated — content-addressed, so
the same fetch is never stored twice and a citation is a stable pointer.

`Candidate.provenance` is a non-empty list, **primary first**, at
`schema_version` 2. Dedup produces a group rather than a post (§1b): two posts
about one company collapse to one candidate, and the singular field v1 shipped
could record only one of them. The primary is the group's strongest post — the
one whose link is the candidate's `url` — so the order is load-bearing and not
presentational.

`Analysis.status` and `Analysis.inputs` are at `schema_version` 2, added at
TICKET-0022. v1 could not tell a candidate the model *failed to answer about*
from one there was *nothing to find about*: both reach stage 3 as zero facts,
scoring at the unknown floors with no coverage. Stage 3 has no LLM and may not
guess (invariant 3), so the difference is written down by the stage that saw
it — `inputs` carries the counts, `status_reason` the sentence a memo prints.
It is not a second copy of the manifest: a memo for one company must be
renderable from that company's analysis alone (§1).

`Fact.key` is a stable identifier — `founder.prior_exit`, `github.stars` — and is
what the rubric switches on. It was added at TICKET-0005: this section previously
listed `statement` and `value` only, which left `src/analyse/score.ts` with prose
as its only handle on which fact it was looking at. Scoring is meant to be a pure
function over typed facts (ADR-0002), and pattern-matching English is not that.
The key *vocabulary* is deliberately not enumerated in the contract — it belongs
to the extraction schema and the rubric, and it is unvalidated until real
candidates exist.

Two conventions hold across all six contracts. `schema_version` is a required
literal written into the artifact, so an artifact from a different version fails
to parse rather than being silently reinterpreted. And fields we have no value
for are `null`, never omitted — unknown is written as unknown, and a gap should
be visible in a diff.

---

## 3. Evidence store and citations

Every retrieval writes one JSON record. Records are committed to the repo.

```
runs/<run_id>/evidence/
  a3f91c2e.json   { url, type: "github_repo", retrieved_at, text, meta }
  7b1d40aa.json   { url, type: "company_site", ... }
```

The extraction prompt is given a bundle of evidence records **with their ids**,
and is required to attach ids to every fact it emits. Facts without ids are
dropped at parse time, not argued with. The memo validator then re-checks that
every id in a rendered memo resolves to a file on disk, and fails the run if not.

This closes the hallucination loop cheaply: the model can still be wrong about
what a source *says*, but it cannot invent a source, and a reviewer can open the
record and check.

---

## 4. Replay

Everything needed to reproduce a run is committed:

```
runs/<run_id>/
  manifest.json      seed, git sha, provider+models, prompt versions,
                     counts, timings, cost, per-candidate status
  query_plan.json    the seed as approved, and how it was approved
  candidates.jsonl
  evidence/*.json
  analyses/*.json
.cache/llm/<hash>.json   keyed on sha256 over provider, model, prompt id,
                         prompt version, output schema version and the
                         rendered input (src/llm/cache.ts)
```

- `pipeline memo --run <id>` re-renders memos from committed analyses. Zero API
  calls, zero network.
- `pipeline run --seed ... --replay` reuses the LLM cache, so re-running after a
  template or rubric change costs nothing.
- A prompt or schema version bump changes the cache key, so stale responses can
  never silently survive a change. That is the point of versioning them.

The manifest records the git sha of the code that produced the run, so an output
in the repo can always be tied to the code that made it.

---

## 5. Failure policy

Failures are per-candidate and never abort a run.

| Failure | Behaviour |
|---|---|
| Probe request fails | Fall back to the raw seed, record `chosen_by: "probe_failed"`. Planning is an optimisation, never a blocker |
| Clarification LLM call fails | Same — raw seed, recorded. Never blocks a run on a nice-to-have |
| Source API 429/5xx | Retry with backoff, bounded. Then fail the run — no candidates means no pipeline |
| One candidate's site unreachable | Record the failure as evidence of type `fetch_failed`, continue. Coverage drops |
| No GitHub org found | Not an error. D1/D3 lose a signal, coverage drops, memo says so |
| LLM returns invalid structure | Retry once with the parse error appended. Then mark the candidate `partial` and continue |
| Memo cites an unknown evidence id | **Hard fail.** This is a correctness bug, not a data gap |

The distinction that matters: *missing data* degrades coverage and is reported;
*broken invariants* stop the build.

---

## 6. Repository layout

```
src/
  cli.ts                 commander entry — source | analyse | memo | run
  config.ts              env parsing, model routing
  run.ts                 run ids, run directory, artifact paths
  manifest.ts            the run record all three stages append to
  contracts/             Zod schemas — the stage boundary
  source/
    plan.ts              probe + clarification → query_plan.json
    hn.ts                HN Algolia adapter
    resolve.ts           post URL → company site, canonicalise, dedup
    candidate.ts         resolved site → Candidate; the urls seed form
    index.ts             stage 1 wired: plan, search, rank, cut, resolve
  evidence/
    store.ts             content-addressed read/write
    fetch.ts             cached HTTP + cheerio extraction
    github.ts            GitHub adapter
    site.ts              company site adapter
  analyse/
    extract.ts           LLM → facts (structured output)
    score.ts             pure rubric — the only place scores are produced
    index.ts
  memo/
    render.ts
    validate.ts
  llm/
    provider.ts          LangChain factory: openai | anthropic | ...
    cache.ts             file-backed response cache
prompts/                 versioned templates + CHANGELOG.md
templates/               memo.md.eta
tests/fixtures/          captured API responses — the suite runs offline
setup.sh                 idempotent one-time setup
pipeline                 wrapper script — ./pipeline <command>
runs/<run_id>/           committed run artifacts
memos/<run_id>/          committed outputs
docs/                    spec, architecture, ADRs, worklogs
```

---

## 7. CLI

Written before the code, so the contract was pinned rather than discovered. The
blocks below are the real output of `src/cli.ts`, pasted verbatim — TICKET-0003
replaced the hand-written sketch with what the program actually prints, so this
section can no longer drift silently. `tests/cli.test.ts` asserts the parts that
are contract rather than formatting.

```
$ ./pipeline --help

investment-pipeline — startup triage

Usage: pipeline <command> [options]

Options:
  -h, --help         show this

Commands:
  run [options]      Source, analyse and write memos in one pass
  source [options]   Stage 1 only — plan the query and find candidates
  analyse [options]  Stage 2 only — gather evidence, extract facts, score
  memo [options]     Stage 3 only — render memos (no network, no API calls)

Seed forms:
  --seed "AI agents for SMBs"     topic query
  --seed ./urls.txt               one URL per line

Examples:
  ./pipeline run  --seed "LLM observability" --limit 15
  ./pipeline run  --seed "AI agents" --no-expand
  ./pipeline memo --run 2026-08-22-llm-observability

Exit codes:
  0   success
  1   usage or configuration error
  2   data gap — the run completed but found too little to act on
  3   invariant violation — a contract or citation check failed (ADR-0003)
  70  not implemented yet — a stage this build does not have

Run './pipeline <command> --help' for command options.
```

```
$ ./pipeline run --help

Usage: pipeline run [options]

Source, analyse and write memos in one pass

Options:
  --seed <input>       topic query or URL list path — required
  --limit <n>          max candidates to carry forward (default: 15)
  --min-hits <n>       probe yield below which clarification is offered
                       (default: 8)
  --query-plan <file>  use a hand-written plan; skips planning
  --no-expand          use the raw seed verbatim; skips planning
  --since <days>       source window (default: 180)
  --run <id>           explicit run id (default: date-slug)
  --replay             reuse cached LLM responses; spends nothing
  -h, --help           show this
```

`source` takes the same sourcing options as `run`; `analyse` takes `--run` and
`--replay`; `memo` takes `--run` alone, because stage 3 makes no LLM calls and
so has nothing to replay.

Sub-commands exist so the stage separation is visible from outside, not just in
the source tree. `run` exists so a partner types one thing.

## 7.1 Setup and the wrapper script

`./setup.sh` — idempotent, safe to re-run, and it verifies itself:

```
1. check node >= 22          → names the version found if it fails
2. corepack enable pnpm      → falls back to npm i -g pnpm
3. pnpm install --frozen-lockfile
4. create .env from .env.example if absent   ← never overwrites an existing .env
5. pnpm typecheck
6. ./pipeline memo --run <committed_sample>  ← offline verification
```

Step 6 is the point. It re-renders the committed sample run with no network and
no API key, so a fresh clone proves the whole toolchain works *before* the
operator has obtained a single credential. "Did the install work?" becomes an
assertion rather than a hope.

**Steps 1–5 exist as of TICKET-0004. Step 6 does not yet** — `memo` exits 70
until TICKET-0026 and there is no sample run to re-render until TICKET-0028, so
shipping the step now would mean shipping a check that always fails. The script
ends with a `TODO(0028)` naming it, and prints a line saying the verification is
not wired up, so the gap is visible to whoever runs it rather than only to
whoever reads this file.

`./pipeline` is a thin wrapper (`exec pnpm exec tsx src/cli.ts "$@"`) so nobody
needs to know pnpm exists to run this. It stays a wrapper — not a task runner.

## 8. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22, TypeScript, ESM | [ADR-0005](./adr/0005-typescript-stack.md) |
| CLI | `commander` | Boring, mature |
| Contracts | `zod` | Doubles as LLM structured-output schema |
| HTTP | native `fetch` + `p-retry` | No client dependency needed |
| HTML → text | `cheerio` | Targeted extraction. `@mozilla/readability` was cut — it needs a DOM, so it is really three dependencies ([ADR-0005 amendment](./adr/0005-typescript-stack.md)) |
| LLM | `@langchain/core` + provider adapters | [ADR-0006](./adr/0006-llm-provider-abstraction.md) |
| Templating | `eta` | A memo template a partner can edit without reading TypeScript |
| Tests | `vitest` + committed fixtures | Runs offline, no API keys. [TESTING.md](./TESTING.md) |
| Interactive prompt | `@clack/prompts` | Only dependency added for query clarification |
| Lint/format | `biome` | One tool |

No database, no queue, no vector store, no server, no frontend. See
[SCOPE.md](./SCOPE.md).
