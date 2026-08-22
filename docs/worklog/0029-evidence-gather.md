# Session 0029 — 2026-08-22 — Evidence gathering and the run-level budget

[TICKET-0017](../tickets/0017-ticket-evidence-gather.md), in two commits.
`src/analyse/gather.ts` is stage 2a: for one candidate, the HN thread it came
from, its company site and its GitHub account become a bundle of `Evidence`
records written to the store, and the two adapters are joined to each other in
whichever direction the candidate allows. `src/analyse/budget.ts` is the thing
neither adapter could own — **what a whole run may spend**, which is STATE
inconsistencies 60 and 66 closed.

## What I asked for

Continue implementation, stop for review, small commits on a feature branch,
keep the worklogs going with reflection hints, update ticket statuses.

## What landed

| Commit    | Contents                                                       | Tests |
| --------- | -------------------------------------------------------------- | ----- |
| `b85b0f0` | `src/analyse/budget.ts` — run plan, meter, bounded concurrency | 19    |
| `b6a5941` | `src/analyse/gather.ts` — the bundle, the join, the loop       | 27    |

**716 tests** (670 before this ticket: +46), typecheck and lint clean, offline
and with no `.env`.

## The shape

Four rules. Three of them are the adapters' own rules one level up; the fourth
is the reason this module is separate from extraction at all.

**1 — No model, and the test says so rather than the comment.** 2a being a
separate file from 2b is what makes "the gather step concludes nothing"
checkable instead of asserted. The check is a **transitive import-graph walk**:
the test resolves every relative import reachable from `gather.ts` and asserts
none of them is under `src/llm/`. The obvious alternative — a stub `callModel`
that fails the test when invoked — passes just as well when the stub is wired
to the wrong thing, which is the failure mode it is supposed to catch.

**2 — The bundle carries ids alongside text.** `bundleItems(bundle)` is the
projection the extraction prompt receives, and there is no shape in which a
record's text reaches the model without its id (ADR-0003). `bundleIds(bundle)`
is the closed world TICKET-0020 will check facts against. `Evidence.meta` is
deliberately **not** in the projection: attempt counts, cache hits and
projection names are for a reviewer reading the store, and every field handed
to a model is a field it can be confused by.

**3 — Zero usable evidence is a bundle, not a failure.** A dead site, no GitHub
account and a deleted thread produce a bundle of `fetch_failed` records,
unknowns with reasons, and a run that continues. `usableEvidence(bundle)` is
how a caller tells that apart from a full one without inspecting types.

**4 — The join runs in both directions.** This is the half of inconsistency 45
that TICKET-0015 read but did not apply.

- A candidate sourced as `github.com/coroot/coroot` reaches the company site
  through `repo.homepage` — the field 0015 narrowed to on purpose, after the
  account's own `blog` turned out to be a LinkedIn profile on the gate's 404
  candidate.
- A candidate sourced as `coroot.com` reaches the repository through the
  **code-host link the site adapter already discovers**. `LINK_RULES` has
  carried a `repo` role with an `offsite` exemption since 0016; nothing had
  read it.

Both are recorded on the bundle as `join.site.from` and `join.github.from`, so
a reviewer can see which guess was made. **Neither merges two candidates** —
that is still open and still not this ticket's.

## The budget, which is what the ticket was actually about

Both adapters shipped a request budget that is decided per candidate and spent
per run — inconsistencies 60 and 66, written a week apart in the same words.
`defaultCalls(mode)` is the right answer for one candidate and an _assumption_
about the run: it assumes roughly a dozen of them. A `--limit 40` unauthenticated
run plans 80 GitHub requests against a 60/hour limit, and the candidates that
pay for it are whichever ones happen to sit at the end of the list.

Four decisions, taken in code:

**The allowance is planned before the loop starts.** `planRun(count, mode)`
divides both ceilings by the candidate count and every candidate gets the same
answer. A budget spent first-come-first-served produces a run whose coverage
depends on list position, and a reader cannot tell "we ran out" from "there was
nothing there". Uniformly thinner is worse for the last candidate and better
for the reader. This is `defaultCalls`' own argument about degraded mode,
applied one level up.

**The plan reproduces the adapters' defaults at the size they assumed, and a
test pins that.** Twelve candidates gets exactly `CHEAP_CALLS` unauthenticated
and exactly `ALL_CALLS` with a token. This is a generalisation of the shipped
behaviour, not a replacement for it — which is the difference between a
refactor a reviewer has to re-derive and one they can check in a line.

**Two numbers, not one.** The _planning ceiling_ is half of GitHub's hourly
limit; the other half pays for the retries `httpGet` makes on a 429 or a 5xx,
which the plan cannot count, and for whatever else this IP address did in the
same hour, which a run cannot see. The _wall_ is GitHub's whole documented
limit, metered against actual spend. A pool at its wall is skipped with an
unknown that gives the numbers, rather than being called and rate-limited.

**A floor of one GitHub call rather than a cliff at our own reserve.** Thirty
planned requests do not divide into thirty-one candidates, and the arithmetic
answer is "no GitHub evidence for anybody" — a cliff created by our
conservatism, not by GitHub's limit, since 31 requests fit inside 60 easily.
The floor holds, `RunPlan.over_planning_ceiling` records that the reserve was
crossed, and the wall is what actually stops the run. The site pool needs no
such floor: `sitePages` excludes the home page, so zero still reads one page.

The two pools have different rationales and the file says so. GitHub's ceiling
is **theirs** — a documented hourly limit on one host. The site ceiling is
**ours** — every candidate's site is a different host and none of them has
agreed to anything, so 240 is a bound on the run itself (sixty companies read
in full, well past the `--limit 15` this tool is for) rather than a constraint
anyone imposed. Because it is our number, the plan spends all of it instead of
reserving a share.

Concurrency is `mapWithConcurrency` — a cap, input-order results, no swallowed
rejections, twenty lines. SCOPE says no queue and this is the whole
requirement. Four at a time, chosen to be obviously polite rather than optimal:
GitHub's limit is hourly rather than per second, and the sites belong to
strangers.

## Decisions taken in code

- **The HN thread is the primary post only.** `provenance` is a group at schema
  v2 and the secondary posts are the same company discussed again — a request
  each for a thread the primary already covers.
- **The thread is fetched as its canonical `news.ycombinator.com/item?id=` page**,
  the url `hnItemUrl` was written to produce, extracted to text like any other
  HTML. No HN metrics are emitted. See the gaps below: this is a real cost.
- **A gist is an account but not a page.** Fetching `github.com/acme/thing` as
  if it were a company site would put GitHub's own chrome into the evidence
  store as though the company had written it. `acme.github.io` is the exception
  that had to be named — it is an account _and_ a hosted page, and on a small
  company it is routinely the only page there is — so it is read as both.
- **A dead branch was removed while writing the tests.** The first draft had a
  third case, "neither a company page nor a GitHub account", with its own
  message. It is unreachable: `siteUrlFromCandidate` returns the url unchanged
  unless the candidate is a `github.com` or gist ref, and in that case there is
  an account to read. Exactly one of the two branches always runs, and the file
  now says why there is no third.
- **`gatherRun` takes an optional `limits`,** so a run that knows the hour is
  already partly spent can hand over a smaller wall — and so a test can hand
  over one small enough to hit. Without it the wall was only reachable by
  making sixty requests in a test.

## Known gaps, recorded rather than fixed

1. **No HN metric reaches the rubric.** The thread's points and comment count
   were on the Algolia hit in stage 1, the `Candidate` contract does not keep
   them, and the thread page is HTML — reading them back means a scraper. So
   D3 (pull) currently has GitHub stars and nothing else, and the one source
   that is actually about _attention_ contributes prose only. TICKET-0021 is
   where this bites. New STATE inconsistency 67.
2. **The site ceiling is a number we invented.** 240 is defensible and it is
   not measured. Unlike GitHub's 60, nothing external will tell us it is wrong.
3. **This ticket has not been run against live sources.** 0015 and 0016 both
   were, both live runs changed the code, and worklog 0028 recommended
   budgeting a live pass at the end of every adapter ticket. There is no
   committed `candidates.jsonl` to run this against, so the natural place is
   TICKET-0022's wiring — where one exists — rather than here. Recorded so it
   is a decision rather than an omission.
4. **The bundle is in-memory.** Evidence records are on disk and committed; the
   bundle itself is a handoff inside stage 2 and is not an artifact. If a
   reviewer should be able to see exactly what the model was shown as one file,
   that is a small addition to TICKET-0022 and not a change here.
5. **`defaultCalls` now has two opinions in the tree.** `gatherGithub` still
   falls back to it when no `calls` are passed; `gather.ts` always passes the
   plan. The fallback is right for a direct caller and a test, and it is a
   second place the number lives.

## What this ticket did not do

- **No candidate merging.** Two candidates that resolve to one company are
  visible now — same `join.site.url` — and nothing collapses them. Whether the
  memo set ever should is a real question, not a mechanical follow-on.
- **No queue, no rate-limit backoff scheduler.** SCOPE rules both out. The
  meter skips; it does not wait for the hour to roll over.
- **No stage-2 wiring.** Nothing calls `gatherRun` yet — that is TICKET-0022.

## Attribution

`src/analyse/budget.ts`, `src/analyse/gather.ts`, all 46 tests and this
worklog's factual sections are AI-written end to end.

## Reflection

The budget module is also a nice to have. This exists purely for rate-limiting and avoid endless requests.

## Next

**TICKET-0017 is Done.** [TICKET-0019](../tickets/0019-ticket-extraction-prompt.md)
— the extraction prompt — is unblocked: the bundle it formats now exists and
`bundleItems` is the exact shape it will render. TICKET-0020 follows it, and
TICKET-0022 wires the whole stage and is where the live pass belongs.
