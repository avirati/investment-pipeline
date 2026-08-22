# Session 0009 — 2026-08-22 — Config and model routing

[TICKET-0006](../tickets/0006-ticket-config-and-model-routing.md). One module,
`src/config.ts`, plus 14 tests and a one-line change to the CLI entrypoint. No
stage logic. This is the file every later ticket reads `process.env` through, so
it lands before anything needs a model.

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

## Reflection

The implemented checks are good guardrails. It's nice to have the validation in place and have it be easy to add a new provider or model.

## Next

[TICKET-0007](../tickets/0007-ticket-evidence-store.md) — the evidence store.
First module that writes a contract to disk, and where the `Evidence.id` helper
and the truncation constant come into existence.
