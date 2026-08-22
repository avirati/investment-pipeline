# Project State

Last updated: 2026-08-22 · at commit `c6ebd42` · **Phase: specification complete, no code yet**

Read this first when picking the project up. It is the one document that is
allowed to go stale, so update it at the end of every session.

---

## Where things stand

Specification is written and committed across 12 atomic commits. There is no
`src/`, no `package.json`, and no dependency installed. Nothing has been run.

| Area | State |
|---|---|
| Thesis and rubric | Written, **unvalidated against any real company** |
| Architecture and stage contracts | Written, unimplemented |
| ADRs 0001–0008 | Written |
| Test strategy | Written, no tests exist |
| Worklogs 0001–0002 | Factual sections written; reflections pending (see D-4) |
| Scaffold, `setup.sh`, `./pipeline` | Not started |
| Stages 1–3 | Not started |
| Sample run, walkthrough video | Not started |

---

## Open decisions

`Default if unanswered` exists so a new session is never blocked. Take the
default, state that you took it, and record it in that session's worklog.

| # | Decision | Blocked on | Default if unanswered |
|---|---|---|---|
| **D-1** | Default model in `.env.example` | What the author's OpenAI account has access to | Leave the value empty with a comment naming the two roles (`MODEL_EXTRACT`, `MODEL_ANALYSE`); `setup.sh` prompts for it |
| **D-2** | Memo rendering: `eta` templates vs typed TS render functions | Author preference | `eta` — a partner can edit a memo template without reading TypeScript |
| **D-3** | The `feed` seed form (`--seed yc:w25`) | See *Known inconsistencies* below | **Cut it.** Support `topic` and `urls` only, and remove `feed` from the CLI and SPEC |
| **D-4** | Reflection sections in worklogs 0001 and 0002 | Author. Must not be AI-written — see CLAUDE.md | Leave as `TODO(author)`. Do not fill in |
| **D-5** | Which topic becomes the committed sample run | First real stage-1 output | Pick whichever topic yields the cleanest 10–15 candidates and say why in the worklog |
| **D-6** | Probe threshold `--min-hits` default of 8 | First real stage-1 run | Keep 8 until data contradicts it. It is a guess and is labelled as one |
| **D-7** | Whether ADR-0005 and ADR-0006 clear the "someone would disagree" bar | Author review | Keep both. Revisit only if a reviewer calls the ADR set padded |

### Deliberately closed — do not reopen without a new ADR

- **Eval harness** — cut from v1. Cost documented in `SCOPE.md` and `TESTING.md`.
  Do not quietly reintroduce one, and do not claim the rubric is validated.
- **Additional sources** beyond HN and GitHub — ADR-0004.
- **Database, queue, vector store, web UI, agentic browsing** — `SCOPE.md`.
- **LLM-generated scores** — ADR-0002. This one is load-bearing.

---

## Known inconsistencies in the committed docs

Real defects, listed rather than silently patched.

1. **`feed` seed form is unspecified and its example contradicts ADR-0004.**
   `ARCHITECTURE.md` §7 advertises `--seed yc:w25`, and `SPEC.md` §3.1 names
   three seed forms — but no feed adapter is specified anywhere, and ADR-0004
   explicitly *rejected* the YC directory as a source. Resolve via **D-3**;
   cutting it is the likely answer.
2. **`.env.example` is referenced but does not exist.** `ARCHITECTURE.md` §7.1
   step 4 depends on it. Create it with the scaffold.
3. **The sample run id is a placeholder** (`<committed_sample>`) in
   `README.md`, `ARCHITECTURE.md`, and `SCOPE.md`. Replace all three once D-5 is
   settled.
4. **Worklog index dangling link.** Commit `1035b1d` lists session 0002 before
   its file exists at `f5e1938`. Transient, one-commit window, left as-is rather
   than rewriting history.

---

## Next session — start here

1. **Scaffold.** `package.json`, `tsconfig`, `biome`, `vitest`, `.env.example`,
   `setup.sh`, `./pipeline`. Resolve D-1 and D-3 while doing it.
2. **Zod contracts** in `src/contracts/` — `QueryPlan`, `Candidate`, `Evidence`,
   `Fact`, `Analysis`. These are the stage boundary; get them right before any
   stage logic exists.
3. **Stage 1 against live HN.** Query planning (probe first), then fetch,
   resolve, dedup.
4. **Stop and hand-check the candidate list before writing a line of stage 2.**
   This gate is deliberate. Stage 1 gates everything downstream, and the probe
   threshold (D-6) and the usable-vs-unusable classifier can only be validated
   against real output. Record what the junk rate actually was.
5. Capture fixtures from that run so the test suite is offline from the start.

Do not build stages 2 and 3 speculatively before step 4 reports back.

---

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
