# TICKET-0010 — URL resolution, canonicalisation, dedup (`src/source/resolve.ts`)

Status: **Done** again — the 0013 gate returned three scoped fixes; two landed here and one moved to TICKET-0009, see *Reopened* below and [worklog 0023](../worklog/0023-gate-fixes-canonicalisation.md). Worklogs [0017](../worklog/0017-url-canonicalisation-and-dedup.md) and [0018](../worklog/0018-redirect-resolution.md) · Depends on: 0008 (Done) · Blocks: 0012
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
`/releases/…` down to `owner/repo` during canonicalisation.

**Correction, made while implementing.** This ticket first claimed the fix would
"make two urls into one repo dedup". They already did — `siteKey` has always
sliced a code-host path to `owner/repo`, so the *key* was never wrong. What was
wrong is `canonical_url`: the url a candidate is named after, and the one stage 2
would fetch as the company's evidence. The pipeline would have sent the evidence
fetch at a markdown file and scored the company on it. That is a worse defect
than the one originally written down, and it is the one that was fixed.

Truncate, never reject: `github.com/HelixDB/helix-db/tree/main` is a real
company and `/tree/main` is just how a repo link gets pasted.

**F4 — a `blog.` subdomain is a blog. → Moved to TICKET-0009.**
`blog.zmalik.dev/p/who-will-observe-the-observability` reached a candidate list
and became the candidate `zmalik.dev`. Inconsistency 37's second class,
confirmed on a second topic.

The gate scoped this fix to this ticket and that was the wrong file. "Is this an
article" is `classifyUrl`'s question, and `classifyUrl` lives in `hn.ts` —
`classifySite` here exists only to add the rejections the url classifier
*cannot* reach, and a `blog.` subdomain is plainly one it can. Two consequences
decided it: the probe (`classifyHits`, and therefore D-6's usable count) only
ever sees `hn.ts`, so a blog rule here would leave the threshold measuring blogs
as companies; and splitting the definition of "article" across two files is the
drift this codebase keeps one definition to avoid. Moved rather than
implemented, with the reasoning recorded here.

**F5 — package-registry hosts (STATE inconsistency 36).** Landed. `siteKey` keys
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

### Acceptance (reopened scope) — met

- A test per fix, written from the real urls above, offline. **14 new tests**,
  376 passing.
- A test that two deep paths into one repo produce one candidate *and one url*.
- `demo.coroot.com` → `coroot.com` still holds (it always did); the test says
  explicitly that this does **not** join `coroot.ai` or the repo, and names
  TICKET-0015 as where that happens.
- **Re-measured against the gate's own four topics**, not estimated: all four
  real deep urls collapsed (`alibaba/anolisa`, `xqlsystems/xarray-sql`,
  `HelixDB/helix-db`, `BetterDB-inc/monitor`), and the two clean topics were
  byte-for-byte unchanged. No registry url appeared in any of the four, so F5 is
  covered by tests and has never fired in the wild.
