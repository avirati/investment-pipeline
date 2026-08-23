# Testing

Status: draft · Last updated: 2026-08-22

Principle: **test what fails silently.** A crash announces itself. An off-by-one
on a rubric band edge quietly changes a partner's call and nobody ever finds out.
Coverage percentage is not a goal here; the list below is.

Every test runs offline. No test makes a network call or needs an API key — a
reviewer clones and runs `pnpm test` with nothing configured.

---

## What is tested

### 1. Scoring — `src/analyse/score.ts`

The highest-value target in the repo. A pure function, table-driven tests.

- **Band boundaries.** For each of the five dimensions, a fact set that lands
  exactly on each band edge and one either side. This is where silent
  miscalculation lives.
- **Disqualifier precedence.** A candidate scoring 90 with D-2 present must
  return `PASS`. Tested for each of the four disqualifiers independently.
- **Coverage arithmetic.** Dimensions with no evidence score at the band floor
  and reduce coverage — never zero, never omitted.
- **The coverage gate.** Score ≥ 72 with coverage 40% must cap at `WATCH`.
- **Total is the sum of its parts.** Property-style check that
  `total === sum(dimensions)` across generated fact sets.

### 2. Citation validation — `src/memo/validate.ts`

Test the **failure** path, which is the one that matters:

- A memo citing an evidence id with no file behind it aborts the run.
- A fact arriving from the model without `evidence_ids` is dropped at parse time,
  not rendered.
- A valid memo passes and every citation resolves to a readable record.

### 3. URL canonicalisation and dedup — `src/source/resolve.ts`

Classic quiet-bug territory. `www.` prefixes, trailing slashes, `http`→`https`,
`utm_*` and ref params, subdomain vs apex, trailing `index.html`. Two HN posts
about the same company must collapse to one candidate.

### 4. Source parsing — `src/source/hn.ts`

Against committed Algolia fixtures: pagination, empty result sets, posts with
null URLs (Ask HN), malformed timestamps, and the usable-vs-unusable
classification the probe threshold depends on.

### 5. Query planning — `src/source/plan.ts`

- Probe above threshold → passes through with **zero LLM calls** (asserted via a
  stub that fails the test if invoked).
- Probe below threshold, no TTY → raw seed, `chosen_by: "non-interactive"`.
- `--query-plan` and `--no-expand` both bypass planning entirely.
- A committed `query_plan.json` is never regenerated on replay.

### 6. Missing-data paths

The "robust to bad or missing data" requirement, tested as behaviour rather than
asserted in prose. Each of these must produce a valid memo with reduced coverage
and an explicit entry in `unknowns[]` — never a crash, never a fabricated value:

- No GitHub org found
- Company site returns 404, times out, or serves an empty shell
- Zero founders identifiable
- HN thread with no comments
- Model returns valid JSON with every optional field null

### 7. Memo rendering — snapshot

One golden analysis JSON → one golden memo. Catches template regressions for
free and makes memo changes visible in review as a diff.

**Shipped in TICKET-0024, as two rather than one.** `tests/golden/` holds a
Watch three points short of a meeting and a Pass forced by two disqualifiers —
the second exists because the first renders no Risks section and no "could not
verify" section, and a snapshot that never exercises them is a snapshot of half
the template. Both analyses are the output of the real rubric and derivation
over hand-written facts, so they are analyses this pipeline could emit.
`pnpm golden` regenerates the memos; `pnpm golden --check` fails when they are
stale. See `tests/golden/README.md`.

---

## What is not tested

LangChain, the HTTP client, the network, and the model's judgement. Testing a
dependency's behaviour tests the dependency. Extraction quality is a judgement
question, and this version does not attempt to measure it — see below.

---

## Fixtures

`tests/fixtures/` holds real captured responses: Algolia result pages, GitHub org
and repo payloads, a handful of company home and team pages, and both well-formed
and deliberately malformed model outputs.

Captured once by `pnpm capture-fixtures`, run manually and rarely — never in CI.
Fixtures are committed. They are what makes the suite offline, and they double as
a record of what the external APIs actually returned on the day the code was
written.

A bare run writes only what is missing; re-capturing an existing fixture is
`--refresh` and is a deliberate act, because a relevance-ranked API returns
different hits from one month to the next and the suite asserts on these files.
`tests/fixtures/capture.json` records the url, status, date, size and digest of
every file, and two tests run on every `pnpm test`: every fixture is re-scanned
for credential-shaped content, and every fixture must match its recorded digest —
so a hand-edited one fails the suite.

The model outputs are **authored**, not captured: the interesting shapes are the
ones a model produces on a bad day. Their defect tables live in
`scripts/fixtures.ts` and `tests/model-fixtures.test.ts` asserts each row against
the `Fact` contract. See [`tests/fixtures/README.md`](../tests/fixtures/README.md).

---

## Evals: deliberately out of scope for v1

Tests check **correctness**. Evals would check **judgement** — a hand-labelled
golden set of companies, scored before and after each rubric or prompt change, to
show the rubric was tuned rather than guessed.

That is not built in v1. It was considered and cut. The honest cost of cutting
it: **the rubric bands in [SPEC.md](./SPEC.md#2-the-rubric) are unvalidated
against real companies.** If they are wrong, the likely symptom is candidates
clustering in the middle two bands of every dimension, and nothing in the test
suite will catch that.

In its place, `prompts/CHANGELOG.md` records why each prompt revision was made
and what was observed after it. That is weaker evidence than a labelled set and
is recorded as such rather than presented as equivalent. See
[SCOPE.md](./SCOPE.md).
