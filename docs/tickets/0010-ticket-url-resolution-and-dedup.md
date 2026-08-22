# TICKET-0010 — URL resolution, canonicalisation, dedup (`src/source/resolve.ts`)

Status: **Done** — worklogs [0017](../worklog/0017-url-canonicalisation-and-dedup.md) and [0018](../worklog/0018-redirect-resolution.md) · Depends on: 0008 (Done) · Blocks: 0012
Reads: [TESTING §3](../TESTING.md), [SCOPE](../SCOPE.md) in-scope #1, risks table

## Why

TESTING calls this "classic quiet-bug territory" and it is right. Two HN posts
about one company silently becoming two candidates costs a duplicate analysis, a
duplicate LLM spend, and a reviewer's confidence.

## Scope

- Post URL → company site resolution, following redirects through the fetch layer.
- Canonicalisation: `www.` prefix, trailing slash, `http`→`https`, `utm_*` and
  `ref` params, subdomain vs apex, trailing `index.html`.
- Dedup by canonical domain, keeping the strongest signal (highest points, or
  earliest post — pick one, state which, and say why in a comment).
- Reject-with-reason for personal domains and non-company surfaces, feeding the
  same audit trail as TICKET-0009's classifier.

## Acceptance

Table-driven tests per TESTING §3, covering every listed canonicalisation case.
Two fixture HN posts pointing at the same company collapse to one `Candidate`
whose provenance records both posts.

## Outcome

`src/source/resolve.ts`, 58 tests. Two halves:

- **Pure** — `canonicaliseUrl`, `registrableDomain`, `siteKey`, `classifySite`,
  `dedupeHits`. Every canonicalisation case TESTING §3 lists is a table row.
- **Network** — `resolveSites` follows each deduped site's url through
  `httpGet`, re-keys it on where it landed, and merges groups that now collide.

Two departures from the ticket text, both recorded in the worklogs:

1. **The strongest signal is highest points, earliest post breaking the tie.**
   The ticket asked for one, stated and justified; see worklog 0017.
2. **The output is a `ResolvedSite`, not a `Candidate`.** `Candidate.provenance`
   is a single object and cannot record two posts, so the group carries them and
   TICKET-0012 — which writes `candidates.jsonl` — decides whether the fix is
   `provenance: Provenance[]` or an `also_seen` field, with the `schema_version`
   bump that implies. Logged as STATE inconsistency 25.
