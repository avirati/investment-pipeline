# TICKET-0028 — Commit the sample run and close `setup.sh`

Status: Blocked · 0013, 0023, 0027 · Depends on: 0004, 0013, 0023, 0027 · Blocks: 0029 · **Carries STATE inconsistency 84**: with a run committed, `--replay` from a fresh clone overwrites its analyses with empty ones (measured, worklog 0034). Settle that before committing the real sample run
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
- `grep -rn "committed_sample" . --exclude-dir=.git` returns nothing.
- The hand-check findings are written into a worklog entry, including anything
  that looked wrong.
