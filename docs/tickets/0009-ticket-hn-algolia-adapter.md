# TICKET-0009 — HN Algolia adapter (`src/source/hn.ts`)

Status: Blocked · 0008 · Depends on: 0008 · Blocks: 0011, 0012
Reads: [ADR-0004](../adr/0004-source-selection.md), [TESTING §4](../TESTING.md), [SCOPE](../SCOPE.md) in-scope #1

## Why

The primary source. ADR-0004 is explicit that "depth on HN" is the deliverable,
not "an HN call" — date windows, pagination, expansion phrasings, points and
comment counts carried through as a dated D3 signal.

## Scope

- Query HN Algolia: date-windowed (`--since`), paginated past page 1, tag
  filters. **Filters are always chosen by code from CLI flags, never by the
  model** (ADR-0008 — non-negotiable split).
- Query expansion across `Show HN` / launch / funding phrasings, deterministic
  and hand-written. Distinct from LLM clarification (TICKET-0011).
- Carry `points`, `num_comments`, `created_at`, `objectID` through — they are the
  dated traction signal D3 depends on, not metadata to discard.
- The **usable-vs-unusable classifier**: a hit is usable when it resolves to a
  company site rather than a blog, paper, or personal domain. The probe threshold
  (TICKET-0011) is defined in terms of this, so it lives here and is tested here.
- Rejections carry a recorded reason (ADR-0004: the filter must be auditable).
- Commit fixtures: result pages, an empty result set, posts with null URLs
  (Ask HN), malformed timestamps.

## Acceptance

Per TESTING §4, offline against committed fixtures:
- Pagination assembles multiple pages; an empty result set returns `[]`, not a
  throw; null-URL posts are classified unusable with a reason; malformed
  timestamps do not crash the parse.
- Classifier tests cover at least one each of: company site, personal blog,
  paper/PDF, GitHub-only project.
- `pnpm test` passes with no network and no key.
