# TICKET-0019 — Extraction prompt and `prompts/CHANGELOG.md`

Status: Open · Depends on: 0005, 0017 · Blocks: 0020
Reads: [CLAUDE.md](../../CLAUDE.md) conventions and invariant 7, [ADR-0003](../adr/0003-evidence-store-and-citations.md), [SCOPE](../SCOPE.md) eval-harness cut

## Why

Prompts live in `prompts/` as versioned files, never inline in TypeScript. And
with no eval harness in v1, `prompts/CHANGELOG.md` is the *only* record of why a
prompt changed and what happened after — SCOPE promises this explicitly and calls
it weaker evidence than a labelled set. It is worth nothing if it is written
retroactively.

## Scope

- `prompts/extract.v1.md` — evidence bundle in, facts out.
- The prompt asks for **facts only**. Never scores, never a call, never memo
  prose (ADR-0002).
- It must require an `evidence_ids[]` on every fact and state that ids outside
  the supplied bundle are invalid.
- **Do not restate the thesis as free text in the prompt** (CLAUDE.md invariant
  7 — the thesis lives only in `src/analyse/score.ts`). The prompt asks for the
  observable facts the rubric consumes; it does not tell the model what a good
  company looks like. This is the subtle failure mode: a prompt that leaks the
  rubric turns the model back into the scorer through the back door.
- A `prompt_version` constant that feeds the cache key.
- `prompts/CHANGELOG.md` entry per revision, saying **why** it changed and what
  it did to outputs. First entry lands with v1.

## Acceptance

- `grep -rn "prompt" src/ --include=*.ts` shows prompts loaded from files, not
  string literals.
- The prompt file contains no thesis restatement and no scoring language — check
  by hand and note the check in the CHANGELOG entry.
