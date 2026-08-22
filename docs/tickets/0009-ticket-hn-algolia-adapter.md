# TICKET-0009 — HN Algolia adapter (`src/source/hn.ts`)

Status: **Reopened** — the original scope is Done; the 0013 gate returned two scoped fixes and a third arrived from TICKET-0010, see *Reopened* below. Query building and hit parsing in [worklog 0014](../worklog/0014-hn-query-and-parse.md), the usable-vs-unusable classifier in [worklog 0015](../worklog/0015-hn-usable-classifier.md), the paginated `searchHn` over `httpGet` in [worklog 0016](../worklog/0016-hn-paginated-search.md) · Depends on: 0008 (Done) · Blocks: 0011, 0012
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

---

## Reopened — 2026-08-22, by the TICKET-0013 gate

Two defects found by hand-reading 48 real candidates
([worklog 0022](../worklog/0022-gate-hand-check.md)). Both are fixed here rather
than downstream, per that ticket's instruction. Neither is "make the classifier
smarter" — each is a named rule with real urls behind it.

**F1 — prefer the repo owner over a generic repo name.** `deriveName` produced
`torrix-ai/install`, `betterdb-inc/monitor`, `rocketgraph/rocketgraph`,
`liquidos-ai/autoagents`, `nullswan/bpfsnitch`, `yantrikos/yantrikdb-server` and
`xqlsystems/xarray-sql` — 7 of 48 candidates, and in every one the **owner is the
company name**. Torrix's own post title says "Torrix"; its repo is called
`install`. Two of the seven are actively misleading: `install` and `monitor`
read as the product.

Fix: when a code-host url is the naming source and the repo slug is a common
English noun (`install`, `monitor`, `server`, `docs`, `cli`, `sdk`, `demo`,
`app`, `core`, `api`), name the candidate from the **owner** instead. Keep
`owner/repo` when the slug is distinctive (`bpfsnitch`, `helix-db`) — a
distinctive slug is a name. The word list is a guess and gets labelled as one.

**F2 — ACM proceedings hosts are papers.**
`camps.aptaracorp.com/ACM_PMS/PMS/ACM/HCDS25/…` reached a candidate list.
`PAPER_HOSTS` knows `arxiv.org` and the path carried no `.pdf`. Add ACM's
typesetting host. One host, not a general rule — "is this a paper" is not
learnable from one example, and a general rule would start rejecting companies.

**F4 — a `blog.` subdomain is a blog. Moved here from TICKET-0010**
([worklog 0023](../worklog/0023-gate-fixes-canonicalisation.md)).
`blog.zmalik.dev/p/who-will-observe-the-observability` reached a candidate list
and became the candidate `zmalik.dev` — inconsistency 37's second class,
confirmed on a second topic.

The gate scoped it onto TICKET-0010 and that was the wrong file. "Is this an
article" is `classifyUrl`'s question, and `classifySite` in `resolve.ts` exists
only to add rejections the url classifier *cannot* reach. The consequence that
settles it: the probe calls `classifyHits` → `classifyUrl` and nothing else, so
a blog rule that lived in `resolve.ts` would leave **D-6's usable count still
counting blogs as companies** while the candidate list got right.

Fix: a `blog.` (or `www.blog.`) subdomain, and the substack-shaped `/p/<slug>`
path, join `ARTICLE_PATH` and `DATED_PATH` as content. `PERSONAL_HOSTS` is not
extended — personal domains cannot be enumerated and trying is how a classifier
starts rejecting companies.

**Not fixed here, deliberately:** the `funding` expansion arm returned **0 hits
on all four gate topics** (`"<seed> raises seed funding"` matches almost nothing
in HN titles). Four topics is not enough to cut an arm that exists for the case
none of them contained. Recorded as STATE inconsistency 46; revisit at
TICKET-0028.

### Acceptance (reopened scope)

- A test per fix, written from the real urls above, offline.
- `deriveName` tests pin both directions: `torrix-ai/install` → `Torrix`, and
  `nullswan/bpfsnitch` → unchanged.
- F4 is tested through `classifyUrl`, so the probe's usable count sees it too —
  that is the reason it lives here rather than in TICKET-0010.
- The generic-slug word list is labelled a guess in the code, like the other
  five unmeasured constants.
