# Session 0022 — 2026-08-22 — The gate: four live runs, read by hand

[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md). Not a
coding ticket — its deliverable is a written finding, and this is it. Four
topics, 48 candidates, every one read by hand against its url and its post
title. The numbers below are what stage 1 actually produces, not what it was
hoped to produce.

## What I asked for

Continue implementation, small reviewable commits, keep the worklogs going.
The next ticket was the gate, so the gate is what ran.

## The four runs

All four are `./pipeline source --seed "<topic>" --limit 12`, default
`--since 180`, default `--min-hits 8`, against live HN Algolia on 2026-08-22.
Nothing from them is committed — the sample run is TICKET-0028's and the raw
directories stayed outside the repo.

| Topic                     | Probe (usable/hits) | `chosen_by`       | Posts | Pages | Requests | Wall              |
| ------------------------- | ------------------- | ----------------- | ----- | ----- | -------- | ----------------- |
| `AI agent infrastructure` | 26/50               | `probe`           | 181   | 6     | 19       | 19.1s             |
| `LLM observability`       | 35/50               | `probe`           | 70    | 5     | 18       | 0.1s (warm cache) |
| `vector database`         | 33/50               | `probe`           | 123   | 6     | 19       | 16.3s             |
| `eBPF observability`      | **3/6**             | `non-interactive` | 23    | 8     | 21       | 20.6s             |

The topics were picked to spread across the thesis rather than to flatter it:
one at its centre (`LLM observability`), one at the buzzword edge where the
anti-thesis should bite (`AI agent infrastructure`), one adjacent-but-crowded
(`vector database`), and one deliberately narrow and only half-inside the thesis
(`eBPF observability`) to see what a thin probe does.

## D-6 — the `--min-hits` default of 8. **Verdict: keep 8.**

Three topics probed 26–35 usable of 50 — three to four times the threshold, so
on anything with normal HN volume the threshold is nowhere near binding and
costs one request. The fourth probed **3 usable of 6** and fell under it.

The reason to keep 8 is not that number, though. It is that **the topic that
fell under the threshold is also the topic that produced the worst list** — 5
junk of 12, and three separate entries for one company. The threshold is
behaving as a junk predictor, not merely a yield gauge, which is a stronger
claim for it than the ticket asked for. On a query where HN has 6 posts to
offer, everything downstream is scraping a barrel.

Two caveats the number carries, both already flagged: `usable` is an upper bound
because the classifier accepts by default (inconsistency 21), and the probe is
one page of `story`-tagged results, not the four arms.

**The clarifier never fired**, on any run, because there is no clarifier — the
seam in `plan.ts` is unwired until TICKET-0018. All four runs recorded
`chosen_by: probe` or `non-interactive`. So the ticket's other question — _were
the clarification options good, or was "keep my original" always right?_ — is
**unanswered and cannot be answered yet**. It moves to TICKET-0018, and this is
noted in STATE rather than guessed at. What this run does establish is that the
clarifier would have been offered exactly once in four topics, and on the one
where it would have helped most.

## The thin-yield fallback fired, and it is where the junk came from

`eBPF observability` yielded 3 sites, tripped the under-10 fallback, widened the
window 180 → 730 days and re-searched: 3 → 13 sites. Every one of that run's
five junk candidates is from the widened window — an ACM paper from 2025-04, a
personal blog post from 2025-11, a demo instance from 2024-12. Widening buys
volume by reaching back past the point where a launch is still a launch.

That is a real cost and it is now measured rather than argued. It is not a
reason to cut the fallback: 3 candidates is not a pipeline. It _is_ a reason for
the manifest to keep saying loudly that it fired, which it does.

## Junk rate — **5 of 48 (10%)**, and it is not spread evenly

"Junk" here means: not a company and not a product surface either — a paper, a
blog post, a docs page inside somebody else's monorepo, a demo instance, a
single source file.

| Run                       | Junk             | Duplicates | Distinct companies | Fallback names    |
| ------------------------- | ---------------- | ---------- | ------------------ | ----------------- |
| `AI agent infrastructure` | 0                | 0          | 12                 | 1                 |
| `LLM observability`       | 0                | 0          | 12                 | 6                 |
| `vector database`         | 1                | 0          | 11                 | 2                 |
| `eBPF observability`      | 4                | 2          | 8                  | 4                 |
| **Total**                 | **5 / 48 (10%)** | **2**      | **43**             | **13 / 48 (27%)** |

The five, by name, because a rate with no examples behind it is not a finding:

1. `camps.aptaracorp.com/ACM_PMS/PMS/ACM/HCDS25/…` — an **ACM proceedings
   paper**. `PAPER_HOSTS` knows `arxiv.org`; it does not know ACM's typesetting
   vendor, and the path carries no `.pdf`.
2. `blog.zmalik.dev/p/who-will-observe-the-observability` — a **personal blog
   post**. Inconsistency 37's second class, confirmed on a second topic. The
   host is not in `PERSONAL_HOSTS` and never will be; what is generalisable is
   the `blog.` subdomain and the `/p/<slug>` path.
3. `github.com/alibaba/anolisa/blob/main/docs/user-guide/en/…/agentsight.md` — a
   **documentation page inside Alibaba's monorepo**, keyed as
   `github.com/alibaba/anolisa` and named "AgentSight" from the post title. A
   company was invented out of a docs file.
4. `demo.coroot.com/p/tbuzvelk/applications` — a **live demo instance** of
   Coroot, which is already candidate 1 of the same run.
5. `github.com/xqlsystems/xarray-sql/blob/claude/…/benchmarks/nn.py` — a **single
   Python file** on a feature branch.

Three of the five (1, 3, 5) share one shape: the url points _inside_ something
rather than at it. That is a canonicalisation defect, not a classification one,
and it is the cheapest fix on this page.

## The duplicate that matters: one company, three candidates

`eBPF observability` returned **Coroot three times** — `github.com/coroot/coroot`
(rank 1), `coroot.ai` (rank 5), `demo.coroot.com` (rank 8). Three different
`siteKey`s, none of which the dedup layer can see through:

- a repo and its company site have nothing in either url that says so —
  inconsistency 28 predicted exactly this and named TICKET-0015's repo
  `homepage` field as the fix;
- `coroot.com` and `coroot.ai` are two registrable domains and genuinely
  different keys;
- `demo.coroot.com` collapses to `coroot.com` correctly, and `coroot.com` was
  never itself a candidate, so the collapse bought nothing.

This is the wrong-split direction, which `resolve.ts` argues is the safe one to
be wrong in — one company got three of twelve slots and nothing was deleted. It
is still 25% of a run spent on one company, and on the run that could least
afford it.

## Naming — **13 of 48 (27%) got a fallback name**, 7 of them avoidably

`deriveName` lifts a name from the post title or falls back to the address. The
fallbacks split in two.

**Unavoidable and fine (6):** `hypercubic.ai`, `pylonsync.com`, `splabs.io`,
`crosscanon.com`, `syn-cause.com`, `zmalik.dev` — the post title genuinely
carried no name in a liftable shape. A memo headed `splabs.io` is plain; it is
not wrong.

**Avoidable, and this is inconsistency 40 with a number on it (7):**
`torrix-ai/install`, `betterdb-inc/monitor`, `rocketgraph/rocketgraph`,
`liquidos-ai/autoagents`, `nullswan/bpfsnitch`, `yantrikos/yantrikdb-server`,
`xqlsystems/xarray-sql`. Every one is `owner/repo` where **the owner is the
name** — `torrix-ai/install` is Torrix, whose own post title says "Torrix", and
whose repo is called `install`. Two of the seven are worse than plain: `install`
and `monitor` are English words that read as the company's product.

15% of all candidates and half of all fallbacks, on one rule, in one place.

## Inconsistency 22 — is a weekend repo distinguishable from a company?

**At this layer: no.** 10 of 48 candidates are open-source projects with no
company behind them — `crosscanon`, `remembrane`, `collabmem`, `agentarmor`,
`yantrikdb-server`, `AgentBPF`, `bpfsnitch`, `huatuo`, `agentsight`,
`autoagents`. The url of a serious company's repo and a weekend project's repo
are the same shape, and this layer reads only the url.

**One signal is visible and free, and stage 2 already plans to fetch it.** Of
those ten, the ones that are hobby projects are owned by **personal GitHub
accounts** (`satyasairay`, `visionscaper`, `Agastya910`, `pandyamarut`,
`nullswan`) while every candidate that turned out to be a company is owned by an
**organisation** (`getomnico`, `HelixDB`, `InsForge`, `penca-io`, `XTraceAI`,
`coroot`, `linnix-os`, `Infisical`, `kontext-security`). The exception proves it
is a signal and not a rule: `ccfos/huatuo` is an org and a foundation, not a
company.

`GET /users/<owner>` returns `"type": "User" | "Organization"` in one request
that TICKET-0015 is making anyway. That is a fact for the extractor, scored by
the rubric — it is not a filter in stage 1, and it must not become one. Recorded
here so 0015 and 0021 pick it up.

**This does not close inconsistency 22.** The question it asks is whether
_stage 2's scoring_ separates them, and stage 2 does not exist. What the gate
can say is that the input is honest about the ambiguity and carries a cheap
discriminator into the stage that can use it.

## Inconsistency 38 — do the expansion arms earn their requests?

Now four topics rather than one, and the answer changed:

| Topic                               | `raw` new | `show_hn` new | `launch` new | `funding` new |
| ----------------------------------- | --------- | ------------- | ------------ | ------------- |
| `AI agent infrastructure`           | 100       | **+59**       | **+22**      | 0             |
| `vector database`                   | 100       | **+23**       | 0            | 0             |
| `LLM observability`                 | 70        | 0             | 0            | 0             |
| `eBPF observability` (both windows) | 29        | 0             | 0            | 0             |

`show_hn` earns its request on the two high-volume topics and is dead weight on
the two thin ones — which is the right way round, because on a thin topic there
is nothing to add. `launch` earned one request of four.

**`funding` returned zero hits on all four topics** — `"<seed> raises seed
funding"` as a full-text query against HN post titles matches almost nothing.
Four requests, four topics, zero hits, zero new posts. It is the one arm this
data says to cut, and cutting it is a change to `expandQuery` in TICKET-0009.

Left in for now, because four topics is four topics and the arm exists for
exactly the case where a company's only HN presence is a funding announcement —
which none of these four topics contained. Recorded as inconsistency 46.

## Inconsistency 23 — `HN_MAX_PAGES_PER_ARM`

`raw` hit the two-page cap (100 hits) on both high-volume topics, so the cap
binds. It also does not matter: `--limit 12` cuts three ranks of magnitude below
it, and page 2 of `raw` supplied candidates that survived to the final twelve on
both. Leave at 2.

## Inconsistency 39 — a 404 stays a candidate

One unreachable site in four runs (`eBPF observability`, `resolve.unreachable: 1`),
and it did not reach the final list on its own merits — it was already in the
twelve. One in 48 is not a rate worth changing a rule for. Leave as is: a
company that 403s a bot is still a company, and stage 2 records a `fetch_failed`
and drops coverage, which is the specified behaviour.

## Inconsistency 36 — registry hosts

Did not recur. `pypi.org/project/logmera` was in the first live run's twelve and
no registry url reached any of these four lists — the ranking fix from session
0021 demotes them, since a registry page rarely carries HN points. The defect is
unchanged and still real; it is now known to be rare rather than typical. Still
worth the one-list fix, at lower priority than it looked.

## What gets fixed, and where

Per the ticket: _any classifier or canonicalisation bug found here is fixed in
TICKET-0009 or TICKET-0010 — reopen them rather than patching downstream._ Both
are reopened with a scoped list rather than a mandate to make the classifier
smarter.

**TICKET-0010 (canonicalisation) — reopened, three fixes:**

1. Collapse a code-host url to its repo root: strip `/blob/…`, `/tree/…`,
   `/issues/…`, `/pull/…`. Fixes junk 3 and 5, fixes the `HelixDB` and
   `betterdb-inc/monitor` urls, and makes two GitHub urls for one repo dedup.
2. Reject a `blog.`/`www.blog.` subdomain and a `/p/<slug>` path as an article.
   Fixes junk 2.
3. Registry hosts (inconsistency 36) — key `pypi.org/project/<name>` and friends
   on the package, not the host.

**TICKET-0009 (classifier and naming) — reopened, two fixes:**

4. Prefer the repo **owner** over a generic repo name when the repo slug is a
   common English noun (`install`, `monitor`, `server`, `docs`, `cli`, `sdk`,
   `demo`). Fixes 7 of 13 fallback names.
5. Add ACM's proceedings host to `PAPER_HOSTS`. Fixes junk 1. One host, not a
   general rule — a general rule for "is this a paper" is not learnable from one
   example.

**Not fixed, deliberately:** the repo ↔ company-site join (needs
TICKET-0015's `homepage` field), the `funding` arm (four topics is not enough),
`HN_MAX_PAGES_PER_ARM`, the 404 rule.

Estimated effect on this gate's 48: junk 5 → 1, fallback names 13 → 6,
duplicates 2 → 1. The one junk that survives is `demo.coroot.com`, which needs
the repo↔site join to see.

## D-5 — the committed sample run. **Taken at its default: `AI agent infrastructure`.**

The ticket's criterion is _whichever yields the cleanest 10–15 candidates_, and
by every column in the table above it is that run: 12 of 12 are companies, zero
junk, zero duplicates, one fallback name, every post inside the 180-day window,
and it exercises the paths a reviewer should see working — redirect resolution
(2 redirected, 1 rekeyed: `Kampala` → `zatanna.ai`), the expansion arms actually
contributing (+59, +22), and a mix of company sites and company-org repos so
TICKET-0015 has something to enrich.

**The counter-argument, which is the author's to weigh.** All twelve are
launched companies and most are YC-backed, so the memo set may come out
uniformly positive — and a memo set with no interesting Pass in it demonstrates
the thesis less well than one with a real rejection. `vector database` is the
alternative: 11 companies, 5 of them hobby repos owned by personal accounts,
which is exactly the population the anti-thesis (D-1, no technical founder;
D-2, no proprietary surface) exists to reject. It is a less clean list and a
better demonstration.

Default taken because the ticket names cleanliness as the criterion. If the
walkthrough wants a Pass with teeth in it, switch to `vector database` at
TICKET-0028 — the choice costs one re-run.

## Verification

- `pnpm test` — 362 passed, offline, no key. `pnpm typecheck`, `pnpm lint`
  clean. No code changed in this session.
- Four live runs, 77 requests total, ~56s of wall clock, all four wrote a
  readable `candidates.jsonl`, `query_plan.json` and `manifest.json`.
- Every one of the 48 candidates was opened and classified by hand; six
  borderline sites were fetched to confirm what they were.
- Ticket acceptance: junk rate as a number ✅, D-6 verdict ✅, D-5 choice with
  its reason ✅, STATE updated ✅. The clarification-options question is
  recorded as **unanswerable until TICKET-0018** rather than answered.

## Decisions taken

- **D-6 closed** — keep `--min-hits 8`.
- **D-5 taken at its default** — `AI agent infrastructure`, with the
  counter-argument recorded above for the author.
- **TICKET-0013 is Done.** TICKET-0009 and TICKET-0010 are reopened with the
  five scoped fixes. TICKET-0014 is now unblocked.

## Attribution

The four runs, the hand classification, the tables and this worklog's factual
sections are AI-written end-to-end. The five fixes above are the AI's
proposals, scoped from this data; none of them is applied yet.

## Reflection

Small percentage of junk still present. Accepting it as is, and moving on for the sake of time.

## Next

Two paths, and they are independent.

- The five fixes, as two small commits against the reopened
  [TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md) and
  [TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md), each with
  tests written from the real urls above.
- [TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md) — the provider
  and response cache, which is what makes the clarifier real and turns the one
  question this gate could not answer into one a re-run can.

[TICKET-0014](../tickets/0014-ticket-fixture-capture-script.md) is unblocked and
should capture `eBPF observability` alongside a rich topic — it is the awkward
result set the suite has never had.
