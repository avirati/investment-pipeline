# ADR-0004 — Source selection: Hacker News + GitHub

Status: Accepted · 2026-08-22

## Context

The brief says to pick one or two sources and go deep, and names shallow
multi-source coverage as an anti-pattern. We need 10–20 candidates with a name,
site, one-liner, team signal, and at least one freshness or traction signal.

## Options considered

| Source | Access | Signal | Verdict |
|---|---|---|---|
| **HN via Algolia** | Free, no key, no auth | Show HN launches, points, comments, dated. Strong freshness *and* traction in one call | **Primary** |
| **GitHub REST** | Free, generous with a token | Technical depth, adoption velocity, contributor count, licence, commit cadence | **Secondary** |
| Company website | Free | Founders, positioning, customers | Enrichment, not a source |
| Product Hunt | OAuth app + rate limits | Launch traction, consumer-skewed | Rejected |
| YC directory | Scrapable, unstable | Clean metadata, but a whole batch launches at once so freshness stops discriminating | Rejected |
| Crunchbase | Paid | Funding | Rejected — out of budget |
| Twitter/X | Paid, unusable free tier | Founder signal | Rejected |
| LinkedIn | Against ToS | Team background | Rejected |

## Decision

HN Algolia as the sourcing surface, GitHub as the primary enrichment surface,
company site as secondary enrichment.

Depth on HN means: date-windowed queries, pagination past the first page, query
expansion across `Show HN` / launch / funding phrasings, canonical-domain dedup,
post-to-company-site resolution, and carrying points and comment counts through
as a dated traction signal rather than discarding them.

## Consequences

**Good.** Both sources are free and keyless-or-nearly, so a reviewer can run the
pipeline without procuring anything. They match the thesis precisely — a thesis
about developer adoption should be measured where developers actually show up.
Every candidate arrives with a dated traction signal by construction, so D3 is
never empty.

**Bad and worth stating plainly.** This inherits HN's biases wholesale:
English-speaking, US-skewed, developer-tools-heavy, and systematically blind to
companies that launch quietly or sell top-down. For this thesis that overlap is
mostly a feature — but it is a real blind spot, not a neutral one, and any claim
that this pipeline "finds the best startups" would be false. It finds the best
startups *that surface on HN*.

**Consequence realised later.** The CLI as first specified offered a
`--seed yc:w25` feed form, which promised exactly the source this ADR rejected.
The seed form was cut rather than the ADR reopened (TICKET-0002, D-3); the seed
surface is now `topic` and `urls` only.

**Bad.** HN returns projects and blog posts alongside companies. Filtering is
heuristic (site resolves, has a product surface, not a personal domain) and will
have both false positives and false negatives. Rejections are recorded with a
reason so the filter is auditable.

## Revisit if

Candidate yield drops below 10 for reasonable topics, or the fund's thesis moves
away from bottom-up developer adoption. `src/source/` is an adapter interface, so
a third source is a contained addition — it is just not this version's work.
