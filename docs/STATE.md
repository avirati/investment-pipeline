# Project State

Last updated: 2026-08-22 · at commit `6b0023b` · **Phase: contracts and config pinned; no stage logic yet**

Read this first when picking the project up. It is the one document that is
allowed to go stale, so update it at the end of every session.

---

## Where things stand

Specification is written and committed. The toolchain installs, all three gates
pass, and `./pipeline --help` is real — but every command still exits 70, so
nothing has been run end to end. `./setup.sh` now takes a fresh clone from git
to a type-checked tree without the operator knowing pnpm exists. The stage
boundary now exists as six Zod schemas, so stage work can start against a fixed
contract rather than inventing one as it goes. `src/config.ts` is the one place
`process.env` is read: model choice is an env change (ADR-0006), a missing
variable names itself, and nothing validates at import — the offline paths still
run with no `.env` at all. Tickets 0001–0006 are done.

| Area | State |
|---|---|
| Thesis and rubric | Written, **unvalidated against any real company** |
| Architecture and stage contracts | Written; contracts implemented in `src/contracts/` (0005) |
| ADRs 0001–0008 | Written |
| Test strategy | Written; 59 tests — 17 CLI (0003), 28 contracts (0005), 14 config (0006). Offline, no key |
| Worklogs 0001–0009 | Factual sections written; reflections pending (see D-4) |
| Ticket backlog | [docs/tickets/](./tickets/) — 30 tickets, 6 done |
| Toolchain | `pnpm install/test/typecheck/lint` all pass, offline, no key (0001) |
| CLI surface | `src/cli.ts` — four commands, flags and `--help` pinned and tested (0003) |
| Exit codes | `src/exit-codes.ts` — 0/1/2/3, plus a temporary 70 for unimplemented stages (0003) |
| Stage contracts (code) | `src/contracts/` — six schemas, versioned, plus `parseOrDrop` (0005) |
| Config and model routing | `src/config.ts` — role-scoped LLM config, GitHub degraded mode, `.env` loading (0006) |
| `setup.sh`, `./pipeline` | Steps 1–5 done (0004). Step 6, the offline self-verification, waits on 0026 and 0028 |
| Stages 1–3 | Not started — every command exits 70 |
| Sample run, walkthrough video | Not started |

---

## Open decisions

`Default if unanswered` exists so a new session is never blocked. Take the
default, state that you took it, and record it in that session's worklog.

| # | Decision | Blocked on | Default if unanswered |
|---|---|---|---|
| **D-2** | Memo rendering: `eta` templates vs typed TS render functions | Author preference | `eta` — a partner can edit a memo template without reading TypeScript |
| **D-4** | Reflection sections in worklogs 0001 and 0002 | Author. Must not be AI-written — see CLAUDE.md | Leave as `TODO(author)`. Do not fill in |
| **D-5** | Which topic becomes the committed sample run | First real stage-1 output | Pick whichever topic yields the cleanest 10–15 candidates and say why in the worklog |
| **D-6** | Probe threshold `--min-hits` default of 8 | First real stage-1 run | Keep 8 until data contradicts it. It is a guess and is labelled as one |
| **D-7** | Whether ADR-0005 and ADR-0006 clear the "someone would disagree" bar | Author review | Keep both. Revisit only if a reviewer calls the ADR set padded |

### Recently closed

- **D-1 · default model in `.env.example`** — taken at its default in
  TICKET-0001. `MODEL_EXTRACT` and `MODEL_ANALYSE` ship empty with their roles
  named in comments. Worklog 0004 said `setup.sh` would prompt for them;
  TICKET-0004 shipped it naming the four variables to fill in instead — see
  inconsistency 7 below and worklog 0007.
- **D-3 · the `feed` seed form** — cut in TICKET-0002, at its default. The seed
  surface is `topic` and `urls`. Recorded as a consequence in ADR-0004 rather
  than as a new ADR, because it aligns the docs to a decision already accepted.

### Deliberately closed — do not reopen without a new ADR

- **Eval harness** — cut from v1. Cost documented in `SCOPE.md` and `TESTING.md`.
  Do not quietly reintroduce one, and do not claim the rubric is validated.
- **Additional sources** beyond HN and GitHub — ADR-0004.
- **Database, queue, vector store, web UI, agentic browsing** — `SCOPE.md`.
- **LLM-generated scores** — ADR-0002. This one is load-bearing.

---

## Known inconsistencies in the committed docs

Real defects, listed rather than silently patched.

1. ~~**`feed` seed form is unspecified and its example contradicts ADR-0004.**~~
   Fixed in TICKET-0002. `SPEC.md` §3.1 and `ARCHITECTURE.md` §1 and §7 now name
   two seed forms, and ADR-0004 records the cut.
2. ~~**`.env.example` is referenced but does not exist.**~~ Fixed in
   TICKET-0001; `ARCHITECTURE.md` §7.1 step 4 now resolves.
3. **The sample run id is a placeholder** (`<committed_sample>`) in
   `README.md`, `ARCHITECTURE.md`, and `SCOPE.md`. Replace all three once D-5 is
   settled.
4. **Worklog index dangling link.** Commit `1035b1d` lists session 0002 before
   its file exists at `f5e1938`. Transient, one-commit window, left as-is rather
   than rewriting history.
5. **`setup.sh` step 6 cannot pass yet.** Addressed but not closed in
   TICKET-0004: steps 1–5 ship, step 6 does not, and both the script's closing
   output and ARCHITECTURE §7.1 now say so. The check itself still does not
   exist, and SCOPE #11 is not closed until TICKET-0028 adds it.
6. **`docs/worklog/README.md` promises `docs/evals/`** — *"how prompt and rubric
   changes were evaluated … arrives with the first golden set"*. There is no
   golden set and there will not be one; the eval harness was cut (`SCOPE.md`,
   `CLAUDE.md`). Fix the row in TICKET-0029; do not fix it by building evals.
7. **`setup.sh` does not prompt for the model names.** `.env.example` and
   STATE D-1 both said it would. TICKET-0004 shipped step 4 printing the four
   variables that need filling in rather than reading them interactively: a
   prompt that writes an API key into a file is more surface than the problem
   needs, and stage 1 already owns the project's one interactive path
   (SPEC/CLAUDE.md: never without a TTY, never on replay). `.env.example` was
   corrected to match the code. Flagged rather than assumed — if the author
   wants the prompt, it is a small addition to step 4.
8. **`Fact` has a field ARCHITECTURE §2 did not list.** TICKET-0005 added
   `Fact.key` — a stable identifier like `founder.prior_exit` — because the
   sketched shape left `src/analyse/score.ts` with prose as its only handle on
   which fact it was scoring, and a rubric that pattern-matches English is not
   deterministic scoring (ADR-0002). ARCHITECTURE §2 was updated in the same
   commit, so the docs agree; this is listed because it is an addition to a
   spec'd shape, not a transcription of it. The key *vocabulary* is still
   unspecified on purpose and lands with TICKET-0020/0021.
9. **`Analysis` does not yet carry everything a memo needs.** SPEC §4 wants a
   Team/Product/Market/Risks split, a "what would change my mind" list, and a
   checkable upgrade trigger on every Watch — and stage 3 has no LLM to invent
   them (CLAUDE.md invariant 3), so they must come from stage 2. TICKET-0005
   shipped only the fields ARCHITECTURE §2 lists, rather than guessing at the
   rest before any real analysis exists. Resolve at TICKET-0022, before
   TICKET-0024 needs it. Adding fields to `Analysis` then is a `schema_version`
   bump, which is cheap now and not later.
10. **ADR-0006 names three providers; two ship.** Its sketch line reads
    `LLM_PROVIDER=openai | anthropic | ollama`, while its decision paragraph
    names `@langchain/openai` as the default adapter and `.env.example` — the
    file an operator actually reads — says `openai | anthropic`. TICKET-0006
    shipped the two in `.env.example` rather than a third with no adapter behind
    it. Adding `ollama` is a case in the factory (TICKET-0018) and a line in
    `LLM_PROVIDERS`; until then the ADR line is aspirational and is flagged here
    rather than quietly edited.
11. **LLM config is validated per role, not per run.** `requireLlmConfig`
    resolves only the variables the role about to run will read, so
    `./pipeline source` does not fail on a blank `MODEL_EXTRACT` and
    `./pipeline run` can get as far as stage 2 before discovering one is
    missing. Deliberate — "fail late" cuts both ways and `source` is a complete
    command on its own — but if it stings, a preflight check belongs in
    TICKET-0027's `run`, not in `config.ts`.
12. **`ConfigError` has no exit-code mapping yet.** The `--help` epilogue
    promises exit 1 for a configuration error and `ConfigError` is built to be
    caught, but nothing calls `requireLlmConfig` yet, so the handler would guard
    an impossible throw. Lands with TICKET-0018, the first LLM call.

---

## Next session — start here

The work is broken down in **[docs/tickets/](./tickets/)** — 30 tickets derived
from the documents in this directory, in dependency order, each one leaving the
repo runnable. **0001–0006 are done**; resume at
[TICKET-0007](./tickets/0007-ticket-evidence-store.md), the evidence store.

The shape is unchanged from what this section said before the backlog existed:

1. **Scaffold** — tickets 0001–0004. **Done.** Resolved D-1 and D-3.
2. **Zod contracts** — ticket 0005. **Done.** The stage boundary is fixed; two
   places where it is deliberately incomplete are inconsistencies 8 and 9 above.
3. **Stage 1 against live HN** — tickets 0006–0012. **0006 done**; 0007 next.
4. **Stop and hand-check the candidate list before writing a line of stage 2** —
   [TICKET-0013](./tickets/0013-ticket-gate-hand-check-candidates.md). This gate
   is deliberate. Stage 1 gates everything downstream, and the probe threshold
   (D-6) and the usable-vs-unusable classifier can only be validated against real
   output. Record what the junk rate actually was.
5. Capture fixtures from that run — ticket 0014 — so the suite is offline from
   the start.

Do not build stages 2 and 3 speculatively before step 4 reports back.

## Invariants a new session must not break

Full list in [CLAUDE.md](../CLAUDE.md); these are the three that are expensive to
recover from.

1. **Widening yes, narrowing no.** The LLM may decide what to look at (query
   planning). It may never decide what to conclude. Scores, calls, and memo prose
   are never model output. (ADR-0002, ADR-0008)
2. **Every fact carries `evidence_ids`.** Facts without them are dropped at parse
   time, and the memo validator hard-fails on an unresolvable id. (ADR-0003)
3. **Missing data lowers coverage.** It never becomes a zero, a guess, or smooth
   prose. "Unknown" is written as unknown. (SPEC §3)

---

## Submission checklist

The brief asks for a repo plus a ~5 minute walkthrough showing one startup
end-to-end.

- [ ] One command produces memos from a topic
- [ ] Sample run committed — outputs readable without running anything
- [ ] Any memo's call is clear in 60 seconds
- [ ] Any claim traceable to a URL and a retrieval timestamp
- [ ] `pnpm test` passes on a fresh clone with no API key
- [ ] Worklog reflections written by the author (D-4)
- [ ] ~5 min walkthrough video, one startup end-to-end
