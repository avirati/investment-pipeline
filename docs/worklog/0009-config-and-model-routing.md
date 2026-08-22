# Session 0009 — 2026-08-22 — Config and model routing

[TICKET-0006](../tickets/0006-ticket-config-and-model-routing.md). One module,
`src/config.ts`, plus 14 tests and a one-line change to the CLI entrypoint. No
stage logic. This is the file every later ticket reads `process.env` through, so
it lands before anything needs a model.

Then a second, separate piece of work in the same session: the ticket backlog
had been tracking status only in `STATE.md`, and all 30 ticket headers still
read `Status: Open` — including the six that had shipped. Fixing that surfaced
nine defects in the dependency graph, one of them a cycle.

## What I asked for

Continue implementation, stop for review before committing, keep the diff small
and easy to review, keep adding worklogs.

## What the AI produced

`src/config.ts` — four exports and one error type:

- **`requireLlmConfig(role, env = process.env)`** → `{ provider, role, model, api_key }`
  or throws `ConfigError`. `role` is `"extract" | "analyse"`, mapped to
  `MODEL_EXTRACT` / `MODEL_ANALYSE` (ADR-0006). The provider selects which key
  variable is read, so `LLM_PROVIDER=anthropic` asks for `ANTHROPIC_API_KEY` and
  says nothing about `OPENAI_API_KEY`.
- **`githubAuth(env)`** → `{ token, mode, note }`. Absent token is
  `mode: "unauthenticated"` with a manifest-ready `note`, never an error
  (ADR-0004).
- **`loadDotEnv(path = ".env")`** → boolean. Wraps Node 22's
  `process.loadEnvFile`. No `dotenv` dependency, so no ADR line needed.
- **`ConfigError`** carries `problems` (variable + detail) as well as a printable
  message, so a caller can react rather than only print.

`tests/config.test.ts` — 14 tests. `src/cli.ts` gained one `loadDotEnv()` call
inside the `isEntrypoint()` guard.

## Four judgement calls, in descending order of how much they need review

**1. Validation is role-scoped, not whole-env.** `requireLlmConfig("analyse")`
does not care that `MODEL_EXTRACT` is blank. The ticket says fail late; failing a
stage-1 run for a variable stage 1 will never read is the same rule broken from
the other side. The cost: a run can get halfway through and then discover
`MODEL_EXTRACT` is missing. That is the right trade for this pipeline —
`./pipeline source` is a complete, useful command on its own — but it is a trade,
and a preflight check in TICKET-0027's `run` command is the place to buy the
early failure back if it turns out to sting.

**2. Both secret-carrying objects redact in `toJSON`.** `LlmConfig.api_key` and
`GithubAuth.token` disappear when serialised — `api_key` becomes
`"[redacted]"`, `token` is dropped. This is three lines each and it is here
because run manifests are _committed to the repo_ (ARCHITECTURE §4) and the
manifest is exactly the object someone will build by spreading a config into it.
Relying on every future call site to remember is how keys end up in git history.
The cost is a slightly odd type — `LlmConfig` has a method on it — and two tests
that assert on `JSON.stringify` rather than on a field.

**3. Blank means unset.** `.env.example` ships every variable declared and empty,
and `setup.sh` copies it verbatim, so on a fresh clone `process.env.MODEL_EXTRACT`
is `""`, not `undefined`. Treating `""` as a value would produce "model '' not
found" from the provider SDK instead of "MODEL_EXTRACT not set — see
.env.example". Trimmed-blank counts too. One test per case.

**4. `.env` is read at the entrypoint, not at import.** Nothing in `src/` has a
side effect on `process.env` merely by being imported, so tests and any future
library caller get the environment they actually have. Node's loader does not
overwrite variables that are already set, so a CI override wins over the file —
verified in a test rather than assumed from the docs.

## What is deliberately not here

- **No `ConfigError` → exit-code mapping in the CLI.** `EXIT.USAGE` is the right
  landing spot and the `--help` epilogue already promises it, but nothing calls
  `requireLlmConfig` yet, so a handler now would be an untested branch guarding
  an impossible throw. It belongs to TICKET-0018, the first ticket that makes an
  LLM call.
- **No provider construction.** `LLM_PROVIDERS` lists what has an adapter;
  `src/llm/provider.ts` is TICKET-0018.
- **`ollama` is not in `LLM_PROVIDERS`.** ADR-0006's sketch line shows
  `openai | anthropic | ollama`, but `.env.example` — the file an operator
  actually reads — says `openai | anthropic`, and the ADR's decision paragraph
  names `@langchain/openai` as the only adapter. Two is what ships; adding a
  third is a case in the factory and a line here.

## Verification

| Acceptance criterion                                             | Result                             |
| ---------------------------------------------------------------- | ---------------------------------- |
| Valid env parses                                                 | pass — both roles, both providers  |
| Missing `MODEL_EXTRACT` produces a message naming it             | pass — and naming `.env.example`   |
| Importing `config.ts` with a completely empty env does not throw | pass                               |
| `pnpm test` passes with no `.env` present at all                 | pass — run with `.env` moved aside |

`pnpm test` 59 passed (17 CLI + 28 contracts + 14 config), `pnpm typecheck`
clean, `pnpm lint` clean. Nothing here touches the network.

Beyond the acceptance list, the suite pins: every missing variable is reported in
one message rather than one per run; an unsupported `LLM_PROVIDER` reports alone
rather than guessing which key variable to demand; neither secret survives
`JSON.stringify`; a blank value is unset; a real environment variable beats the
`.env` file; and a missing `.env` returns `false` rather than throwing.

## What went wrong

Two things, both caught by the gates.

`tsc` rejected `KEY_VARIABLE: Record<LlmProvider, EnvVariable>` — the annotation
widened the lookup result to include `GITHUB_TOKEN`, which is not a key on the
parsed LLM env object. Fixed with `as const satisfies Record<...>`, which keeps
the constraint and the narrow literal types.

The first draft required both model variables regardless of role. It typechecked,
passed a naive test, and would have made `./pipeline source` fail on a variable
it never reads. Caught while writing the test for judgement call 1 — the test
existing is what surfaced it.

## Ticket statuses and the dependency graph

Asked to update resolved tickets, unblock what they unblock, and make status
mean something. Three parts.

**1. A status vocabulary, and status where the ticket is.** Every header now
reads one of three things, documented in `tickets/README.md`:

- `**Done**`, followed by a link to the worklog entry that says what happened.
  Worklogs rather than commit hashes: they are stable, they are one hop from the
  commit, and 0006 had not been committed when this was written.
- `**Ready** — all dependencies Done`.
- `Blocked · NNNN, NNNN` — naming only the dependencies that are *not yet Done*,
  not restating the whole `Depends on` list. That is the field a reader actually
  wants, and it is the field that must change when something lands.

`README.md` gained a Status column and a rule: a ticket's status changes in the
commit that changes it, along with every ticket it unblocks.

**2. Two tickets are Ready, not one.** 0006 unblocked
[TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md) — its only
dependency. So 0007 and 0018 are both Ready. STATE now says resume at 0007
anyway: it unblocks the whole stage-1 chain, and 0018 only unblocks 0011's
clarifier, which 0011's own sequencing note says to ship without.

**3. The graph was wrong in nine places.** Statuses are now derived from
`Depends on`, so the edges have to be right. I checked them with a throwaway
script — not committed; `SCOPE.md` does not want a task runner and one docs
lint is not worth a `scripts/` directory yet — that verifies four properties:
every `Blocks` entry is reachable in the dependency graph, every direct
dependent appears in its blocker's `Blocks`, no cycles, and the README table
matches the headers.

The first run reported 42 failures, almost all of them my checker being wrong:
`Blocks` is a *transitive* claim (0005 blocks `0007–0027`) while `Depends on` is
direct edges. Re-run with the right semantics, nine real defects remained:

| Defect | Fix |
|---|---|
| **0013 `Blocks: 0014–0022` swallowed 0018 — a cycle** | Gate range is now `0014–0017, 0019–0022, 0028` |
| 0005 blocked `0007–0027` but 0006 depends on it | `0006–0027` |
| 0005 did not depend on 0002, whose cut it encodes as `CandidateSource` | added |
| 0028 closes `setup.sh` step 6 but did not depend on 0004 | added |
| 0008, 0012, 0017, 0022, 0024 each omitted a direct dependent from `Blocks` | added |

The cycle is the one that mattered. TICKET-0013 is a hard gate — "do not build
stages 2 and 3 speculatively" — and it claimed to block 0018. But 0011 needs
0018 for its clarifier call, 0011 blocks 0012, and 0012 blocks the gate. Read
literally, 0018 had to come both before and after 0013.

The range was written when the gate was described as "everything after stage 1",
and 0018 happens to sit in that numeric range without belonging to it: a model
factory and a response cache contain no thesis, no rubric, and no prompt, so
there is nothing in them for a bad junk rate to invalidate. What the gate exists
to protect is extraction, the rubric, and the memo, and those are still behind
it. Recorded in 0013 itself rather than silently renumbered, and as STATE
inconsistency 13.

## Decisions taken

No open `STATE.md` decision was touched. D-2, D-4, D-5, D-6 and D-7 stay open.
D-1 was already closed at its default in TICKET-0001 and this module is the
consumer of that shape: the two model variables ship empty and are validated
where they are used.

## Attribution

`src/config.ts`, `tests/config.test.ts`, the `src/cli.ts` change and the factual
sections of this entry: AI-written end-to-end from one prompt, reviewed by me
before the commit. The four judgement calls above were the AI's and were
surfaced before commit.

The ticket status pass, the status vocabulary, and the nine graph fixes: also
AI-written end-to-end, from the follow-up prompt *"update tickets that are
resolved, change status, unblock tickets etc"*. The cycle and the eight edge
defects were found by the AI's own consistency check, not by me, and not asked
for.

## Reflection

The implemented checks are good guardrails. It's nice to have the validation in place and have it be easy to add a new provider or model.

## Next

[TICKET-0007](../tickets/0007-ticket-evidence-store.md) — the evidence store.
First module that writes a contract to disk, and where the `Evidence.id` helper
and the truncation constant come into existence.
