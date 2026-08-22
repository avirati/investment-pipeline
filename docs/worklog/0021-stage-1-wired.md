# Session 0021 — 2026-08-22 — Stage 1 wired; `./pipeline source` is real

[TICKET-0012](../tickets/0012-ticket-stage-1-wiring.md), the rest of it. Session
0020 built the three pieces the command composes; this one wrote the command,
and it is the first thing in this repo that produces an artifact from a live
API.

## What I asked for

Continue implementation after a live test run, take the ranking fix the run
argued for, record the rest, keep commits small.

## What the AI produced

Five commits.

| Commit           | What it is                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `docs`           | What the first live run measured — inconsistencies 36–40         |
| `feat(manifest)` | `src/manifest.ts` — the run record all three stages append to    |
| `feat(source)`   | `src/source/index.ts` — plan → search → rank → cut → resolve     |
| `feat(cli)`      | The `source` action, the summary, the exit-code contract applied |
| `test(source)`   | The wiring driven over the committed HN capture                  |

## The five decisions the ticket owed

**1. The ordering: dedup, rank, cut, resolve.** Resolution is one request per
company, so cutting before it is what keeps a 200-post result set to `--limit`
requests rather than 200. Ranking before cutting is the part the live run
forced — see below.

**2. The run-level failure decision (inconsistency 24), which nothing had made.**
`SourceError` with three kinds: `source_dead` when _every_ request to the source
failed, `no_hits` when the source answered and had nothing, `no_candidates` when
hits existed and nothing survived filtering. One dead page among eight is still
not a dead run — that was `searchHn`'s deliberate non-decision and it stands.
All three exit 2. That collapses "the API is down" into "the world is thin",
which a reviewer may well dislike; the argument for it is that exit 1 is the
operator's invocation and exit 3 is a bug in this code, and a 503 from Algolia
is neither. Recorded as inconsistency 41 rather than defended as obviously right.

**3. `--no-expand` cuts the four arms as well as the planning (inconsistency
31).** The flag's help text says "use the raw seed verbatim", and a run that
skipped the clarifier and then searched `"<seed> raises seed funding"` would not
be that. ADR-0008 only ever spoke about planning, so this was 0012's call.

**4. The thin-yield fallback.** Under 10 sites it widens `--since` to 730 days,
searches again, merges by `objectID` and records `fallback` in the manifest so a
reviewer sees that it fired. It widens the _arms_ only when the operator did not
turn them off: `--no-expand` is an instruction, not a preference.

**5. The `urls` seed form makes no network requests at all.** There is no post
to rank, so redirect resolution has nothing to disambiguate, and stage 2 fetches
the site as citable evidence anyway — where a redirect is followed and recorded
with a `retrieved_at`. The consequence is real and is stated rather than hidden:
a shortened url in a hand-written list is resolved one stage later than the same
url posted to HN. It reuses the same classifier and the same dedup key, so a
hand-typed url is held to the standard an HN link is.

## What the live run changed

`--limit` was cutting in discovery order — arm order then page order, which is a
relevance ranking over four concatenated queries and not a ranking of companies.
On `"LLM observability"` the first ten sites carried 74, 3, 2, 2, 2, 2, 2, 1, 1
and 31 points; the strongest ten carried 105, 85, 74, 74, 59, 32, 31, 13, 12 and 10. `rankSites` fixes it and reuses `strongerPost` from `resolve.ts` — now
exported — so the rule for ranking companies and the rule for ranking posts
inside one company cannot drift apart.

The fix had a second effect nobody asked for: two of the three junk candidates
the first run surfaced (a trade-press article, a package-registry page) fell out
of the top 12 on their own. Ranking by traction demotes junk without anyone
teaching the classifier what junk is. That is an argument for leaving the
classifier alone until TICKET-0013 has real numbers, which is what the author
chose.

## The test suite fetched from the network, once

`tests/cli.test.ts` had a case asserting that every command exits 70 — and it
spawns each command for real. The moment `source` became a real action, `pnpm
test` ran stage 1 against live HN Algolia and wrote `runs/2026-08-22-x/` into
the repo. It did exactly that, once, on my machine, and it was caught by the
assertion failing rather than by anyone noticing the traffic.

CLAUDE.md's rule — "never add a test that requires a network call" — was not
broken by adding a test. It was broken by a command becoming real underneath a
test that had been correct the day before. `source` is out of that list, the
three commands left still exit before doing anything, and the case now says in a
comment why the list is not `COMMANDS`.

## Verification

- `pnpm test` — **362 passed** (320 at the start of this session: +12 manifest,
  +28 wiring, +3 CLI, minus one that was rewritten). Offline, no key.
- `pnpm typecheck`, `pnpm lint` clean. No stray `runs/` or `.cache/` after a
  full suite run.
- **Live, `./pipeline source --seed "LLM observability" --limit 12`**: 12
  candidates in 15 requests, `candidates.jsonl` readable with `jq`,
  `manifest.json` carrying the git sha, `query_plan.json` recording
  `chosen_by: probe`. Re-running the same run id refused; `--replay` reused it;
  a two-line url list for one company produced one candidate with two provenance
  entries — the plural provenance path, exercised against something real for the
  first time.
- Ticket acceptance: all four rows met. Nothing from these runs is committed —
  the sample run is TICKET-0028's, and which topic it uses is D-5.

## What the record should be honest about

**A replay re-searches.** `--replay` reuses the run directory and the decided
plan, then runs the search again (largely from the 24-hour HTTP cache) and
rewrites `candidates.jsonl`. Inconsistency 35.

**`--limit` is applied before resolution, so redirect merges can leave fewer
candidates than asked for.** Two vanity domains that turn out to be one company
are one candidate, and nothing goes back for an eleventh. Correct, and worth
knowing before reading a manifest that says `limit: 12` above eleven candidates.

**The wiring's tests are mostly synthetic.** The branches under test are about
yield — thin, rich, dead — and a captured page has the yield it has. One test
runs the committed capture end to end so the production parse is exercised
against a payload HN really sent; the fixture capture at TICKET-0014 is where a
second, deliberately awkward topic should join it.

**Nothing validates that the manifest is complete.** Later stages append to it
and `writeStage` merges, but no check says stage 2 ran. That is TICKET-0027's
job and it is named in the ticket.

## Decisions taken

No open decision in STATE.md was answered. D-5 is now _choosable_ — stage 1
produces real candidate lists — and is still open.

**TICKET-0012 is Done.** The gate at TICKET-0013 is next, and it is a gate: it
is where a person reads a real candidate list and says whether the junk rate,
the classifier and the probe threshold are acceptable.

## Attribution

`src/manifest.ts`, `src/source/index.ts`, the `urls` seed form, the CLI action,
all four test files and this worklog's factual sections are AI-written
end-to-end. The five decisions above were made by the AI; the ranking fix was
chosen by the author from a list of five candidate fixes the live run surfaced.

## Reflection

Leaning towards higher ranks on HN posts will help avoid irrelevant posts or junk. Posts are now sorted and top ones are picked based on --limit

## Next

[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md) — the gate.
Read a real candidate list by hand and record what the junk rate actually was,
whether `--min-hits 8` is the right threshold (the first live run measured 35
usable of 50 on a centre-of-thesis query), whether the expansion arms earn their
requests (on that topic they contributed nothing), and whether a repo and a
company are distinguishable downstream. Do not start stage 2 before it reports.
