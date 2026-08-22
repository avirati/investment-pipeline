# TICKET-0010 — URL resolution, canonicalisation, dedup (`src/source/resolve.ts`)

Status: Blocked · 0008 · Depends on: 0008 · Blocks: 0012
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
