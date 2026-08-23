# Session 0034 — 2026-08-23 — The first live run

The thing [worklog 0033](./0033-stage-2-wiring.md) deferred, done: `MODEL_EXTRACT`
filled in, `./pipeline source` and `./pipeline analyse` run against live HN,
live GitHub, live company sites and a live provider. Three candidates on
`AI agent infrastructure`. It broke on the first attempt, for a reason no
offline test could have caught, and worked on the second.

## What I asked for

Can we do a live run?

## What was decided before spending anything

- **`MODEL_EXTRACT=gpt-4.1-mini`**, written into `.env`. D-1 left it empty on
  purpose; this is the operator's choice and it closes that decision for the
  `extract` role. `MODEL_ANALYSE` is still empty — nothing calls it (0011 is
  reopened).
- **Three candidates, not fifteen.** The smallest run that exercises every path.
  The committed sample run is TICKET-0028's and belongs after stage 3 exists.
- **`GITHUB_TOKEN` still empty**, so the run was unauthenticated: a 60/hr wall
  and a 30-request planning ceiling, which three candidates fit inside easily.

## What happened

**Stage 1, live.** 179 posts across 4 arms and 6 pages, 0 failures, 124 usable
after classification, 121 companies after dedup, 3 resolved. The three it picked
are usefully different: two company sites (`freestyle.sh`, `klausai.com`) and one
**GitHub repo url** (`github.com/Infisical/agent-vault`), which is the reverse
join TICKET-0015 narrowed to `repo.homepage` — so the run exercised both
directions of the join without being asked to.

**Stage 2, first attempt: every call rejected, zero tokens spent.**

```
400 Invalid schema for response_format 'facts': In context=('properties',
'facts','items'), 'required' is required to be supplied and to be an array
including every key in properties. Missing 'key'.
```

`extractionSchema` built its per-fact object with `.partial()` — every field
optional. That is rule 2 of the schema and it is deliberate: a fact the model
cannot complete should arrive to be dropped with a reason rather than costing
the whole response. **OpenAI's strict structured-output mode refuses a schema
whose `required` omits any property.** Optionality has to be expressed as a
nullable _type_, not as an absent key.

Nothing offline could have caught this. Every test in the suite parses the
schema with Zod, and Zod is perfectly happy with it; the rule being broken
belongs to the provider's JSON-schema validator, which no stub has.

**What the failure did right.** The run completed. Three `partial` rows, each
naming both attempts and the 400 verbatim, three analyses written, and the
rubric still scored every candidate from mechanical signals alone — `agent-vault`
came out at 53/100 with 80% coverage and no facts at all. ARCHITECTURE §5's
"a candidate's failure is never the run's" and invariant 4's "missing data
lowers coverage" both behaved exactly as written, on a failure nobody had
rehearsed.

**Stage 2, after the fix.**

| Candidate     | Call           | Score  | Coverage | Facts |
| ------------- | -------------- | ------ | -------- | ----- |
| `agent-vault` | TAKE_A_MEETING | 75/100 | 100%     | 12    |
| `klaus`       | WATCH          | 63/100 | 80%      | 9     |
| `freestyle`   | WATCH          | 55/100 | 100%     | 26    |

47 facts kept, **0 dropped**, 3 calls, 22,100 input and 3,223 output tokens,
`cost_usd: null` because `PRICES` is empty (inconsistency 54). **117 citations
across the three analyses, every one resolving to a record on disk** — ADR-0003's
guarantee, checked against real output for the first time.

**Replay, verified with `.env` moved aside**, `LLM_PROVIDER` and `MODEL_EXTRACT`
the only variables set: three calls, all three from cache, identical scores, no
API key. That is what `replayModel` was added for in 0033 and it now has a live
demonstration rather than a stub one.

## The fix

`EXTRACTION_SCHEMA_VERSION` → 2 (invariant 6). Every field required and
nullable. `parseFacts` is unchanged and does not need to change — a `null` key
still fails `ExtractedFact` and is dropped as `schema` with a reason, which is
the behaviour `.partial()` was there to produce.

The regression guard asserts on **the JSON schema the provider is actually
sent** — `required` covering every key in `properties` — rather than on Zod's
acceptance of it, because the artifact the rule is about is the JSON schema.

## What the output shows that no test would have

Five observations, none of them fixed here. The first two are defects, the last
three are the rubric and the prompt meeting reality.

1. **An absence was written as a fact.** Freestyle's answer includes
   `funding.raised_usd: "There is no information about funding or capital raised
in the provided records."` That is a negative finding filed under a key whose
   hint asks for "an amount, round, date or investor the source states", and it
   is invariant 4 broken in the one place the pipeline cannot see it: unknown is
   supposed to be _absent_, not a cited fact. It does not move a score — no
   dimension reads that key — but it would reach a memo as a bullet. Prompt v2's
   problem. New inconsistency 85.
2. **A fact cited all eight records at once.** The same fact. A citation list
   that names everything is a shrug, not a pointer, and `parseFacts` has no rule
   against it. New inconsistency 86.
3. **GitHub usernames became named people.** `founder.name_role` for
   `agent-vault` reads "Dangtony98 is a key contributor and appears as the most
   active contributor", and Freestyle's `team.size_visible` names `JacobZwang`
   and `theswerd`. D1 scored 12/25 on that basis for both. The rubric asked
   "is somebody named", the model answered honestly, and the answer is a commit
   handle. This is inconsistency 79 — the rubric reads presence, not meaning —
   arriving exactly where it was predicted to.
4. **Two first names are a founder.** Freestyle's `founder.name_role` is "The
   cofounders of Freestyle are Ben and Jacob." True, cited, and not enough to
   check anything against.
5. **The top-scoring candidate is not a seed-stage company.** `agent-vault` is a
   repository belonging to Infisical, an established funded company, and it took
   the only TAKE_A_MEETING in the run at 75/100. Stage 1 sourced a _project_, not
   a company, and nothing downstream can tell the difference — the gate
   (TICKET-0013) found this class and it is inconsistency 45's neighbour. Worth
   holding against the sample run at TICKET-0028.

## Three things the run's own bookkeeping got wrong

6. **The HN pool charges for requests it did not make.** `gatherCandidate` does
   `charge("hn", 1)` unconditionally after `fetchEvidence`, so a warm cache and a
   `--replay` both report "3 hn requests" having made none. The pool is ungated
   so nothing is enforced on a wrong number, but the manifest states something
   untrue. Site and GitHub count correctly, from the adapters' own totals. New
   inconsistency 87.
7. **A provider 400 about our schema was retried as if the model had erred.**
   `structureComplaint` matches on `/parse|schema|json|invalid|expected/i`, so
   "400 Invalid schema for response_format" reads as a shape complaint and the
   retry appends it to the prompt and asks again. The second attempt was
   guaranteed to fail the same way: the schema was wrong, not the answer. Six
   attempts for three candidates, none of which could have succeeded. No tokens,
   but a real round trip each. New inconsistency 88.

8. **`pnpm lint` would have failed on the first committed run.** `biome.json`
   excluded `runs` and `memos` and not `.cache`, which ADR-0006 commits. The
   pipeline writes artifacts with `JSON.stringify(value, null, 2)` and biome's
   formatter wants something else, so the gate that must pass on a fresh clone
   would have failed on machine-written files. One commit ahead of where
   TICKET-0028 would have hit it. New inconsistency 89, fixed here.

## What landed

| Commit    | Contents                                                       | Tests |
| --------- | -------------------------------------------------------------- | ----- |
| `9503aaa` | `extractionSchema` required-and-nullable, version 2, the guard | +2    |
| _(chore)_ | `biome.json` stops linting `.cache/` — see observation 8       | —     |

**915 tests**, typecheck and lint clean. The run's own artifacts — `runs/`,
three `.cache/llm/` entries — are **left uncommitted** for review; committing
them is TICKET-0028's decision, not this session's.

## Attribution

The schema fix, its tests and this worklog's factual sections are AI-written.
The model choice, the run size and the decision to spend were the author's. The
five quality observations above are readings of real output that no human has
checked against the source pages yet.

## Reflection

Live run exposed a schema issue, which was not caught with offline tests.
Scoring seems to hold as well, for the small set of 3 smoke runs

## Correction — after the run was committed

The author committed the run's artifacts (`200e1a3`) and the fix branch was
fast-forwarded into `feat/0022-stage-2-wiring`. Two things follow that this
entry did not know when it was written:

- The `biome.json` fix in observation 8 landed **one commit before** it was
  needed. Had the order been reversed, `pnpm lint` would have failed on the
  committed cache entries.
- **Inconsistency 84 was measured on a fresh `git clone` and is worse than it
  was written.** `--replay` with no `.env` and no `.cache/http/` does not merely
  add `fetch_failed` records: it **overwrites the committed analyses**, taking
  all three from `TAKE_A_MEETING 75 / WATCH 63 / WATCH 55` to `PASS 25` at 0%
  coverage, rewriting the manifest, and adding seven records. The committed LLM
  cache is never consulted — `0 calls, 0 from cache` — because an empty bundle
  short-circuits at `no_evidence` before a call is made. So the artifact that
  exists to make a clone replayable is unreachable on the clone it exists for.
  The three candidate fixes are written up at inconsistency 84 and TICKET-0028
  now carries it.

## Next

The fix is on `fix/0020-strict-structured-output`, stacked on
`feat/0022-stage-2-wiring`. Both are in review. Three things follow:

- **TICKET-0020's outstanding acceptance item is met** — there is now a captured
  model output, three of them, and they are the first evidence any of the
  prompt's prose works.
- **A prompt v2 is now justified** by observations 1–4, and it needs a
  `prompts/CHANGELOG.md` entry saying what it did to the output above. That is
  TICKET-0019's file and a decision for the author.
- **TICKET-0024** still owns the question 0033 left: what the memo's sections
  are derived from. The 47 facts above are the first real material for answering
  it — including the ones that should not become bullets.
