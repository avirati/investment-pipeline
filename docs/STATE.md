# Project State

Last updated: 2026-08-22 · at commit `3cdac0f` · **Phase: CLI skeleton runs; no stage logic yet**

Read this first when picking the project up. It is the one document that is
allowed to go stale, so update it at the end of every session.

---

## Where things stand

Specification is written and committed. The toolchain installs, all three gates
pass, and `./pipeline --help` is real — but every command still exits 70, so
nothing has been run end to end. Tickets 0001–0003 are done.

| Area | State |
|---|---|
| Thesis and rubric | Written, **unvalidated against any real company** |
| Architecture and stage contracts | Written, unimplemented |
| ADRs 0001–0008 | Written |
| Test strategy | Written; first suite exists — 17 CLI tests, offline, no key (0003) |
| Worklogs 0001–0006 | Factual sections written; reflections pending (see D-4) |
| Ticket backlog | [docs/tickets/](./tickets/) — 30 tickets, 3 done |
| Toolchain | `pnpm install/test/typecheck/lint` all pass, offline, no key (0001) |
| CLI surface | `src/cli.ts` — four commands, flags and `--help` pinned and tested (0003) |
| Exit codes | `src/exit-codes.ts` — 0/1/2/3, plus a temporary 70 for unimplemented stages (0003) |
| `setup.sh`, `./pipeline` | Not started — next is 0004 |
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
  named in comments; `setup.sh` prompts. Worklog 0004.
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
5. **`setup.sh` step 6 cannot pass yet.** ARCHITECTURE §7.1 verifies a fresh
   install by re-rendering the committed sample run with
   `./pipeline memo --run <committed_sample>`. `memo` exits 70 until TICKET-0026,
   and there is no sample run until TICKET-0028. TICKET-0004 has to say what the
   script does in the meantime rather than shipping a step that always fails.
6. **`docs/worklog/README.md` promises `docs/evals/`** — *"how prompt and rubric
   changes were evaluated … arrives with the first golden set"*. There is no
   golden set and there will not be one; the eval harness was cut (`SCOPE.md`,
   `CLAUDE.md`). Fix the row in TICKET-0029; do not fix it by building evals.

---

## Next session — start here

The work is broken down in **[docs/tickets/](./tickets/)** — 30 tickets derived
from the documents in this directory, in dependency order, each one leaving the
repo runnable. **0001–0003 are done**; resume at
[TICKET-0004](./tickets/0004-ticket-setup-script-and-wrapper.md), `setup.sh` and
the `./pipeline` wrapper.

The shape is unchanged from what this section said before the backlog existed:

1. **Scaffold** — tickets 0001–0004. Resolved D-1 and D-3; 0004 remains.
2. **Zod contracts** — ticket 0005. The stage boundary; get it right before any
   stage logic exists.
3. **Stage 1 against live HN** — tickets 0006–0012.
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
