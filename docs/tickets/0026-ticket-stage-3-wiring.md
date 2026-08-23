# TICKET-0026 — Stage 3 wiring: `./pipeline memo`

Status: **Blocked** · 0025 — 0024 is Done. The renderer takes an evidence array; reading `runs/<id>/evidence/` and writing `memos/<slug>.md` is this ticket's · Depends on: 0003, 0024 (Done), 0025 · Blocks: 0023, 0027, 0028
Reads: [ARCHITECTURE §1, §4](../ARCHITECTURE.md), [SPEC §5](../SPEC.md#5-acceptance-criteria)

## Why

The command a reviewer runs with no API key and no network. It is also step 6 of
`setup.sh`, so its offline guarantee has to be real rather than nearly real.

## Scope

- `./pipeline memo --run <run_id>` reads `analyses/*.json` → render → validate →
  `memos/<run_id>/<slug>.md`.
- **Zero network, zero API calls.** Enforced in a test, not just intended.
- Validator failure aborts with a non-zero exit and names what failed.
- Snapshot test per TESTING §7: one golden analysis → one golden memo, so
  template changes show up as a reviewable diff.

## Acceptance

- Runs to completion with `.env` absent, no key configured, and the network down.
- Snapshot test passes and the snapshot is committed.
- Re-running is idempotent — same analyses in, byte-identical memos out.
