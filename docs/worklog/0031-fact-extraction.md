# Session 0031 — 2026-08-22 — Fact extraction, and the vocabulary the rubric switches on

[TICKET-0020](../tickets/0020-ticket-fact-extraction.md), in three commits.
`src/analyse/keys.ts` is the 24-key fact vocabulary that fills `{{keys}}`;
`src/analyse/extract.ts` is stage 2b — one bundle in, cited facts out — and is
the first module in this repo that would spend a token. The third commit
answers the author's reflection on [worklog 0030](./0030-extraction-prompt.md)
by moving the citable evidence ids into the requested schema as an enum.

## What I asked for

Continue implementation, stop for review, small commits on a feature branch,
keep the worklogs going with reflection hints, update ticket statuses.

## What landed

| Commit    | Contents                                                    | Tests |
| --------- | ----------------------------------------------------------- | ----- |
| `b500243` | `src/analyse/keys.ts` — the enumerated fact key vocabulary  | 10    |
| `3a3f54b` | `src/analyse/extract.ts` — render, call, retry, parse, drop | 34    |
| `57e39f3` | `evidence_ids` as a `z.enum` of the ids this bundle showed  | +3    |

**785 tests** (738 before this ticket: +47), typecheck and lint clean, offline
and with no `.env`. **Nothing has been sent to a provider** — see the gap below.

## The vocabulary

`Fact.key` is what the rubric switches on and the contract leaves it as
`string` on purpose (ARCHITECTURE §2). This is where the strings are decided.
Four rules:

**Enumerated, not free-form.** A key the model coins is dropped at parse time,
the same way an uncited fact is. Letting it coin keys moves the vocabulary into
the model's head and leaves `score.ts` pattern-matching English, which is the
thing ADR-0002 exists to prevent. The cost is real and is paid knowingly: a
true observation that fits no key is lost rather than scored. This also closes
[STATE inconsistency 73](../STATE.md) — `extract.v1`'s `{{keys}}` now names a
vocabulary that exists, so the prompt stands at v1.

**Keys name observations, never verdicts.** `founder.prior_role` is a thing a
page states; `founder.is_technical` would be a conclusion, and a conclusion in
a key is the model scoring the company one field earlier than ADR-0002 allows.
A test asserts no key or hint contains a ranking adjective.

**No dimension field, no weights, no bands.** Which keys feed which dimension is
the rubric's (CLAUDE.md invariant 7). The moment a key knows it is a "D1 key"
the thesis lives in two files, and the second copy is the one nobody updates. A
test asserts no hint names a dimension, a point value or a threshold.

**Mechanical keys stay in.** `traction.github_stars` is already a dated `Signal`
read straight off an API payload, so the model transcribing it adds a way to be
wrong. It stays anyway, because the memo needs a _sentence_ to print and a
signal has none — stage 3 is templating. That is a partial answer to
[inconsistency 58](../STATE.md): a mechanical signal **does** become a `Fact`,
because the fact carries prose the signal cannot; whether the rubric trusts the
fact or the signal for the _number_ is TICKET-0021's, and the answer should be
the signal.

The list is unvalidated. It was written from SPEC §1–2 against the evidence
types that actually exist, not from measurement — there is no eval harness in
v1 (SCOPE), and the first captured extraction is the first evidence that these
are the right 24 words.

## The module

Five rules, and the first one is a change of definition.

**1 — The closed world is what was _shown_, not what was fetched.** `bundleIds`
(TICKET-0017) includes `fetch_failed` records, because a memo may cite a 404 as
evidence of absence. Those are not something to extract facts _from_, so they
are not rendered, and an id the model was never shown is rejected exactly like
an invented one. `shownItems` is the one function the renderer and the validator
both read, so the two lists cannot drift. This is narrower than the ticket asked
for — it said "ids not present in the supplied bundle" — and narrower in the
direction that costs coverage rather than credibility.

**2 — Dropping is per fact, and it is recorded.** One malformed fact must not
cost the other seven, so the schema handed to the provider is permissive at the
item level and the strict one is applied here, item by item, through
`parseOrDrop`. Every drop keeps its index, the key it claimed and the reason.
**Nothing is repaired**: a fact citing one good id and one phantom is dropped
whole, because a citation list we edited is one a reviewer opens and finds does
not support the sentence.

This catches the malformed fixture's item 2 — the one `parseOrDrop(Fact, …)`
keeps, described in `scripts/fixtures.ts` as the reason TICKET-0025 exists:
well-formed, and citing a record that does not exist. All eight of that fixture
now drop, one stage earlier than the memo validator. The validator is still
owed: it checks a _rendered memo_ against the store, and that is a different
check with a different failure.

**3 — Facts only.** A test asserts the exact key set of `ExtractResult`. If a
score, a call or a band ever appears in it, scoring has moved into stage 2b.

**4 — A bad answer degrades the candidate, never the run.** Invalid structure is
retried once with the parse error appended, then the candidate is `partial` with
zero facts and the run continues (ARCHITECTURE §5). A bundle with nothing
readable in it never calls the model at all — `no_evidence`, zero tokens.
`LlmCallError` — a cold cache under `--replay`, a stale entry — passes straight
through: those are the operator's problem and retrying one would call the
provider they asked us not to.

**5 — Evidence text is data, never instruction.** Records are fenced with a
marker that is neutralised if the fetched page writes it itself. `prompt.ts`
already refuses to re-scan a substituted value for placeholders; this is the
same concern one layer up, and the text comes off the open internet.

## The author's note from 0030, implemented

> _"We are relying on LLM to cite evidence ids which will be referenced from a
> list. This should work but there is a non zero chance of the model
> hallucinating. It would be better if this list was provided in the zod schema,
> as an enum."_

`extractionSchema(ids)` is now built per bundle and `evidence_ids` is a
`z.enum` of the records that candidate was shown. Under constrained decoding the
closed world stops being a rule the model is asked to follow and becomes a shape
it cannot leave. The ids reach the provider inside the JSON schema, which a test
pins by rendering it.

Two things worth being explicit about, because this was not free:

- **The client-side check is not now redundant.** A provider that treats a
  schema as documentation rather than as a grammar, and any answer cached before
  the schema moved, still arrive unconstrained. Both halves have their own test:
  a schema-honouring model citing a failed fetch ends `partial`; a lenient one
  has the fact dropped as `unknown_evidence_id`.
- **It is the one exception to rule 2.** An out-of-enum id fails the _whole_
  response and costs the retry, where an invented key costs only its own fact.
  That is the price of the constraint being real. The retry's complaint names
  the id and the allowed set, which is a better second attempt than the first.

## Decisions taken in code

- **The evidence id is the only handle.** No `E1`-style second label. A model
  given two names for a record will cite the wrong one, and the citation would
  then have to be translated back — one more place to be wrong. A test asserts
  no `E<n>` appears in a rendered bundle.
- **`{{company}}` is deliberately thin** — name, url, one-liner, and how the
  candidate was found. A one-liner lifted from an HN title is not a source, and
  a model shown it outside a record can repeat it as a fact with nothing behind
  it. Everything else it may know is inside a fenced record.
- **The signals are not shown to the model.** `bundle.signals` are dated values
  read off payloads; injecting them would put numbers in front of the model that
  it is expected to repeat but cannot check against the text it was given. The
  projections already carry those numbers _in_ the evidence text.
- **No second truncation.** `EVIDENCE_TEXT_LIMIT` is 8 KB a record and a bundle
  holds at most ten, so the worst prompt is ~80 KB of evidence. A record the
  model sees half of is a record it can misquote; the one cut stays where the
  store's is.
- **A failed attempt is an `attempt`, not a `call`.** `callModel` throws before
  it can report a digest or a token count, so there is nothing truthful to put
  in `calls[]`. `attempts` is the only place a failed attempt's cost is visible
  at all — see the gaps.
- **The retry takes its own cache key.** It is a different question, so a
  committed run replays both attempts as they happened rather than answering the
  second from the first's entry.
- **A transport failure is retried without its message.** Telling a model that a
  socket closed teaches it nothing and would go into the committed prompt of the
  second attempt. Only a shape complaint is appended.

## Known gaps, recorded rather than fixed

1. **Nothing has been sent to a provider, and the ticket asked for it.** The
   third acceptance item is "the first captured model output". `MODEL_EXTRACT`
   is empty (D-1's default, deliberately), so a live call needs a model name the
   author has to choose, and it spends money. Left for the author. Everything
   else in the ticket's acceptance list is met offline. **STATE inconsistency 72
   stands**: three prompts and schemas are now written and none has been sent.
2. **A failed attempt's token cost is invisible.** A response that fails to
   parse was still generated and still billed, and `callModel` throws it away.
   `attempts` records that it happened; nothing records what it cost. Fixing it
   means `callModel` reporting usage on the failure path.
3. **The 24 keys are a hand-written list — the eleventh in this codebase.** Same
   class as `RESERVED_OWNERS` and the rest (inconsistency 59), and this one is
   load-bearing in a way those are not: an observation that fits no key is
   dropped silently from the model's point of view and visibly from ours.
4. **Drops are counted per candidate and nowhere aggregated.** A run where the
   model produced twelve facts a candidate and eleven were dropped looks, from
   the manifest, like a run with thin evidence. TICKET-0022 should sum
   `dropped[]` by kind into the manifest; this module only reports its own.
5. **`confidence` is extracted and nothing reads it.** The rubric may or may not
   want it (SPEC does not say). It is on the `Fact` contract, so it is filled;
   whether a `low`-confidence fact should score is TICKET-0021's.

## What this ticket did not do

- **No scoring.** `ExtractResult` carries facts and bookkeeping. TICKET-0021.
- **No wiring.** Nothing calls `extractFacts` yet; `./pipeline analyse` still
  exits 70. TICKET-0022, which is also where the run-level manifest entry and
  the live pass belong.
- **No prompt v2.** `extract.v1` stands: keys are enumerated, which is the
  branch inconsistency 73 said would keep it valid.

## Attribution

`src/analyse/keys.ts`, `src/analyse/extract.ts`, all 47 tests and this
worklog's factual sections are AI-written end to end. The key vocabulary is an
assistant's reading of SPEC §1–2 and has had no human review at the time of
writing.

## Reflection

Needs a live run before more of the tickets pile up.

## Next

**TICKET-0020 is in review**, with one acceptance item outstanding (gap 1).
[TICKET-0021](../tickets/0021-ticket-rubric-scoring.md) — the rubric — has what
it was waiting for: the key vocabulary exists, so `score.ts` has something to
switch on. [TICKET-0022](../tickets/0022-ticket-stage-2-wiring.md) wires
`gatherRun` to `extractFacts` to the rubric and is where the first live stage-2
run belongs.
