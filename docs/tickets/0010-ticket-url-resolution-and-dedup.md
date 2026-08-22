# TICKET-0010 — URL resolution, canonicalisation, dedup (`src/source/resolve.ts`)

Status: **Reopened** — the original scope is Done; the 0013 gate returned three scoped fixes, see *Reopened* below. Worklogs [0017](../worklog/0017-url-canonicalisation-and-dedup.md) and [0018](../worklog/0018-redirect-resolution.md) · Depends on: 0008 (Done) · Blocks: 0012
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

---

## Reopened — 2026-08-22, by the TICKET-0013 gate

Three defects found by hand-reading 48 real candidates
([worklog 0022](../worklog/0022-gate-hand-check.md)). All three are the same
shape: a url that points *inside* something rather than at it.

**F3 — collapse a code-host url to its repo root.** Three of the gate's five
junk candidates were deep paths:
`github.com/alibaba/anolisa/blob/main/docs/user-guide/en/…/agentsight.md` (a docs
page in Alibaba's monorepo, which became a "company"),
`github.com/xqlsystems/xarray-sql/blob/claude/…/benchmarks/nn.py` (one Python
file on a feature branch), and `github.com/BetterDB-inc/monitor/tree/master/packages`.
`HelixDB/helix-db/tree/main` is the same defect in a candidate that happened to
be real.

Fix: on a code host, strip `/blob/…`, `/tree/…`, `/issues/…`, `/pull/…`,
`/releases/…` down to `owner/repo` during canonicalisation. Two urls into one
repo then dedup, which they currently do not.

**F4 — a `blog.` subdomain is a blog.**
`blog.zmalik.dev/p/who-will-observe-the-observability` reached a candidate list
and became the candidate `zmalik.dev`. Inconsistency 37's second class,
confirmed on a second topic. `PERSONAL_HOSTS` cannot enumerate personal domains
and should not try; what generalises is the **subdomain** (`blog.`, `www.blog.`)
and the substack-shaped `/p/<slug>` path. Both are narrow, nameable rules of the
kind `classifyHit` already contains.

**F5 — package-registry hosts (STATE inconsistency 36).** `siteKey` keys
`pypi.org/project/logmera` on `pypi.org`, so a second PyPI launch in the same
run merges into the first and is deleted with no trace. Key registries on the
package: `pypi.org`, `npmjs.com`, `crates.io`, `hub.docker.com`,
`huggingface.co`. **No registry url reached any of the four gate lists** — the
ranking fix in session 0021 demotes them, since a registry page rarely carries
HN points. So this is rarer than it looked and still the dangerous direction to
be wrong in. Lowest priority of the three; do it while the file is open.

**Not fixed here, and it is the one that matters most.** Coroot took three of
twelve slots on one gate run — `github.com/coroot/coroot`, `coroot.ai` and
`demo.coroot.com`. Nothing in a repo url and a company-site url says they are
the same company (inconsistency 28). The join needs the repo's `homepage` field,
which **TICKET-0015** fetches. Do not guess at it here with a name-similarity
heuristic.

### Acceptance (reopened scope)

- A test per fix, written from the real urls above, offline.
- A test that two deep paths into one repo now produce one candidate.
- `demo.coroot.com` → `coroot.com` still holds (it always did); the test says
  explicitly that this does **not** join `coroot.ai` or the repo, and names
  TICKET-0015 as where that happens.
