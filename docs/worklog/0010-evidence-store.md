# Session 0010 — 2026-08-22 — Evidence store

[TICKET-0007](../tickets/0007-ticket-evidence-store.md). One module,
`src/evidence/store.ts`, plus 19 tests. No network, no stage logic, nothing
calls it yet. It lands now because it is the shape of the citation guarantee:
`fetch.ts` (0008), the extraction bundle (0017) and the memo validator (0025)
all read or write through it, and the id helper has to exist before any of them
can produce an id.

## What I asked for

Continue implementation, stop for review before committing, keep the diff small,
keep adding worklogs, update ticket statuses.

## What the AI produced

`src/evidence/store.ts` — four pure helpers and one small store object:

- **`evidenceId(url, retrieved_at)`** → `sha256(url + retrieved_at)` sliced to
  `EVIDENCE_ID_LENGTH` (16 hex), the length already pinned in the contract by
  TICKET-0005. The only definition of an id in the codebase.
- **`truncateText(text, limit = EVIDENCE_TEXT_LIMIT)`** →
  `{ text, truncated, original_length }`.
- **`makeEvidence(input)`** → a parsed `Evidence`. Computes the id, cuts the
  text, writes the truncation into `meta`, and validates through the schema
  before returning. The only constructor: an adapter never assembles a record
  literal, so it cannot skip the helper or the limit.
- **`evidenceStore(run_id, root = "runs")`** → `{ run_id, dir, path, write, read }`.
  `write` is a no-op on a record already present; `read` returns
  `{ ok: true, evidence }` or `{ ok: false, miss, detail }`.

`tests/evidence-store.test.ts` — 19 tests. No other file changed:
`.gitignore` already says records are committed and raw HTTP bodies are not.

## Five judgement calls, in descending order of how much they need review

**1. `write` refuses a record whose id does not match its own url and
timestamp.** A content-addressed store that trusts the caller's address is not
content-addressed — it is a filename convention. The check is one `evidenceId`
call and it throws rather than returning a result, because a mismatch is a
programming error in an adapter, not a data condition a run should survive. Cost:
a caller that legitimately wants to rewrite a record's url must build a new
record, which is the correct behaviour but is not obvious from the type.

**2. `read` treats a malformed id as `not_found`, and checks the pattern before
it joins a path.** This is the one place in the module with a security shape to
it. The validator (0025) resolves ids that appeared in _model output_, so
`read("../../../etc/passwd")` is a call that will really be made if a model
emits it. Two options: reject it as its own miss kind, or fold it into
`not_found`. Folded — an id that cannot name a file in this directory can never
resolve, which is exactly what `not_found` means, and the `detail` string says
which of the two it was. The validator's hard fail reads the same either way.

**3. Three miss kinds, where the ticket asked for two.** The ticket says `read`
must distinguish "no file" from "unreadable file". Shipped `not_found` /
`unreadable` / `invalid`, splitting the second: a file that exists but is not an
`Evidence` record (bad JSON, failed schema, or filed under an id that is not its
own) is a correctness bug in the pipeline, while an `EACCES` is a broken
environment. They want different messages from the validator and probably
different exit codes. If that turns out to be a distinction without a difference,
collapsing them is a two-line change.

**4. The truncation marker goes in the text, not only in `meta`.** The model
reads `text` and never sees `meta`, so a fact drawn from a cut-off page should be
visibly drawn from a cut-off page. The marker is counted inside the budget rather
than appended after it, so `text.length <= EVIDENCE_TEXT_LIMIT` holds without
exception — a property the bundle-size arithmetic in 0017 can rely on. `meta`
still records `text_truncated` and `text_original_length`, always, including when
nothing was cut: a uniform field is greppable and diffable, and "recorded" should
not mean "recorded when it happened".

**5. `EVIDENCE_TEXT_LIMIT = 8_000` is a guess and is labelled as one.**
ADR-0003 names bundle length as the price of closed-world citation but does not
name a number. 8k characters is roughly 2k tokens of prose per record; a
candidate with an HN item, a site page and two GitHub records is then ~8k tokens
of evidence. That is affordable and it is not measured. It stays one constant in
one file so the first real extraction call can move it.

## What is deliberately not here

- **No `list`/`all` over a run's evidence directory.** The extraction bundle
  needs one and it belongs to TICKET-0017, which knows what order and what
  filtering it wants. Guessing now would ship an unused API with an invented
  contract.
- **No write-to-temp-and-rename.** The `wx` open flag gives "create or tell me it
  already exists" atomically, which is the property the no-op double-write needs.
  A crash mid-write can still leave a torn file; `read` reports it as `invalid`
  and the record is re-fetchable, so the extra complexity buys very little.
- **No caching, no HTTP.** The store is filesystem only. `fetch.ts` is
  TICKET-0008 and is the module that will call `makeEvidence`.
- **No `runs/` directory in git yet.** Nothing writes one until stage 1 wires up
  (TICKET-0012), and an empty committed directory is noise.

## Verification

| Acceptance criterion                                        | Result                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Id stable for the same `(url, retrieved_at)`                | pass                                                    |
| Id differs when either input changes                        | pass — one test per input                               |
| Double-write produces one file                              | pass — and the bytes are unchanged                      |
| `read` of an unknown id returns a miss rather than throwing | pass                                                    |
| Truncation is applied and recorded                          | pass — in `text` and in `meta`                          |
| Written records round-trip through the `Evidence` schema    | pass — `Evidence.parse(fileContents)` equals the record |

`pnpm test` 78 passed (17 CLI + 28 contracts + 14 config + 19 evidence store),
`pnpm typecheck` clean, `pnpm lint` clean. Tests write to a `mkdtemp` directory
and remove it, so the suite touches neither `runs/` nor the network.

Beyond the acceptance list, the suite pins: a `fetch_failed` record is a record
and not an absence; adapter `meta` survives alongside the store's own keys; a
forged id is refused and creates no directory; a traversal id misses without a
filesystem call; and a valid record filed under the wrong name is `invalid`
rather than silently returned.

## What went wrong

Nothing reached the gates, and the two things worth recording are small.

The first draft of `write` used write-to-temp-then-rename for atomicity, then
dropped it for the `wx` open flag, which gives the same "create, or tell me it
already exists" guarantee in one call. Two `node:fs` imports were left behind
unused; `tsc` did not complain about them and `biome` did not either — they were
noticed by reading the file, which is a gap in the gates rather than a lucky
catch. Worth a lint rule if it happens again.

The first draft of the truncation test contained a garbled ternary in place of
an expected value — it still passed, because the garbage evaluated to `false`
and `false` was the right answer. A test that passes for the wrong reason is
worse than one that fails, and only re-reading the file found it. The relevant
lesson is about reviewing generated tests, not about this test.

## Decisions taken

No open `STATE.md` decision was touched. D-2, D-4, D-5, D-6 and D-7 stay open.
`EVIDENCE_TEXT_LIMIT` is a new labelled guess of the same kind as D-6's
`--min-hits` threshold, but it is not being raised to a STATE decision: it has no
downstream fork behind it, only a number to revise once a real bundle exists.

## Attribution

`src/evidence/store.ts`, `tests/evidence-store.test.ts`, the ticket status
changes and the factual sections of this entry: AI-written end-to-end from one
prompt, reviewed by me before the commit. The five judgement calls above were the
AI's and were surfaced before commit.

## Reflection

Evidence store will help prevent hallucinated citations from the model. Any evidence that is not found, will be kept as is, rather than being invented as a fabricated value.

## Next

[TICKET-0008](../tickets/0008-ticket-cached-fetch-layer.md) — the cached fetch
layer, now the only Ready ticket on the stage-1 critical path. First module that
touches the network, and the one that turns a response into `makeEvidence`.
