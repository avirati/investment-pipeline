# TICKET-0028 — Commit the sample run and close `setup.sh`

Status: **Done** — [worklog 0040](../worklog/0040-sample-run-and-hand-check.md), commit `2adb8be`. Inconsistency 84 was settled first, as [ADR-0009](../adr/0009-bundles-as-artifacts.md), and the replay was **measured** with `.cache/http/` moved out of the tree: 12 unchanged memos, byte-identical analyses, 54ms, zero requests · Depends on: 0004 (Done), 0013 (Done), 0023 (**still Ready — see below**), 0027 (Done) · Blocks: 0029
Reads: [SCOPE](../SCOPE.md) in-scope #8, [ARCHITECTURE §7.1](../ARCHITECTURE.md#71-setup-and-the-wrapper-script), [STATE](../STATE.md) inconsistency #3 and D-5

## Why

The reviewer never has to obtain an API key. This ticket is what makes that
sentence true, and it closes the three placeholder `<committed_sample>` ids left
in the docs.

## Scope

- Run the topic chosen at TICKET-0013 (**D-5**) end-to-end and commit the
  artifacts: `runs/<run_id>/` (manifest, query_plan, candidates, evidence,
  analyses), `memos/<run_id>/`, and `.cache/llm/`.
- Confirm the `.gitignore` split is right: normalised evidence and the LLM cache
  are committed; raw HTTP bodies are not.
- Add **step 6** to `setup.sh` — `./pipeline memo --run <run_id>` — the offline
  self-verification deferred from TICKET-0004. Remove its `TODO(0028)`.
- Replace the `<committed_sample>` placeholder in `README.md`,
  `ARCHITECTURE.md`, and `SCOPE.md` with the real run id (STATE inconsistency #3).
- **Read the memos by hand.** Then record, honestly:
  - Is any memo's call clear in 60 seconds?
  - Did candidates cluster in the middle two bands of every dimension? That is
    the predicted symptom of unvalidated rubric bands (ADR-0002, TICKET-0021).
    If it happened, say so — do not quietly re-tune the bands and omit it.
  - Spot-check a sample of facts against their evidence records by hand and
    record the result (SCOPE risks table commits to exactly this).

## Acceptance

- Fresh clone → `./setup.sh` → all six steps pass with **no API key**.
- `grep -rn "committed_sample" . --exclude-dir=.git` returns nothing **in the
  live documents** — README, ARCHITECTURE and `setup.sh`. It still returns two
  hits in `docs/worklog/0006` and `0007`, and they stay: those sentences were
  true when they were written, and the worklog README says entries are left
  unedited except for explicit `Correction:` notes. Rewriting history to make a
  grep pass is the opposite of what the trail is for.
- The hand-check findings are written into a worklog entry, including anything
  that looked wrong.

## Closed with a dependency outstanding

**TICKET-0023 (missing-data path tests) is still Ready.** The author's call was
to proceed and flag it rather than add a fourth ticket to the session. The live
run did exercise the missing-data paths — three candidates uncovered on D3, two
on D1, one at 60% coverage, and every one of them written as "unknown" rather
than as a zero — but exercising a path once is not pinning it, and 0023 stays
open.

## What the hand-check found

Written up in full in [worklog 0040](../worklog/0040-sample-run-and-hand-check.md).
The three answers this ticket asked for, in one line each:

- **Call clear in 60 seconds?** Yes. Header plus "Why this call" carries it.
- **Did candidates cluster in the middle bands?** Yes, for three of five
  dimensions, and **D4 "Why now" is degenerate** — eleven of twelve score 15/15,
  because its top band asks for a stated launch date and every Show HN candidate
  has one by construction. Reported, not re-tuned (ADR-0002).
- **Fact spot-check?** Six of six sampled facts supported verbatim by their
  cited record. No fabricated citation; 42 of 42 citations resolved.

And one finding the ticket did not ask for: **`ardent` is called wrongly.** A
disqualifier fired saying nothing the founders built appears in the evidence,
two sections above a Team bullet quoting twelve years of prior experience from
the record it cites. The extractor filed it under the wrong key. Inconsistency 97.
