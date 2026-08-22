# Session 0004 — 2026-08-22 — Repo scaffold

First code commit. [TICKET-0001](../tickets/0001-ticket-repo-scaffold.md) only:
`package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`,
`.env.example`, `pnpm-lock.yaml`. No `src/`.

## What I asked for

Start implementing, stop for review before committing, keep the commits small
enough to actually read.

## What the AI produced

The six files above, on branch `feat/0001-repo-scaffold`, merged to `main` as
PR #1 in commit `dff8fc2`. Acceptance from the ticket, all verified rather than
assumed: a clean `pnpm install --frozen-lockfile`, and `pnpm typecheck`,
`pnpm lint`, `pnpm test` each exiting 0 with no API key present. `.env` is
confirmed gitignored; `.env.example` holds no secret.

Three choices in it that were judgement, not transcription:

- **`tsconfig` is stricter than the ticket asked for.** The ticket says `strict`,
  `NodeNext`, `noEmit`. Also enabled: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. The argument was that
  these are free before `src/` exists and expensive to retrofit once the Zod
  contracts in TICKET-0005 are written against looser rules. The cost is real
  and lands later: `exactOptionalPropertyTypes` makes Zod-inferred optional
  fields more verbose to construct, and if that turns into friction during
  stage 2 the honest move is to drop the flag rather than work around it.
- **`.env.example` names more than the two model roles.** `LLM_PROVIDER`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and an optional `GITHUB_TOKEN`
  documented as the difference between 60 and 5000 GitHub requests per hour —
  with a comment that its absence lowers coverage rather than failing the run,
  which is the SPEC §3 missing-data rule stated where an operator will read it.
  `GITHUB_TOKEN` arriving here rather than with TICKET-0015 is mild scope creep;
  it stays because a half-populated `.env` is worse than an over-documented one.
- **`pnpm.onlyBuiltDependencies: ["esbuild"]`.** Without it pnpm 10 prints an
  "ignored build scripts" warning on every install, which would be the first
  thing `setup.sh` step 3 shows a new operator. Verified against a deleted
  `node_modules`, not just an incremental install.

## Dependencies

Runtime: `zod`, `commander`. Dev: `typescript`, `tsx`, `vitest`, `biome`,
`@types/node`. Seven packages, and that is the point — `cheerio`, `eta`,
`p-retry`, `@clack/prompts` and the LangChain packages named in ARCHITECTURE §8
are all absent, each waiting for the ticket that first uses it, so the lockfile
diff records when a dependency was earned rather than anticipated.

## What went wrong

Two small things, both caught by the tools rather than by reading:

1. The first `biome.json` used `linter.rules.recommended`, deprecated in Biome
   2.5 in favour of `preset`. `pnpm lint` exited 0 but printed a deprecation
   notice, which was only noticed because the output was read past the exit
   code. A lint config that warns on every run trains people to ignore lint
   output.
2. A scripted edit to `package.json` round-tripped the description through
   `json.dump` with default settings, escaping the em-dash to a literal
   `\u2014`. Cosmetic, caught by reading the file back afterwards. Editing JSON by
   re-serialising it is a bad habit that will eventually corrupt something that
   matters.

Neither reached the commit.

## Decisions taken

**D-1** — taken at the default documented in `STATE.md`. `MODEL_EXTRACT` and
`MODEL_ANALYSE` are present in `.env.example` with empty values and comments
naming each role: `MODEL_EXTRACT` cheap and mechanical, one schema-constrained
call per candidate; `MODEL_ANALYSE` judgement-heavy and low volume. Which model
each should be depends on what the operator's account can reach, so `setup.sh`
(TICKET-0004) will prompt rather than the repo guessing. The comment block also
restates that neither model ever produces a score, a call, or memo prose
(ADR-0002).

This also closes **known inconsistency #2** in `STATE.md`: ARCHITECTURE §7.1
step 4 depended on a `.env.example` that did not exist.

No other open decision was touched.

## Attribution

All six files and the factual sections of this entry: AI-written end-to-end from
one prompt, reviewed by me before the commit. The instruction to stop for review
before committing, and to keep the commit small, was mine. The three judgement
calls above were the AI's, surfaced to me explicitly before commit rather than
buried in the diff.

## Reflection

TODO(author) — after enough tickets have landed to see whether this held.

- Did the extra `tsconfig` strictness pay for itself, or did
  `exactOptionalPropertyTypes` get switched off the first time a Zod contract
  fought it?
- Was "one dependency, one ticket, visible in the lockfile" a useful discipline
  or just ceremony that slowed each ticket down?
- Reviewing a six-file scaffold commit took real attention for very little
  surface area. Is per-ticket review the right cadence, or does it only start
  paying once there is logic to review?

## Next

[TICKET-0002](../tickets/0002-ticket-cut-feed-seed-form.md) — cut the `feed`
seed form (D-3). Docs-only; a partial edit to `ARCHITECTURE.md` §1 and §7 is
already sitting uncommitted in the working tree and belongs to that ticket.
