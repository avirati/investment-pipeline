# Session 0025 — 2026-08-22 — The provider seam and the committed response cache

[TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md), in two commits.
The pipeline can now make an LLM call, and — more to the point — can decline to
make one. Nothing calls it yet: this ticket is mechanism, and it encodes no
thesis, no score and no prompt, which is why it sat outside the TICKET-0013 gate.

## What I asked for

Continue implementation, small reviewable commits.

## What landed

| Commit    | Module                                                            | Tests |
| --------- | ----------------------------------------------------------------- | ----- |
| `56a8cbd` | `src/llm/cache.ts` — content-addressed, committed, human-readable | 12    |
| `909af18` | `src/llm/provider.ts` — `createModel`, `callModel`, `costUsd`     | 13    |

**409 tests** (384 before: +25), typecheck and lint clean, offline with no `.env`.
Three runtime dependencies added, pinned exact, recorded as an amendment to
[ADR-0006](../adr/0006-llm-provider-abstraction.md).

## The four rules the cache is built around

1. **The key is the whole call** — `sha256` over provider, model, prompt id,
   prompt version, output schema version and the rendered input. CLAUDE.md
   invariant 6 lives in that one function and nowhere else.
2. **A hit is verified, not assumed.** The entry stores the fields it was keyed
   on and the full input, and `read` compares them. A digest matching a file
   that describes a different call is a `mismatch` miss.
3. **The first answer wins.** Models are not deterministic; re-writing an entry
   would quietly change what a committed run replays to. A repeat write is a
   no-op and refreshing one is `rm`, which shows up in a diff.
4. **A miss says why.** Under `--replay` the caller has to fail with a reason
   rather than quietly call an API the operator asked it not to call.

`--replay` on a cold cache throws `replay_miss` naming the prompt and its
version. That is the acceptance criterion the ticket cared about most, and it is
tested by asserting the stub model was never invoked — not by asserting an error
message.

## Three decisions taken in the code

**The cache key is wider than ARCHITECTURE §4 wrote it.** The doc says
`sha256(provider|model|prompt_version|input)`; the code also hashes the prompt
_id_ and the output _schema_ version, and the ticket asked for the schema
version explicitly. Widening a key can only split entries apart, never merge
them, so this is safe in the direction that matters. ARCHITECTURE §4 was updated
in the same commit to name the tuple the code hashes.

**A `|` separator would have been a real collision.** Provider `open` + model
`ai|gpt` and provider `open|ai` + model `gpt` produce the same concatenation.
The key hashes a canonical JSON array instead, which escapes the separator out
of every value. Pinned by a test, because it is the kind of thing that is
obvious once written down and invisible before.

**`PRICES` ships empty.** The ticket says "record token counts and cost per
call". Token counts come from the provider and are recorded. Cost does not: list
prices move, a manifest is committed to this repo, and a wrong cost line is
worse than an absent one. `costUsd` is real, takes a price table, and is tested
against one; the shipped table is `{}` and every `cost_usd` is `null` until
somebody fills it in from a price page on a date. This is the same rule SPEC §3
applies to facts — unknown is written as unknown — applied to money.

## Two things the LangChain interface did not hide

Both were predicted by ADR-0006's own "the abstractions leak" paragraph. Both
are now in the amendment so they are not rediscovered.

**`usage_metadata` types as `never`.** It is inferred from a message-structure
generic, and the `BaseMessage` a runnable returns is un-parameterised. Token
counts are read through one narrow structural type rather than through
`AIMessage`.

**`withStructuredOutput` requires an object schema** — `RunOutput extends
Record<string, any>`. This is not a typing nuisance; it is a finding for
TICKET-0011. `prompts/clarify-query.v1.md` ends with _"Return **only** a JSON
array of strings"_, and a bare array cannot be a structured-output schema. The
clarifier will need a wrapper (`{ queries: [...] }`) and therefore a **prompt
v2**, because a prompt that contradicts the tool schema it is sent with is a
prompt that will be disobeyed in one direction or the other. Recorded as
inconsistency 52 and handed to 0011's re-open rather than fixed here.

## One change to a module committed an hour earlier

`LLM_CACHE_SCHEMA_VERSION` went 1 → 2 in the second commit: `output` was a
string and is now the value itself. Wiring the first caller is where it became
obvious — a structured answer stringified into a JSON string is committed as one
escaped line, which is exactly the opposite of the readable, diffable cache
ADR-0006 asks for. No entry had been committed under 1, so the bump costs
nothing, and the constant's own doc comment now records why it moved.

## Verification

- `pnpm test` — **409 passed** (384 before: +25). Offline, no key, no network.
- `pnpm typecheck`, `pnpm lint` clean.
- **No live provider call was made.** Nothing in this ticket has ever talked to
  OpenAI or Anthropic; every test drives a stub `LlmModel`. The adapters in
  `chatModel` are the only untested lines in the module, and they are untestable
  offline by construction.

## What the record should be honest about

**The seam is unexercised.** `createModel` is covered only for its failure path
— a missing variable, reported by name, before an SDK is loaded. Whether
`ChatOpenAI` and `ChatAnthropic` behave as this wrapper assumes is unknown until
TICKET-0011's clarifier or TICKET-0020's extraction makes a real call.

**`.cache/llm/` has no entries.** It is committed by policy (`.gitignore`) and
empty in fact. The replay guarantee is tested against temp directories, not
against anything a reviewer can open.

**Inconsistency 12 is still open.** `ConfigError` — and now `LlmCallError` —
have no exit-code mapping in `src/cli.ts`, because no CLI path constructs a
model yet. It lands with the first stage that calls one.

**One retry is missing on purpose.** ARCHITECTURE §5 says an invalid structure
is retried once with the parse error appended. That belongs to TICKET-0020,
where there is a prompt to append it to; `callModel` currently lets a schema
failure from the provider propagate.

## Decisions taken

No open decision in STATE.md was answered. Three implementation decisions were
taken and are recorded above: the wider cache key, the empty `PRICES` table, and
the schema bump to store parsed values.

**TICKET-0018 is Done.** Its one downstream consequence — the clarifier call —
reopens TICKET-0011.

## Attribution

`src/llm/cache.ts`, `src/llm/provider.ts`, all 25 tests, the ADR-0006 amendment
and this worklog's factual sections are AI-written end to end. The three
decisions above were the AI's, taken under the documented defaults.

## Reflection

LLM cache might not amount to much in test runs but it will prove its worth when we run this pipeline on a large dataset.

## Next

Two ways forward, no blockers between them:

- **[TICKET-0011 re-opened](../tickets/0011-ticket-query-planning.md)** — wire
  the `Clarifier` seam to `callModel`, which needs `prompts/clarify-query.v2.md`
  (the array → object change above) and the `{{thesis}}` placeholder, which does
  not exist until the rubric does (TICKET-0021). It is the only way to answer the
  question [the gate](0022-gate-hand-check.md) could not: _were the clarification
  options actually good?_ `eBPF observability` is the reproducible test case.
- **[TICKET-0014](../tickets/0014-ticket-fixture-capture-script.md)** —
  `pnpm capture-fixtures`, still Ready, and the thing that keeps the suite
  offline as stage 2 adds three external surfaces.

Then stage 2 proper: 0015 and 0016.
