# TICKET-0015 — GitHub adapter (`src/evidence/github.ts`)

Status: **Done** — `src/evidence/github.ts`, 82 tests ([worklog 0027](../worklog/0027-github-adapter.md)) · Depends on: 0008 (Done), 0014 (Done) · Blocks: 0017
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

## Outcome

`gatherGithub(ref)` reads up to five endpoints and returns evidence records,
dated `Signal`s and a reason for every metric it could not produce. Both
acceptance criteria hold: an org that does not exist yields a `fetch_failed`
record and no throw, rate limiting stays the fetch layer's policy, and `add` is
the only way a metric leaves the module — so an undateable one becomes an
`unknown` rather than a number.

Three departures from the scope above, each argued in
[worklog 0027](../worklog/0027-github-adapter.md):

- **"star velocity" ships as `stars_per_day_lifetime`.** A rate needs two
  observations; GitHub charges per hundred stars for the second.
- **No third-party integration keyword list.** That is a rubric, and the thesis
  lives in one place (CLAUDE.md invariant 7). The README text and the topics are
  in the bundle for TICKET-0020 to read.
- **No per-contributor profile fetch.** The contributor list gives logins and
  commit counts in one request; a profile each is N more against a 60/hour
  budget, for a signal the company's own team page carries better (TICKET-0016).

Degraded mode became a request budget rather than a note: without `GITHUB_TOKEN`
the adapter reads two endpoints per candidate, because five against `--limit 12`
is exactly the unauthenticated hourly limit.
