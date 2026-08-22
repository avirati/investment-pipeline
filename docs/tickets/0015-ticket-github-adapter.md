# TICKET-0015 — GitHub adapter (`src/evidence/github.ts`)

Status: Blocked · 0008, 0014 · Depends on: 0008, 0014 · Blocks: 0017
Reads: [ADR-0004](../adr/0004-source-selection.md), [SCOPE](../SCOPE.md) in-scope #2, [SPEC §2](../SPEC.md) D1/D3/D5

## Why

The primary enrichment surface, and the evidence behind three of the five
dimensions: technical depth (D1), pull (D3), and the accumulating-asset read (D5).

## Scope

- Resolve a candidate to a GitHub org or repo. Best-effort — failure is not an
  error (ARCHITECTURE §5).
- Capture what the rubric actually consumes: stars and star velocity, forks,
  commit cadence, contributor count, licence, repo age, topics, README text,
  third-party integration signals.
- **Everything dated.** SPEC D3 scores undated claims at 0, so an undated signal
  is worse than useless — it is a trap. Carry timestamps on every metric.
- Contributor profiles for founder signal, within what the API gives free.
- Unauthenticated by default; `GITHUB_TOKEN` raises limits. Degraded mode must be
  visible in the manifest, not silent.
- Writes `Evidence` records via TICKET-0007's store. No direct `fetch`.

## Acceptance

- Tests against committed fixtures: org with repos parses; org that does not
  exist yields no evidence and no throw; rate-limit response is handled by the
  fetch layer's policy, not re-implemented here.
- Every emitted metric carries a date or is dropped.
