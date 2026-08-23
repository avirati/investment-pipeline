# Session 0041 — 2026-08-23 — Docs closeout, and two defects the closeout found

[TICKET-0029](../tickets/0029-ticket-docs-closeout.md). The ticket calls itself
"the sweep for what drifted, not a writing session", and that was mostly right —
but the sweep found two live defects, both on the path a reviewer is told to
walk, and both cheaper to fix than to document.

## What I asked for

Complete tickets 27, 28 and 29 in one go, stopping for review. Ticket 30 later.

## What the sweep changed

| Document                 | Change                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/STATE.md`          | Phase rewritten. Inconsistencies 3, 5, 70, 84 and 96 struck; 96–99 added; 87 annotated with the committed artifact that now shows it. Next-session section replaced with four ranked items. Submission checklist walked. Attribution table added. |
| `README.md`              | "Status: specification" banner removed. Sample run id, ADR count and ticket count corrected. `--replay` documented as a three-stage command. A warning added above the memos link.                                                                |
| `docs/SPEC.md`           | §5's eight acceptance boxes ticked — each one checked rather than assumed — with what they _do not_ say written underneath.                                                                                                                       |
| `docs/ARCHITECTURE.md`   | Exit code 70 removed from the pasted `--help`. Seven contracts, not six. `bundles/` in §4. The replay rules.                                                                                                                                      |
| `docs/worklog/README.md` | ADR count. The `docs/evals/` row now says there is no eval harness instead of promising one.                                                                                                                                                      |
| `docs/worklog/0014`      | A `Correction:` note — see below.                                                                                                                                                                                                                 |
| `prompts/CHANGELOG.md`   | Checked, unchanged. Two prompts, both still v1, both with entries. Nothing was revised, which is itself the finding.                                                                                                                              |

## Three things worth reading

**1 — `pnpm test` was not the only thing that had to pass.** I walked SPEC §5
item by item rather than ticking from memory, and one item turned out to be
checkable in a way I had not expected: _"recompute any score by hand from the
analysis JSON and this rubric."_ All twelve recompute exactly — every total is
the sum of its five dimension scores, every coverage is covered-dimensions over
five, and every call follows from §3's three thresholds (72 / 55 / 0.6) plus the
disqualifier override. That is now a checked claim rather than a design
intention.

Two boxes are left **unticked on purpose**: the author's worklog reflections
(D-4, and CLAUDE.md is explicit that ghostwriting them is penalised) and the
walkthrough video (TICKET-0030). The checklist says an unticked box is a better
artifact than a ticked one that is not true; that goes for these two.

**2 — One internal link does not resolve, deliberately.** Walking every relative
link in the repo found exactly one broken: `docs/worklog/0014` points at
`tests/fixtures/hn/README.md`, which was never written — the `curl` commands
went to `tests/fixtures/README.md` one level up, and the capture became a script
at TICKET-0014. The worklog README says entries are left unedited except for
explicit `Correction:` notes, so the sentence stays and a correction sits under
it. TICKET-0029's acceptance says every internal link resolves; this one does
not, and rewriting a worklog to make a `grep` pass is the opposite of what the
trail is for.

**3 — The closeout found two defects and fixed them, which the ticket did not
anticipate.** While rewriting the README's quickstart I documented the replay as
a three-stage command and then ran it to check the output. `git status` showed
`runs/…/manifest.json` modified: **the documented command for reproducing a
committed run was damaging that run's manifest every time it ran.** Stage 2 and
`run` were overwriting `stages.analyse` and `stages.run` with the replay's
numbers, so the gather's request spend became `budget: null` and 45.5s of stage
timings became 54ms.

This had been logged an hour earlier as inconsistency 96, to be fixed later. It
stopped being "later" when it turned out to be on the path a reviewer is told to
walk. The fix is smaller than either option 96 proposed: a replay writes
`stages.analyse_replay` and `stages.run_replay` **beside** the records it
reproduces, never over them. No rule is needed about which fields a replay may
keep, and a reader gets the run and the replay of it, both dated. Stage 3 is
unchanged — a re-render genuinely is this invocation's work. +2 tests.

**And then the same defect one layer down.** With that fixed, `./setup.sh` still
left a dirty tree: step 6 re-renders the committed sample run, writes nothing
(all twelve memos unchanged), and rewrote `stages.memo`'s two timestamps anyway.
A reviewer's first `git status` after setup would show a committed artifact
modified, on a step whose entire point is that nothing needs to happen. Stage 3
now leaves the record alone when `written === 0` and a record already exists —
the same rule, third application. `./setup.sh` is idempotent in the working tree
as well as on disk now, which is what the script's first comment line already
claimed. +2 tests (1062).

## What was checked and left alone

- **No new ADR was needed beyond ADR-0009.** TICKET-0029 names three candidate
  triggers: the probe threshold moving, the rubric bands being re-tuned, and
  LangChain being dropped. **None of the three happened.** D-6 kept `--min-hits
8` on measurement, the bands were deliberately not re-tuned after the
  hand-check (inconsistency 99), and the provider seam is still LangChain
  (ADR-0006). Writing an ADR for a decision that was not made would be padding,
  which `docs/adr/README.md` explicitly forbids.
- **No eval harness has quietly appeared.** `docs/evals/` does not exist and
  nothing claims the rubric is validated. `docs/worklog/README.md` used to
  promise `docs/evals/` "with the first golden set"; that row now says there is
  no harness and points at where the cut is recorded.
- **`prompts/CHANGELOG.md` needed no entry**, because no prompt was revised.
  Both are still v1. Given that inconsistencies 85 and 97 are both the
  extraction prompt filing content under the wrong key, "no revision happened"
  is the most useful thing that file says right now.

## Attribution

The sweep, the link walk, the score recomputation and the manifest fix were
**assistant-executed**. The judgement calls — leaving two boxes unticked,
leaving the broken link with a correction rather than editing history, not
writing ADRs for decisions that were not made — were put to me as choices with
their reasoning and I took them as recommended. The attribution table in
`STATE.md` is assistant-drafted from the per-session Attribution sections and
checked by me against them.

## Reflection

The pipeline works end to end. The cache and memo is being written for each run, which is expected. For some queries, the tool outright declines to run, because of no results, also expected. The next step is a bit of cleanup, as a bunch of files are bloated (some with excessive documentation).
