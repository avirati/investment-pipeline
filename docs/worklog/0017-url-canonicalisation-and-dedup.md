# Session 0017 — 2026-08-22 — URL canonicalisation and dedup

The pure half of [TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md),
the other Ready ticket on the path to the gate. TESTING §3 calls this "classic
quiet-bug territory": two HN posts about one company silently becoming two
candidates costs a duplicate analysis, a duplicate LLM spend, and — because
nothing in the output says it happened — a reviewer's confidence. The redirect-
following half of the ticket is still open.

## What I asked for

_"Continue implementation, stop for me to review changes, keep commits / changes
small and easy to review."_ 0010 and 0011 were both Ready; 0010 was taken first
because it is the smaller of the two and because its pure half needs no
transport, so it lands as one reviewable commit with no network surface.

## What the AI produced

New `src/source/resolve.ts` (~330 lines) and `tests/resolve.test.ts` (48 tests,
211 in the suite).

| Export                                    | What it is                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `canonicaliseUrl(raw)`                    | One url → `{ canonical_url, host, domain, path, key }`, or `null`             |
| `registrableDomain(host)`                 | `docs.acme.co.uk` → `acme.co.uk`; `alice.github.io` → `alice.github.io`       |
| `siteKey(host, path)`                     | What two urls are compared on — a domain, or `host/owner/repo` on a code host |
| `classifySite(site)`                      | The rejections only this layer can reach: personal, link-in-bio, academic     |
| `dedupeHits(hits)`                        | `SourcedHit[]` → `{ sites: ResolvedSite[], rejected: RejectedHit[] }`         |
| `TRACKING_PARAMS`, `SHARED_SUFFIXES`, `PERSONAL_HOSTS` | The lists, exported so 0013 can argue with them in one place     |

`dedupeHits` calls `classifyHit` from `hn.ts` first rather than reimplementing
"unusable", so there is still one definition of it and this layer only ever
*adds* rejections. Every rejection carries the same `{ kind, reason }` pair the
url classifier produces, so both feed one audit trail.

## Four judgement calls, in descending order of how much they need review

**1. A code host keys on the repo, not the owner.** `github.com/acme/one` and
`github.com/acme/two` stay two candidates even though an org is usually one
company. The asymmetry is the same one `classifyHit` is built around, pointed
the other way: a wrong *split* costs one duplicate analysis that a human sees in
the memo list, while a wrong *collapse* deletes a company and leaves no trace
anywhere. Org-level collapse is a call TICKET-0013 can make against real data.
The join this layer structurally cannot make is `acme.dev` ↔
`github.com/acme/acme` — nothing in either url says they are the same thing, and
the GitHub adapter (0015) reads the repo's homepage field, which is where it
belongs.

**2. `SHARED_SUFFIXES` is a hand-written stand-in for the public suffix list.**
The real list is a runtime dependency and a megabyte of data (no new dependency
without an ADR line — CLAUDE.md). It carries two kinds of entry for one reason —
multi-part ccTLDs (`co.uk`) and shared deploy hosts (`github.io`, `vercel.app`)
both mean "one more label is needed to identify the owner". The cost: an
unlisted ccTLD collapses two unrelated companies into one candidate, which is
call 1's dangerous direction. The list therefore leans long.

**3. Highest points wins, earliest post breaks the tie.** The ticket asked for
one or the other, stated and justified. Points, because they are the traction
signal SPEC §2's D3 reads and the top-scoring thread is the one with the most
discussion to mine later — picking the earliest instead would routinely let a
five-point pre-launch teaser represent a company whose Show HN hit 400. A post
with no score sorts below one with a score; that is a ranking decision and not a
substituted zero — nothing writes `0` anywhere and the null survives into the
output (there is a test asserting exactly that).

**4. Deploy hosts are not "personal domains".** `PERSONAL_HOSTS` is
`about.me`-shaped only. `vercel.app`, `netlify.app` and `pages.dev` are
deliberately accepted, because a seed-stage company genuinely does launch from
one and rejecting it is invisible loss. Tilde user directories (`/~jane`) and
academic hosts (`.edu`, `.ac.uk`) are rejected with a reason.

## What the record should be honest about

**`ref` is dropped and that is a guess with teeth.** A site that gives `ref` a
load-bearing meaning has two distinct pages collapse to one here. Nothing in the
fixtures does, and keeping it means the same launch posted twice with different
referrer tags becomes two candidates — the exact failure this ticket exists to
prevent. Named in the code, not buried.

**Every host and parameter list is seeded from one topic's fixtures**, same
caveat as `hn.ts`'s classifier lists (inconsistency 20). They are exported
constants for that reason.

**`ResolvedSite` is not a `Candidate`.** The ticket's acceptance line says two
posts "collapse to one `Candidate` whose provenance records both posts", but
`Candidate.provenance` in `src/contracts/candidate.ts` is a single object, not a
list — so the contract as written cannot record both. This session produced the
group (`ResolvedSite.posts`, primary first, never empty) and left the contract
alone: TICKET-0012 is what writes `candidates.jsonl`, and whether the fix is
`provenance: Provenance[]` or an `also_seen` field is its decision plus a
`schema_version` bump. Logged as inconsistency 25 in STATE rather than resolved
by guessing here.

## Verification

- `pnpm test` — **211 passed** (163 before; +48 here: 17 table-driven
  canonicalisation rows covering every case TESTING §3 lists, 4 null/scheme
  rejections, 8 `registrableDomain` rows, 4 `siteKey` rows, 6 `classifySite`, 11
  `dedupeHits` including the two-posts-one-company collapse, the primary-post
  ranking, the null-points rule and empty-in-empty-out). Offline, no key.
- `pnpm typecheck` and `pnpm lint` clean.

## What went wrong

Two self-inflicted: a port-normalisation expression written as a double-negated
XOR that was unreadable and wrong for `https://host:80`, replaced with the one
case that actually needs handling (`:443`, the default port of the scheme this
function normalises to); and a canonical url that emitted `https://acme.dev?a=1`
with no `/`, which parses identically and reads like a typo.

## Decisions taken

None. No open decision in STATE was touched; four new judgement calls are listed
above and one new inconsistency (25) is recorded.

## Attribution

`src/source/resolve.ts` and all 48 tests are AI-written end-to-end. All four
judgement calls above were made by the AI. Calls 1 and 2 are the ones with
consequences past this file.

## Reflection

TODO(author) — worth a line on whether repo-level keying is the right call, and
on the `Candidate.provenance` plurality question before 0012 answers it by
default.

## Next

The second half of TICKET-0010: post url → company site through `httpGet`,
following redirects, so a link-shortener or a `launch.acme.dev` vanity domain
canonicalises to what it actually lands on. Then
[TICKET-0011](../tickets/0011-ticket-query-planning.md)'s probe, and 0012 needs
both.
