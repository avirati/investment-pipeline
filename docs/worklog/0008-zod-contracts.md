# Session 0008 — 2026-08-22 — Zod contracts

[TICKET-0005](../tickets/0005-ticket-zod-contracts.md). Six schemas in
`src/contracts/`, one `parseOrDrop` helper, 28 tests, and one paragraph added to
`ARCHITECTURE.md` §2. No stage logic — this is the boundary those stages will
talk across, and STATE is right that it comes first.

## What I asked for

Continue implementation, stop for review before committing, keep the diff small
and easy to read, keep adding worklogs.

## What the AI produced

Eight files under `src/contracts/`: `query-plan.ts`, `candidate.ts`,
`evidence.ts`, `fact.ts`, `analysis.ts`, `memo.ts`, plus `parse.ts` for the
drop helper and `index.ts` as the barrel. Each contract exports its schema, its
`z.infer` type under the same name, and a `*_SCHEMA_VERSION` constant.

Shapes are ARCHITECTURE §2's, with the one addition described below. The pieces
that are mechanism rather than description:

- **`Fact.evidence_ids` is `z.array(z.string().min(1)).min(1)`.** Not optional,
  not defaulted. This parse failing _is_ how uncited facts get dropped
  (ADR-0003); there is no separate filter step to forget to call. Two tests
  cover it — no field at all, and an empty array — because those are two
  different mistakes an extractor can make.
- **`Disqualifier.evidence_ids` is also `.min(1)`.** SPEC §1.1 says a
  disqualifier must itself be evidence-backed and we do not pass on inference.
  That is enforceable in the schema, so it is enforced in the schema.
- **`Evidence.type` includes `fetch_failed`.** A failed fetch is a record, not
  an absence (ARCHITECTURE §5), so a memo can say "we could not reach their
  site" with a citation behind it.
- **`Analysis.call` is `PASS | WATCH | TAKE_A_MEETING`**, and lives in exactly
  one file.
- **`coverage` is a 0–1 share, not a percentage.** SPEC talks in percent and the
  memo header prints percent, so the schema range is the thing stopping `80`
  from being written where `0.8` was meant. There is a test for it.

## Three judgement calls, in descending order of how much they need review

**1. `Fact` gained a `key`.** ARCHITECTURE §2 listed
`Fact { statement, value, evidence_ids, confidence }`. Scoring is a pure
function over facts (ADR-0002), and with that shape the only handle `score.ts`
has on _which_ fact it is holding is the English in `statement`. A rubric that
pattern-matches prose is not deterministic scoring, it is deterministic
regex-ing of model output. So `key` is a stable identifier — `founder.prior_exit`,
`github.stars` — and `statement` stays as the sentence a partner reads.

The key _vocabulary_ is deliberately not enumerated. It belongs to the extraction
schema (TICKET-0020) and the rubric (TICKET-0021), it is unvalidated until real
candidates exist, and pinning it now would be guessing with a version bump
attached. `ARCHITECTURE.md` §2 was updated to match rather than left to drift.

**2. Dimension ids, weights and disqualifier ids are _not_ typed here.**
`Dimension.id` is `z.string().min(1)`, not `z.enum(["D1".."D5"])`, and there is
no `{ D1: 25, D2: 20, ... }` table in the contracts. CLAUDE.md invariant 7 puts
the thesis in exactly one place — the rubric in `src/analyse/score.ts` — and
`D1 is worth 25` is the thesis, not the shape of a JSON file. Encoding it here
would make this the second place and the two would drift.

The cost is real and worth stating: a typo in a dimension id will not be caught
at the boundary. It will be caught in `score.ts`, which is the file that knows
what the ids mean. `call` is an enum despite the same argument because it is the
pipeline's _output_ vocabulary (SPEC §3), not the thesis's content (SPEC §1–2),
and the ticket asks for it explicitly.

**3. Nullable, not optional.** Every field we might not have — `Evidence.title`,
`Provenance.ref` — is `.nullable()` and required, rather than `.optional()`. An
artifact that records "we looked and there was no title" and one that predates
the field looking identical on disk is exactly the ambiguity CLAUDE.md invariant
4 exists to prevent. Same reasoning for `schema_version` being a required
literal rather than `.default(1)`: a defaulted version means an unversioned
artifact silently parses as v1, which defeats the point of versioning it
(invariant 6). There are tests for both.

## Verification

| Acceptance criterion                                                  | Result                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm typecheck` passes; every contract exports a schema and its type | pass                                                        |
| A `Fact` with no `evidence_ids` fails to parse                        | 2 tests, both fail-to-parse                                 |
| An `Analysis` with a `call` outside the enum fails to parse           | pass — `MAYBE` and lowercase `take_a_meeting` both rejected |
| `grep` shows `schema_version` in all six files                        | 6/6                                                         |

`pnpm test` 45 passed (17 CLI + 28 contracts), `pnpm typecheck` clean,
`pnpm lint` clean. Offline, no API key — nothing here touches the network.

Beyond the acceptance list, the suite also pins: a foreign `schema_version` is
rejected on all five versioned contracts; an omitted `schema_version` is
rejected; an `Evidence.id` that is not a truncated sha256 is rejected; an
omitted nullable field is rejected; `coverage: 80` is rejected; and
`parseOrDrop` keeps the good items and reports the index and reason of each
drop.

## What went wrong

Nothing that survived. `pnpm lint` failed once on import ordering in the test
file — biome's organize-imports sorts `CANDIDATE_SCHEMA_VERSION` after
`Candidate` — and `pnpm format` fixed it.

Worth recording as a near-miss: the first draft of `Dimension` had the 25/20/25/
15/15 weights as a `const` in `analysis.ts`. That is a direct invariant-7
violation and it looked entirely reasonable while being written, which is the
usual way that invariant gets broken. It was caught before the file was saved,
not by a test — there is no test that would have caught it.

## Decisions taken

No open `STATE.md` decision was touched. D-2, D-4, D-5, D-6 and D-7 stay open.
The `Fact.key` addition is new and is recorded as STATE inconsistency 8 so it is
visible to whoever picks this up, not buried in this entry.

## Attribution

All eight files in `src/contracts/`, `tests/contracts.test.ts`, the
`ARCHITECTURE.md` §2 paragraph and the factual sections of this entry:
AI-written end-to-end from one prompt, reviewed by me before the commit. The
three judgement calls above were the AI's and were surfaced before commit.

## Reflection

Zod schema set up, these will act as the blueprint for pipeline stages to talk to each other. There is a test framework in place to ensure the integrity of these schemas.

## Next

[TICKET-0006](../tickets/0006-ticket-config-and-model-routing.md) — config and
model routing in `src/config.ts`. Then 0007, the evidence store, which is the
first module that actually writes one of these contracts to disk and where
`EVIDENCE_ID_LENGTH` gets used rather than just declared.
