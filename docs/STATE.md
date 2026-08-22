# Project State

Last updated: 2026-08-22 · at commit `909af18` · **Phase: stage 1 is closed and audited; TICKET-0018 has landed, so the pipeline can make an LLM call and — the part that matters — can decline to. Nothing calls it yet. TICKET-0014 is the one Ready ticket; 0011's clarifier wiring turned out to need the rubric, and stage 2 proper starts at 0015**

Read this first when picking the project up. It is the one document that is
allowed to go stale, so update it at the end of every session.

---

## Where things stand

Specification is written and committed. The toolchain installs, all three gates
pass, and `./pipeline --help` is real — but every command still exits 70, so
nothing has been run end to end. `./setup.sh` now takes a fresh clone from git
to a type-checked tree without the operator knowing pnpm exists. The stage
boundary now exists as six Zod schemas, so stage work can start against a fixed
contract rather than inventing one as it goes. `src/config.ts` is the one place
`process.env` is read: model choice is an env change (ADR-0006), a missing
variable names itself, and nothing validates at import — the offline paths still
run with no `.env` at all. `src/evidence/store.ts` now owns the citation
guarantee's mechanics — one definition of an evidence id, one text limit, a
double-write that is a no-op and a read that misses instead of throwing — so the
fetch layer and the memo validator have something to build against.
`src/evidence/fetch.ts` is the one module that can touch the network and the
choke point CLAUDE.md requires: `httpGet` resolves for every outcome rather than
throwing, a cache hit replays the original `retrieved_at` so a re-run produces
the same evidence ids, and a dead site becomes a `fetch_failed` record. Its
HTML→text half now exists too — `cheerio` only, per D-8 — so `fetchEvidence(url,
type)` takes a url and returns an `Evidence` whatever happened, and the adapters
in 0009/0015/0016 have one function to call. **Tickets 0001–0008 are Done.**

Stage 1 has now started. `src/source/hn.ts` holds the pure half of the HN
adapter: `hnSearchUrl` turns flags into one deterministic url — tags, page, and
a `--since` window floored to a UTC day so a same-day re-run builds the *same*
url and can hit the fetch cache — `expandQuery` fixes the four expansion arms in
code, and `parseSearchResponse` turns a captured Algolia payload into typed hits
that carry `points`, `num_comments` and `created_at` through as nullable, never
zeroed. Four fixtures are real captures from the live API, plus one hand-edited
malformed page that says so.

`classifyHit` is the other half now in: the usable-vs-unusable filter ADR-0004
promised would be heuristic and auditable, and the definition D-6's threshold is
written in terms of. It reads the url and never the page, because the probe has
to classify a whole result set before a run starts; every verdict carries a
`kind` the manifest can count and a prose `reason` a human reads when they
disagree. **A repo counts as usable** — for a thesis about adoption before a
sales motion the repo is the product surface — and the filter errs towards
accepting throughout, so the usable count D-6 is compared against is an upper
bound. One false positive class it structurally cannot see is pinned by a test
rather than papered over.

`searchHn` closes it. It runs the four arms, paginates each to
`HN_MAX_PAGES_PER_ARM` (2) or to whichever stop condition fires first — the page
count Algolia reports, a short page, or a failure — dedups by `objectID` and
records on every hit *which arms* found it, plus a per-arm `new_hits` count that
says what an arm actually contributed. Failures come back as data: a page that
did not return is an entry in `failures[]`, not a thrown error, because one 500
on the funding arm's second page must not cost the three arms that worked. The
run-level "is this enough to continue" decision that ARCHITECTURE §5 describes
belongs to TICKET-0012, which is the only layer that can see the whole picture.
The injection point is `HttpOptions`, not a swappable fetch function, so the
network choke point stays literally true and the tests exercise the real url
builder and the real cache path. **TICKET-0009 is Done.**

`src/source/resolve.ts` closes the other half of the sourcing problem —
TESTING §3's "classic quiet-bug territory", where two posts about one company
silently become two candidates. It has a pure half and a network half.
`canonicaliseUrl` reduces a posted url to an identity (https, no `www.`, no
tracking params, no fragment, no directory index, sorted query), `siteKey`
decides what two urls are compared on — a registrable domain for an ordinary
site, `host/owner/repo` on a code host, the full host on a shared deploy suffix
— and `dedupeHits` groups a search result into one entry per company, calling
`classifyHit` first so "unusable" keeps one definition and this layer only
*adds* rejections (personal pages, tilde directories, academic hosts). The key
gets **more** specific wherever a host is shared between unrelated owners,
because a wrong collapse deletes a company silently while a wrong split costs
one visible duplicate. Then `resolveSites` follows each deduped site's url
through `httpGet` — one request per company, not per post — re-keys it on where
it landed, and merges groups that now collide, which is the only way two vanity
domains pointing at one company can be seen to be one company. A failed request
keeps its site (a company that 403s a bot is still a company); a landing on
`medium.com` is rejected by the same rules that would have rejected it if posted
directly. **TICKET-0010 is Done.**

`src/source/plan.ts` is the last piece before wiring, and it is the shape
[ADR-0008](./adr/0008-query-planning.md) decided: **probe, then clarify**.
`probeSeed` runs the raw seed — one page, `story` tagged, deliberately *not* the
four expansion arms — and counts the result through `classifyHits`, so the
number `--min-hits` is compared against is a measurement of yield and not a
model's opinion of the phrasing. At or above the threshold the seed passes
through having spent one request and zero tokens. `planQuery` walks ADR-0008's
context table top to bottom, and its first row is the replay guard: a
`query_plan.json` already on disk *is* the answer, so a replay never re-prompts
and never re-searches. Every failure path — dead probe, clarifier that throws,
no TTY, no provider — ends with the raw seed and a `chosen_by` that says which
one happened, because planning is an optimisation and never a gate.

The clarifier itself is a **seam, not a call**: `Clarifier` and `Chooser` are
injected function types, per the ticket's instruction not to stub an LLM call in
this module. TICKET-0018 supplies the first and the interactive select supplies
the second; until both land, a thin probe takes the no-TTY path. The branch is
nonetheless real and fully tested through stubs. `sanitiseOptions` is where "the
LLM chooses words, code chooses filters" stops being a convention — model output
reaches `query=` and nothing else, one line, deduped, length-capped, at most
four. **TICKET-0011 is Done.**

TICKET-0012 is **Done**, and stage 1 exists as a command. Three pieces landed
first ([worklog 0020](./worklog/0020-run-identity-and-candidates.md)).
`Candidate.provenance` is a **non-empty list, primary first**
(`schema_version` 2) — the fix for inconsistency 25, expressed as a tuple with a
rest element so `provenance[0]` needs no undefined check — carrying `title` (the
post title a name was derived from), `posted_url` (the link as submitted) and
`posted_at`, which is null when the hit carried no date while `at` stays the run
clock. `src/run.ts` owns run identity for all three stages: `deriveRunId` is
`<utc-day>-<seed-slug>` from the seed *as typed*, `validateRunId` rejects an
operator's `--run` rather than sanitising it, `runPaths` is the single
definition of ARCHITECTURE §4's layout, and `createRunDir` is a bare `mkdir` —
ADR-0001's guard without the race an `existsSync` check leaves — which only
`--replay` may reuse. `src/source/candidate.ts` names a candidate by **lifting
the post title or falling back to the company's own address**, never composing
one, and reads a title as a name only when a separator splits a short head from
a tail.

Then the command ([worklog 0021](./worklog/0021-stage-1-wired.md)).
`src/source/index.ts` is stage 1 end to end and its order is load-bearing:
**dedup, rank, cut, resolve** — resolution is one request per company, so
cutting before it keeps a 200-post result set to `--limit` requests, and ranking
before cutting is the fix the first live run forced. It makes the run-level
failure decision ARCHITECTURE §5 was owed (inconsistency 24): `SourceError` is
`source_dead` when every request failed, `no_hits` when the source had nothing,
`no_candidates` when nothing survived — and a failed run writes its manifest
before throwing, because that is the run a reviewer most needs to read.
`--no-expand` cuts the four arms as well as the planning (inconsistency 31,
decided). A yield under 10 sites fires the documented fallback — window widened
to 730 days, recorded in the manifest. The `urls` seed form makes **no**
requests: nothing to disambiguate without a post, and stage 2 fetches the site
as citable evidence anyway. `src/manifest.ts` is the run record all three stages
append to, with the git sha, the flags as parsed, per-arm yields, per-candidate
status and every decision the run took — `writeStage` merges, so stage 2 cannot
erase how stage 1 found its candidates.

**The first live run happened** mid-ticket — before the command existed, by
driving the modules in the order it would call them, against live HN Algolia (`"LLM observability"`, `--limit 10 --since 180`, 15
requests, 13.5s, scratch directory, nothing committed). It is not the sample run
(D-5) and it is not the gate (TICKET-0013). What it measured is recorded in
inconsistencies 36–40 below, and one number belongs here: **the probe returned
50 hits, 35 of them usable**, against a `--min-hits` default of 8. On a query at
the centre of the thesis the threshold is nowhere near binding.

The command itself has since run live: `./pipeline source --seed "LLM
observability" --limit 12` produced 12 candidates in 15 requests, a manifest
carrying the git sha and a `query_plan.json` recording `chosen_by: probe`; a
re-run of the same id refused; a two-line url list for one company produced one
candidate with two provenance entries. **Nothing from those runs is committed** —
the sample run is TICKET-0028's and its topic is D-5.

`prompts/clarify-query.v1.md` and `prompts/CHANGELOG.md` exist and nothing reads
them: the prompt waits on 0018 for a provider and on 0020/0021 for the rubric
that fills its `{{thesis}}` placeholder.

**The gate has reported.** TICKET-0013 ran stage 1 against four live topics —
`AI agent infrastructure`, `LLM observability`, `vector database`, `eBPF
observability` — and all 48 candidates were read by hand
([worklog 0022](./worklog/0022-gate-hand-check.md)). The numbers everything
downstream now rests on:

| Measure | Result |
|---|---|
| Junk (not a company and not a product surface) | **5 of 48 — 10%**, and **4 of the 5 came from one run** |
| Duplicate candidates | 2 of 48. Coroot took three of twelve slots on one run |
| Fallback names (`owner/repo` or a bare domain) | 13 of 48 — 27%, of which 7 are avoidable |
| Probe yield, three normal topics | 26, 33 and 35 usable of 50 — 3–4× `--min-hits` |
| Probe yield, the narrow topic | **3 of 6** — under the threshold, and the source of 4 of the 5 junk |

**D-6 is closed: keep `--min-hits 8`.** The argument is not the yield numbers,
it is that the one topic that fell under the threshold is the one topic that
produced a bad list. The threshold is behaving as a junk predictor and not just
a yield gauge. **D-5 is taken at its default: `AI agent infrastructure`** — 12
of 12 companies, no junk, no duplicates — with a recorded counter-argument that
a uniformly positive memo set demonstrates the thesis less well than `vector
database`'s messier one would.

**One gate question could not be answered.** *Were the clarification options
good, or was "keep my original" always right?* The clarifier is a seam until
TICKET-0018, so all four runs recorded `probe` or `non-interactive` and nobody
was ever asked. It moves to TICKET-0018 rather than being guessed at.

**Five defects go back to their own tickets**, per TICKET-0013's instruction —
three canonicalisation fixes reopen **TICKET-0010** (code-host urls collapsed to
their repo root; `blog.` subdomains; registry hosts) and two classifier fixes
reopen **TICKET-0009** (owner-over-generic-repo-name; ACM's proceedings host).
Estimated effect on the gate's own 48: junk 5 → 1, fallback names 13 → 6. The
survivor is the repo ↔ company-site join, which needs TICKET-0015's `homepage`
field and must not be guessed at with name similarity.

**The LLM seam exists** ([worklog 0025](./worklog/0025-llm-provider-and-cache.md),
TICKET-0018). `src/llm/cache.ts` is the committed half of the replay guarantee:
content-addressed on the *whole* call — provider, model, prompt id, prompt
version, output schema version and the rendered input — so CLAUDE.md invariant 6
lives in one function. A hit is verified against the fields it was keyed on
rather than trusted because the filename matched; the first answer wins, because
a model is not deterministic and re-writing an entry would quietly change what a
committed run replays to; and a miss reports *why*, because `--replay` has to
fail with a reason rather than quietly call an API the operator asked it not to.
`src/llm/provider.ts` is `createModel(role)` — LangChain's model wrapper and
`withStructuredOutput` and nothing else, three packages pinned exact, loaded
behind `await import` so no offline path ever imports a provider SDK — plus
`callModel`, which puts the cache in front of it. `--replay` on a cold cache
throws; a cached answer that no longer fits its schema throws telling the
operator to bump the version rather than silently re-spending. Token counts are
recorded per call; **`PRICES` ships empty**, so `cost_usd` is `null` until
somebody fills a price table in from a price page on a date — a committed
manifest is not the place for a guessed number. **Nothing calls any of this
yet, and it has never talked to a live provider.** TICKET-0018 is Done.

**Wiring the clarifier costs a prompt v2.** `withStructuredOutput` requires an
object schema, and `prompts/clarify-query.v1.md` ends by asking for a bare JSON
array (inconsistency 52). That plus the `{{thesis}}` placeholder — which needs
the rubric, TICKET-0021 — is why the gate's one unanswered question (*were the
clarification options actually good?*) is **still** unanswered, and why the
0011 re-open is not the next thing to pick up.

| Area | State |
|---|---|
| Thesis and rubric | Written, **unvalidated against any real company**. The gate validated the *input* to scoring, not the scoring |
| Architecture and stage contracts | Written; contracts implemented in `src/contracts/` (0005) |
| ADRs 0001–0008 | Written |
| Test strategy | Written; 409 tests — 19 CLI (0003, 0012), 35 contracts (0005, 0011, 0012), 14 config (0006), 19 evidence store (0007), 45 fetch and extraction (0008), 48 HN parse, classifier and search (0009, incl. 5 from the gate's F2/F4), 72 canonicalisation, dedup and redirect resolution (0010, incl. 14 from the gate's F3/F5), 34 probe and query planning (0011), 24 run identity, 37 candidate derivation (incl. 3 from the gate's F1), 12 manifest and 28 stage-1 wiring (0012), 25 LLM cache and provider (0018, all against a stub model). Offline, no key — see inconsistency 42 for the one commit where that was not true |
| Worklogs 0001–0025 | Factual sections written; reflections pending (see D-4) |
| Ticket backlog | [docs/tickets/](./tickets/) — 30 tickets: 16 Done (0009 and 0010 reopened by the gate and closed again; 0011 reopens for the clarifier call), 1 Ready (0014), 13 Blocked. Status is in each ticket header |
| Toolchain | `pnpm install/test/typecheck/lint` all pass, offline, no key (0001) |
| CLI surface | `src/cli.ts` — four commands, flags and `--help` pinned and tested (0003) |
| Exit codes | `src/exit-codes.ts` — 0/1/2/3, plus a temporary 70 for unimplemented stages (0003) |
| Stage contracts (code) | `src/contracts/` — six schemas, versioned, plus `parseOrDrop` (0005). `QueryPlan` is at `schema_version` 2 — `probe` is nullable (0011). `Candidate` is at `schema_version` 2 — `provenance` is a non-empty list, primary first, carrying `title`, `posted_url` and `posted_at` (0012) |
| Config and model routing | `src/config.ts` — role-scoped LLM config, GitHub degraded mode, `.env` loading (0006) |
| Evidence store | `src/evidence/store.ts` — content-addressed ids, truncation, typed misses (0007) |
| Fetch layer | `src/evidence/fetch.ts` — cache, bounded retries, `fetch_failed` records, `cheerio` HTML→text, `fetchEvidence(url, type)` (0008, Done) |
| HN adapter | `src/source/hn.ts` — url building, four expansion arms, tolerant hit parsing, usable-vs-unusable classifier, paginated `searchHn` with failures as data (0009, Done, reopened and closed again by the 0013 gate: ACM's host and `BLOG_SUBDOMAIN`) |
| URL resolution and dedup | `src/source/resolve.ts` — canonicalisation, site keys, `dedupeHits`, redirect-following `resolveSites`; `identityPath` collapses a url pointing inside a repo or a package (0010, Done, reopened and closed again by the 0013 gate) |
| Query planning | `src/source/plan.ts` — `probeSeed`, `planQuery`, the `query_plan.json` artifact, the clarifier seam and the model-output sanitiser (0011, Done) |
| Run identity | `src/run.ts` — `deriveRunId`/`validateRunId`, `runPaths` (ARCHITECTURE §4 in one place), `createRunDir` and ADR-0001's overwrite guard (0012, Done) |
| Candidate derivation | `src/source/candidate.ts` — `deriveName` (lift or fall back to the domain; never compose), `nameFromKey` drops a generic repo slug to its owner (the gate's F1), `slugFor`, `toCandidates`, and `candidatesFromUrls` for the `urls` seed form (0012, Done) |
| Stage 1 wiring | `src/source/index.ts` — `runSource`: plan → search → dedup → rank → cut → resolve → candidates, the run-level failure decision, the thin-yield fallback (0012, Done) |
| Run manifest | `src/manifest.ts` — git sha, flags, per-arm yields, per-candidate status; `writeStage` merges so later stages append (0012, Done) |
| LLM response cache | `src/llm/cache.ts` — committed and content-addressed on the whole call (provider, model, prompt id, prompt version, output schema version, rendered input); a hit is verified against the fields it was keyed on; the first answer wins; a miss says why (0018, Done). **No entry is committed yet** |
| LLM provider seam | `src/llm/provider.ts` — `createModel(role)` behind `await import`, `callModel` through the cache, `--replay` fails loudly on a cold cache, tokens recorded per call, `PRICES` ships empty so `cost_usd` is `null` (0018, Done). **Never run against a live provider** |
| Prompts | `prompts/clarify-query.v1.md` and `prompts/CHANGELOG.md` — written, versioned, **not wired** (0011). v1 asks for a bare JSON array, which `withStructuredOutput` cannot express — wiring it costs a v2 (inconsistency 52) |
| `setup.sh`, `./pipeline` | Steps 1–5 done (0004). Step 6, the offline self-verification, waits on 0026 and 0028 |
| Stages 1–3 | **Stage 1 runs and has been audited** (TICKET-0013, four live topics): `./pipeline source` produces `candidates.jsonl`, `query_plan.json` and `manifest.json`, verified against the live API. Stages 2 and 3 still exit 70 (0022, 0026), and so does `run` (0027) |
| Sample run, walkthrough video | Not started. Topic chosen (D-5): `AI agent infrastructure` |

---

## Open decisions

`Default if unanswered` exists so a new session is never blocked. Take the
default, state that you took it, and record it in that session's worklog.

| # | Decision | Blocked on | Default if unanswered |
|---|---|---|---|
| **D-2** | Memo rendering: `eta` templates vs typed TS render functions | Author preference | `eta` — a partner can edit a memo template without reading TypeScript |
| **D-4** | Reflection sections in worklogs 0001 and 0002 | Author. Must not be AI-written — see CLAUDE.md | Leave as `TODO(author)`. Do not fill in |
| **D-7** | Whether ADR-0005 and ADR-0006 clear the "someone would disagree" bar | Author review | Keep both. Revisit only if a reviewer calls the ADR set padded |

### Recently closed

- **D-5 · the committed sample run topic** — taken at its default in
  TICKET-0013: **`AI agent infrastructure`**. Of the four topics the gate ran it
  is the cleanest by every measure — 12 of 12 candidates are companies, no junk,
  no duplicates, one fallback name — and it exercises redirect resolution
  (`Kampala` → `zatanna.ai`) and the expansion arms (+59, +22 new posts) so a
  reviewer sees those paths work. **The counter-argument is on the record and is
  the author's to overrule:** all twelve are launched, mostly YC-backed
  companies, so the memo set may come out uniformly positive, and a memo set
  with no interesting Pass in it demonstrates the thesis less well.
  `vector database` — 11 companies, 5 of them hobby repos owned by personal
  accounts — is the messier, more falsifiable alternative and costs one re-run
  to switch to at TICKET-0028. See
  [worklog 0022](./worklog/0022-gate-hand-check.md).
- **D-6 · the probe threshold `--min-hits 8`** — closed in TICKET-0013: **keep
  8.** Measured on four live topics. Three normal ones probed 26, 33 and 35
  usable of 50 — three to four times the threshold, so it is nowhere near
  binding and costs one request. The fourth (`eBPF observability`) probed **3 of
  6**, fell under it, and was also the run that produced four of the gate's five
  junk candidates and three separate entries for one company. The threshold is
  behaving as a **junk predictor** rather than only a yield gauge, which is a
  better argument for 8 than the yield numbers are. Both caveats stand: `usable`
  is an upper bound (inconsistency 21) and the probe is one page of `story`
  results, not the four arms.

- **D-1 · default model in `.env.example`** — taken at its default in
  TICKET-0001. `MODEL_EXTRACT` and `MODEL_ANALYSE` ship empty with their roles
  named in comments. Worklog 0004 said `setup.sh` would prompt for them;
  TICKET-0004 shipped it naming the four variables to fill in instead — see
  inconsistency 7 below and worklog 0007.
- **D-3 · the `feed` seed form** — cut in TICKET-0002, at its default. The seed
  surface is `topic` and `urls`. Recorded as a consequence in ADR-0004 rather
  than as a new ADR, because it aligns the docs to a decision already accepted.
- **D-8 · `@mozilla/readability` and its DOM** — raised in TICKET-0008, answered
  by the author the same day, at its default: **`cheerio` alone**. Readability
  takes a DOM `Document`, so shipping it means `jsdom` too — the largest runtime
  dependency in the project, added for prose this pipeline barely reads.
  Recorded as an amendment to
  [ADR-0005](./adr/0005-typescript-stack.md), which is where the original
  `cheerio` + readability pairing was decided, and in
  [worklog 0012](./worklog/0012-cheerio-only-extraction.md). The decision landed
  one commit ahead of its code, deliberately; the code followed in
  [worklog 0013](./worklog/0013-cheerio-extraction.md) and TICKET-0008 is Done.

### Deliberately closed — do not reopen without a new ADR

- **Eval harness** — cut from v1. Cost documented in `SCOPE.md` and `TESTING.md`.
  Do not quietly reintroduce one, and do not claim the rubric is validated.
- **Additional sources** beyond HN and GitHub — ADR-0004.
- **Database, queue, vector store, web UI, agentic browsing** — `SCOPE.md`.
- **LLM-generated scores** — ADR-0002. This one is load-bearing.

---

## Known inconsistencies in the committed docs

Real defects, listed rather than silently patched.

1. ~~**`feed` seed form is unspecified and its example contradicts ADR-0004.**~~
   Fixed in TICKET-0002. `SPEC.md` §3.1 and `ARCHITECTURE.md` §1 and §7 now name
   two seed forms, and ADR-0004 records the cut.
2. ~~**`.env.example` is referenced but does not exist.**~~ Fixed in
   TICKET-0001; `ARCHITECTURE.md` §7.1 step 4 now resolves.
3. **The sample run id is a placeholder** (`<committed_sample>`) in
   `README.md`, `ARCHITECTURE.md`, and `SCOPE.md`. D-5 is now settled — the
   topic is `AI agent infrastructure` — but the run id is not minted until
   TICKET-0028 actually commits a run, so the three placeholders stand until
   then and are replaced there.
4. **Worklog index dangling link.** Commit `1035b1d` lists session 0002 before
   its file exists at `f5e1938`. Transient, one-commit window, left as-is rather
   than rewriting history.
5. **`setup.sh` step 6 cannot pass yet.** Addressed but not closed in
   TICKET-0004: steps 1–5 ship, step 6 does not, and both the script's closing
   output and ARCHITECTURE §7.1 now say so. The check itself still does not
   exist, and SCOPE #11 is not closed until TICKET-0028 adds it.
6. **`docs/worklog/README.md` promises `docs/evals/`** — *"how prompt and rubric
   changes were evaluated … arrives with the first golden set"*. There is no
   golden set and there will not be one; the eval harness was cut (`SCOPE.md`,
   `CLAUDE.md`). Fix the row in TICKET-0029; do not fix it by building evals.
7. **`setup.sh` does not prompt for the model names.** `.env.example` and
   STATE D-1 both said it would. TICKET-0004 shipped step 4 printing the four
   variables that need filling in rather than reading them interactively: a
   prompt that writes an API key into a file is more surface than the problem
   needs, and stage 1 already owns the project's one interactive path
   (SPEC/CLAUDE.md: never without a TTY, never on replay). `.env.example` was
   corrected to match the code. Flagged rather than assumed — if the author
   wants the prompt, it is a small addition to step 4.
8. **`Fact` has a field ARCHITECTURE §2 did not list.** TICKET-0005 added
   `Fact.key` — a stable identifier like `founder.prior_exit` — because the
   sketched shape left `src/analyse/score.ts` with prose as its only handle on
   which fact it was scoring, and a rubric that pattern-matches English is not
   deterministic scoring (ADR-0002). ARCHITECTURE §2 was updated in the same
   commit, so the docs agree; this is listed because it is an addition to a
   spec'd shape, not a transcription of it. The key *vocabulary* is still
   unspecified on purpose and lands with TICKET-0020/0021.
9. **`Analysis` does not yet carry everything a memo needs.** SPEC §4 wants a
   Team/Product/Market/Risks split, a "what would change my mind" list, and a
   checkable upgrade trigger on every Watch — and stage 3 has no LLM to invent
   them (CLAUDE.md invariant 3), so they must come from stage 2. TICKET-0005
   shipped only the fields ARCHITECTURE §2 lists, rather than guessing at the
   rest before any real analysis exists. Resolve at TICKET-0022, before
   TICKET-0024 needs it. Adding fields to `Analysis` then is a `schema_version`
   bump, which is cheap now and not later.
10. **ADR-0006 names three providers; two ship.** Its sketch line reads
    `LLM_PROVIDER=openai | anthropic | ollama`, while its decision paragraph
    names `@langchain/openai` as the default adapter and `.env.example` — the
    file an operator actually reads — says `openai | anthropic`. TICKET-0006
    shipped the two in `.env.example` rather than a third with no adapter behind
    it. Adding `ollama` is a case in the factory (TICKET-0018) and a line in
    `LLM_PROVIDERS`; until then the ADR line is aspirational and is flagged here
    rather than quietly edited.
11. **LLM config is validated per role, not per run.** `requireLlmConfig`
    resolves only the variables the role about to run will read, so
    `./pipeline source` does not fail on a blank `MODEL_EXTRACT` and
    `./pipeline run` can get as far as stage 2 before discovering one is
    missing. Deliberate — "fail late" cuts both ways and `source` is a complete
    command on its own — but if it stings, a preflight check belongs in
    TICKET-0027's `run`, not in `config.ts`.
12. **`ConfigError` has no exit-code mapping yet.** The `--help` epilogue
    promises exit 1 for a configuration error and `ConfigError` is built to be
    caught, but nothing calls `requireLlmConfig` yet, so the handler would guard
    an impossible throw. Lands with TICKET-0018, the first LLM call.
13. ~~**TICKET-0013's gate range was a cycle.**~~ Fixed while flipping ticket
    statuses. It read `Blocks: 0014–0022`, which swallowed TICKET-0018 — but
    TICKET-0011 needs the provider seam for its clarifier and 0011 is upstream
    of 0012, which is upstream of the gate. 0018 is mechanism with no thesis
    content, so it now sits outside the gate and the range reads
    `0014–0017, 0019–0022, 0028`. Eight further `Depends on` / `Blocks` edges
    were wrong in the same pass — see worklog 0009.

---

14. **`EVIDENCE_TEXT_LIMIT` is an unmeasured guess.** TICKET-0007 pinned
    per-record text at 8,000 characters — roughly 2k tokens of prose — because
    ADR-0003 names bundle length as the cost of closed-world citation without
    naming a number. It is one constant in `src/evidence/store.ts` and it is
    labelled as a guess in the code. Revise at the first real extraction call
    (TICKET-0020), not before. Not raised to an open decision: there is no fork
    behind it, only a number.
15. **`makeEvidence` is the only sanctioned constructor, by convention.**
    `Evidence.parse({ ... })` still works from anywhere, so an adapter that
    assembles a record literal can skip the id helper and the text limit. Fine
    at this size, and the reason `write` recomputes the id rather than trusting
    it. If more constructors-by-convention accumulate, a branded type is the fix.

16. **`HTTP_CACHE_MAX_AGE_MS` is an unmeasured guess, and it is load-bearing.**
    A cache hit replays the stored `retrieved_at`, which is what makes a re-run
    produce the same evidence ids — and also what makes a stale entry able to
    misdate a run. TICKET-0008 pinned 24 hours: long enough for a working
    session and a re-run after a crash, short enough that a citation cannot be
    wrong by more than a day. Revise at the first multi-day run. Same kind of
    labelled guess as 14; no fork behind it, only a number.

17. **`MAIN_MIN_CHARS` is the third unmeasured guess in the evidence layer.**
    `extractHtml` treats a matched main block shorter than 200 characters as a
    client-rendered empty shell and falls back to `<body>`. The failure it
    prevents is real — a marketing site shipping `<main id="root"></main>` would
    otherwise extract nothing — but 200 is a number, not a measurement. Same
    class as 14 and 16, and the three of them together are worth a look at the
    first real extraction (TICKET-0016) rather than one at a time.

18. **Extraction is not a pure transcription of the page.** Two deliberate
    departures, both from TICKET-0008's second half
    ([worklog 0013](./worklog/0013-cheerio-extraction.md)): the `og:` or
    `<meta>` description is *prepended* to the extracted text — because the
    model reads `text` and not `meta`, and it is often the crispest sentence on
    the page — and `<header>` is **kept** while `nav`, `footer` and `aside` are
    stripped, because a company site's hero usually lives there. The url and
    `retrieved_at` are unchanged, so citations still resolve to the page the
    text came from, but a reader comparing the record to the live page will find
    the first line reordered and may find nav text that lives inside `<header>`.
    `meta.main_selector` on every record says which block was selected. Flagged
    rather than assumed: if a reviewer wants extraction to transcribe only, both
    are a few lines to reverse.

19. **`--since` is day-granular, and is up to 24 hours wider than it reads.**
    `hnSearchUrl` floors the `created_at_i>` boundary to the start of a UTC day
    rather than computing it from the clock, so `--since 180` means "180 days
    before midnight today". The reason is cache identity, not convenience: a
    boundary to the second makes every invocation a new url, which misses the
    fetch cache, which re-fetches, which mints a new `retrieved_at` and therefore
    new evidence ids for the same page. Flagged because the flag's help text
    says `source window` and a reader would assume it means "from now". If exact
    windows ever matter more than reproducible ids, the fix is to pass an
    explicit window boundary in rather than to unfloor this.

20. **The HN fixtures are one topic, captured by hand.** All five files under
    `tests/fixtures/hn/` come from `llm observability` — a query close to the
    thesis's centre, so the parser is being tested against a favourable result
    set. Four are real captures; `search-malformed.json` is `search-page-0.json`
    hand-edited with five defects, and its README says so. The `curl` commands
    are recorded there so TICKET-0014's capture script can reproduce them, and
    that ticket is where a second, deliberately awkward topic should be added.

21. **The classifier accepts by default, so the usable count is an upper bound.**
    `classifyHit` rejects only what a narrow, nameable rule matches — no url, a
    paper host or `.pdf`, a discussion or social host, a publishing platform, or
    an article-shaped path — and passes everything else. The asymmetry is
    argued in [worklog 0015](./worklog/0015-hn-usable-classifier.md): a wrong
    reject leaves no trace anywhere in the output, a wrong accept costs one
    analysis and is visible in a memo. Two consequences a reviewer should hold
    onto. D-6's threshold is compared against a number that is systematically
    generous. And there is a false positive class the url alone cannot see — a
    trade blog on its own domain with no article path — which is pinned by a
    test asserting the *wrong* answer on purpose, so 0013 meets it rather than
    inherits it silently.

23. **`HN_MAX_PAGES_PER_ARM` is a fourth unmeasured guess, and the cheapest one
    to be wrong about.** `searchHn` reads at most two pages an arm — eight
    requests and up to 400 hits for one seed. Page 2 of a relevance ranking is
    already past what a human would read and `--limit` cuts far below it, but
    that is an argument, not a measurement. Same class as 14, 16 and 17; one
    constant, labelled in the code. TICKET-0012 may lower it from the CLI, and
    the first real run (TICKET-0013) should say whether page 1 earned its
    requests at all.

24. **`searchHn` does not fail the run, and ARCHITECTURE §5 says something
    fails it.** §5's row reads *"Source API 429/5xx → retry with backoff,
    bounded. Then fail the run — no candidates means no pipeline."* The adapter
    retries (via `httpGet`) and then returns the dead page in `failures[]`
    rather than throwing, because four arms over two pages is up to eight
    requests and one failure among them is not "no candidates". The decision §5
    describes is therefore **owed by TICKET-0012**, which sees the whole result
    set — and until 0012 ships, a run with every arm dead would return an empty
    list with a full `failures[]` and nothing would act on it. Flagged rather
    than assumed: a reviewer who reads §5 strictly would put the throw in the
    adapter, and that is a small change here plus a `try` in 0012.

22. **A repo counts as a company.** `github.com/...` and `*.github.io` classify
    as `code_repo` and are usable, which TICKET-0009's own wording neither
    requires nor forbids. The reasoning is the thesis — "adopted before it is
    sold" makes the repo the product surface for a dev-tools launch, and
    ADR-0004 already treats GitHub as the enrichment source. The cost is that a
    weekend project and a seed-stage company look identical to this layer.
    **The gate measured it: 10 of 48 candidates are open-source projects with no
    company behind them, and from a url alone they are indistinguishable** — but
    one free signal separated all ten. Every hobby project was owned by a
    **personal** GitHub account (`satyasairay`, `visionscaper`, `Agastya910`,
    `pandyamarut`, `nullswan`); every candidate that turned out to be a company
    was owned by an **organisation** (`getomnico`, `HelixDB`, `InsForge`,
    `penca-io`, `XTraceAI`, `coroot`, `linnix-os`, `Infisical`,
    `kontext-security`). `ccfos/huatuo` is the exception that keeps it a signal
    rather than a rule: an org, and a foundation rather than a company.
    `GET /users/<owner>` returns `type: "User" | "Organization"` in one request
    TICKET-0015 makes anyway. **It is a fact for the rubric, never a stage-1
    filter** — narrowing on it would be exactly the widening-yes-narrowing-no
    violation. This inconsistency stays open: the question it asks is whether
    *stage 2's scoring* separates them, and stage 2 does not exist.

25. ~~**`Candidate.provenance` is singular and dedup produces a group.**~~
    Fixed in TICKET-0012 ([worklog
    0020](./worklog/0020-run-identity-and-candidates.md)). `provenance` is a
    non-empty list, primary first, at `schema_version` 2 — one shape with a
    documented order rather than a singular primary plus an `also_seen` list,
    which would be two shapes a reader has to merge. It also gained `title`,
    `posted_url` and `posted_at`.

26. **`SHARED_SUFFIXES` is a hand-written stand-in for the public suffix list.**
    `registrableDomain` needs to know that `co.uk` is nobody's domain and that
    every `*.github.io` is a different owner. The real Mozilla list is a runtime
    dependency and a megabyte of data (no new dependency without an ADR line),
    so `resolve.ts` carries a hand-written list instead. The cost is precise: an
    unlisted multi-part ccTLD — `acme.com.sg` if `com.sg` were missing — resolves
    to the suffix as its registrable domain and would collapse two unrelated
    companies into one candidate. That is the direction the file argues is
    dangerous, so the list leans long, and TICKET-0013's hand-check is where a
    gap would surface. Same class of labelled guess as 14, 16, 17 and 23.

27. **Dropping `ref` from a query string is a guess with teeth.** Canonicalisation
    strips `utm_*`, `ref` and a dozen named campaign parameters, so a site that
    gives `ref` a load-bearing meaning has two distinct pages collapse to one.
    Nothing in the fixtures does, and keeping it means the same launch posted
    twice with different referrer tags becomes two candidates — the exact failure
    TICKET-0010 exists to prevent. Named in the code beside the list.

28. **Two repos from one GitHub org stay two candidates.** `siteKey` keys code
    hosts on `host/owner/repo` rather than on the owner, so one company shipping
    two repos is two candidates. Deliberate, and the same asymmetry as 21 pointed
    the other way: a wrong split costs one duplicate analysis a human sees in the
    memo list, a wrong collapse deletes a company with no trace. The related
    join this layer structurally cannot make is `acme.dev` ↔
    `github.com/acme/acme` — nothing in either url says they are the same thing.
    TICKET-0015 reads a repo's homepage field, which is where that belongs.

29. **`chosen_by: "non-interactive"` does three jobs.** ADR-0008's table gives it
    one meaning — no TTY — and `planQuery` reaches it from three places: no TTY,
    no clarifier wired (TICKET-0018 has not landed), and a clarifier or chooser
    that threw. All three are honestly described by "nobody was asked", and none
    of them is distinguishable in the committed artifact. A reviewer who wants a
    run to be able to say *the provider was down* rather than *nobody was there*
    needs a fourth `ChosenBy` value and a `schema_version` bump. Flagged rather
    than guessed at, because the third case does not exist until 0018 does.

30. **The clarification prompt cannot state the thesis, and ADR-0008 says it
    should have seen it.** CLAUDE.md invariant 7 puts the thesis in exactly one
    place — the rubric in `src/analyse/score.ts` — and forbids restating it in a
    prompt as free text. `prompts/clarify-query.v1.md` therefore carries a
    `{{thesis}}` placeholder to be interpolated from the rubric at call time.
    The rubric does not exist yet (TICKET-0020/0021), so the prompt is written
    and unwired, and the interpolation has never been run. Recorded in
    `prompts/CHANGELOG.md` as well. If the rubric turns out not to have a form
    that reads as a paragraph to a model, this is where that surfaces.

31. **`--no-expand` is honoured for planning and its effect on search is
    undecided.** `planQuery` skips the probe and the clarifier on the flag,
    which is ADR-0008's row. Whether it *also* cuts `expandQuery`'s four arms
    from the search that follows is TICKET-0012's call — the flag's own help
    text says "use the raw seed verbatim", which reads like it should, and the
    ADR only speaks about planning. Named here so 0012 decides it deliberately
    rather than inheriting whichever behaviour falls out of the wiring.

32. **Two things called `root`, one letter apart in meaning.**
    `evidenceStore(id, root)` takes the **runs** root (`runs/`) and
    `runPaths(id, root)` takes the **repo** root, so `runPaths(id, ".")` and
    `evidenceStore(id, "runs")` name the same directory. `RUNS_ROOT` is now
    defined once, in `src/run.ts`, and re-exported from the store, so the
    string cannot drift — but the two parameters can still be swapped by a
    caller who reads only one signature. Both are documented at their
    definitions. The wiring at TICKET-0012 is the first caller of both and is
    where a mistake would show up; if it stings there, renaming the store's
    parameter to `runsRoot` is a one-line change to a Done module.

33. **The name-shape budgets are guesses, and one of them has a known false
    negative.** `src/source/candidate.ts` reads a post title as a name only when
    a separator splits off a head of at most 4 words and 40 characters that does
    not start with a sentence opener (`we`, `how`, `a`, `the`, …). The rule's
    cost is precise and deliberate: a real name that opens with an article —
    "The Browser Company" — falls back to its domain, and a memo headed
    `acmetraces.dev` is plain where one headed "We Rewrote Our Tracer" is wrong.
    Same class of labelled guess as 14, 16, 17, 23 and 26. The hand-check at
    TICKET-0013 is where the junk-name rate gets a number, and the cheaper rule
    it might argue for is: no separator, no name — drop the word budget entirely.

34. **`MAX_SEED_SLUG_LENGTH` is a number, and non-ASCII seeds get
    `2026-08-22-run`.** `slugify` is ASCII-only, so a seed in another script
    produces the fallback slug rather than a transliteration nobody asked for;
    `--run` is the escape hatch and the error message does not currently say so.
    Cheap to fix if it ever matters, flagged rather than fixed on a guess.

35. **`--replay` reuses a run directory, and stage 1 would rewrite
    `candidates.jsonl` inside it.** `createRunDir(id, { allowExisting })` is the
    only exception to ADR-0001's overwrite guard, and `--replay` is what sets
    it. `planQuery` already reads an existing `query_plan.json` rather than
    re-prompting, so the plan is safe — but the search that follows would run
    again (largely from the 24-hour HTTP cache) and rewrite the candidate list.
    Whether a replay should instead read the committed candidates back is
    TICKET-0027's replay semantics; the flag's own help text says "reuse cached
    LLM responses", which is narrower than what it now also permits.

36. ~~**Package-registry hosts collapse every package into one candidate.**~~
    **Fixed** in the reopened TICKET-0010 as F5
    ([worklog 0023](./worklog/0023-gate-fixes-canonicalisation.md)):
    `REGISTRY_DEPTHS` gives eight registries the number of leading path segments
    that name one package, keyed on the host so `hub.docker.com` does not reduce
    to `docker.com`. Tested and **never yet fired against real data** — no
    registry url appeared in any of the gate's four topics. Original entry
    below.
    Found by the first live run: `pypi.org/project/logmera` became a candidate
    keyed on `pypi.org`, so a second PyPI launch in the same run would be merged
    into it and lost. `siteKey` keys code hosts on `host/owner/repo` and
    everything else on the registrable domain, and a registry is a code host
    that is not in `CODE_HOSTS` — `pypi.org`, `npmjs.com`, `crates.io`,
    `hub.docker.com`, `huggingface.co`. This is the wrong-collapse direction
    `resolve.ts` argues is the dangerous one: a wrong split costs a visible
    duplicate, a wrong collapse deletes a company with no trace. The fix is one
    list in `resolve.ts` plus tests; it was deliberately **not** taken while
    wiring stage 1, so that the change lands on its own and is reviewed against
    TICKET-0013's hand-checked list rather than against one example.

37. **The classifier's known false positives are now confirmed, not argued.**
    Inconsistency 21 predicted two classes the url alone cannot see. Both
    appeared in the first ten candidates of the first live run:
    `machinelearningmastery.com/llm-observability-tools-…` (trade press on its
    own domain, no `/blog/` in the path, so `ARTICLE_PATH` misses it) and
    `glukhov.org` (a personal blog that is not in `PERSONAL_HOSTS`). Two junk in
    ten. Left alone on purpose: TICKET-0013 is the gate that is supposed to make
    this call against a hand-checked list, and tightening a classifier on two
    examples is how it starts rejecting real companies.
    **The gate answered it.** Neither of those two urls recurred — ranking by
    traction demoted both — but the *classes* did, on a different topic:
    `blog.zmalik.dev/p/…` is the same personal-blog class and
    `camps.aptaracorp.com/ACM_PMS/…` is a paper on a host `PAPER_HOSTS` never
    heard of. Two narrow, nameable rules go back to TICKET-0009 and TICKET-0010
    (fixes F2 and F4); the classifier is **not** made smarter in general, which
    is what tightening on two examples would have meant. **Both landed**
    ([worklog 0024](./worklog/0024-gate-fixes-classifier-and-naming.md)):
    `aptaracorp.com` — ACM's typesetting vendor — joined `PAPER_HOSTS`, and
    `BLOG_SUBDOMAIN` rejects a host that announces itself as a blog. F4 shipped
    **without** its proposed `/p/<slug>` half: that is one publisher's
    convention rather than a shape of the web, and `acme.dev/p/pricing` is a
    product page. Both junk candidates are gone from a re-run.

38. **On one topic the three expansion arms contributed nothing.** `show_hn`
    returned 42 hits and 0 new, `launch` 4 and 0, `funding` 0 and 0 — the `raw`
    arm's two pages already contained all 70 posts. Three of five pages bought
    nothing on this query. One topic is not a measurement, and the arms exist
    for the topics where the raw seed is thin, which is exactly not this one.
    Recorded because it is the first evidence bearing on inconsistencies 23
    (`HN_MAX_PAGES_PER_ARM`) and 31 (`--no-expand`), and because the fixture
    capture at TICKET-0014 should include a topic where the arms do earn their
    requests — otherwise the suite only ever tests the case where they do not.
    **Four topics now, and the answer changed.** `show_hn` contributed **+59**
    new posts on `AI agent infrastructure` and **+23** on `vector database`, and
    0 on the two thin topics — the right way round, since a thin topic has
    nothing to add. `launch` earned one request of four. See inconsistency 46
    for the arm that earned none.

39. **A 404 stays a candidate.** `github.com/anilatambharii/argus-ai` returned
    404 during redirect resolution and became candidate 9 of 10. `resolveSites`
    keeps a site whose request failed on purpose (a company that 403s a bot is
    still a company), and ARCHITECTURE §5 says a candidate's unreachable site is
    a `fetch_failed` record and a coverage drop, not a rejection. The cost is
    real anyway: a deleted repo will spend a stage-2 analysis to produce a memo
    that says nothing. Whether a hard 404 on the *only* url a candidate has
    should drop it is a TICKET-0013 question with real numbers behind it.
    **The numbers arrived: one unreachable site in 48 candidates across four
    runs.** Not a rate worth changing a rule for. Left as specified — a
    `fetch_failed` record and a coverage drop in stage 2, not a rejection in
    stage 1.

40. **A generic repository name makes a poor candidate name.**
    `github.com/torrix-ai/install` is named `torrix-ai/install` while its own
    post title says "Torrix" — the title uses a comma where the naming rule
    wants a separator. `betterdb-inc/monitor` and `lunargate-ai/gateway` have
    the same shape. Two directions exist (accept `, ` as a separator when the
    head is short; or prefer the owner over a generic repo name) and both are
    guesses until the hand-check at TICKET-0013 says how often this happens.
    **The gate measured it: 7 of 48 candidates, 15%, and half of all fallback
    names.** The second direction was taken, as fix F1, and it landed in
    `src/source/candidate.ts` — TICKET-0012's module, because that is where
    naming lives, and not TICKET-0009 where the gate scoped it
    ([worklog 0024](./worklog/0024-gate-fixes-classifier-and-naming.md)).
    **It fixes 3 of the 7, not 7 of 7:** `torrix-ai/install` → `torrix-ai`,
    `betterdb-inc/monitor` → `betterdb-inc`, `rocketgraph/rocketgraph` →
    `rocketgraph`. The other four have *distinctive* repo slugs — `bpfsnitch`,
    `autoagents`, `yantrikdb-server`, `xarray-sql` — and dropping those would
    lose the only word that tells two repos from one owner apart, so they are
    kept and pinned by a test. The comma-separator direction is still not
    taken; see inconsistency 49. **This entry was amended a commit late**: the
    same amendment was written during the gate and silently failed to apply,
    so `fd4fd1d` shipped an entry that had already been measured.

41. **Three failures share one exit code.** `SourceError` is `source_dead`,
    `no_hits` or `no_candidates`, and the CLI maps all three to exit 2, "the run
    completed but found too little to act on". The API being down is not really
    that — but exit 1 is the operator's invocation and exit 3 is a bug in this
    code, and a 503 from Algolia is neither. The message says which happened and
    the manifest records it. A reviewer who wants `source_dead` to be its own
    code needs a fifth exit code, a line in the `--help` epilogue and a row in
    ARCHITECTURE §7 — cheap, and not taken on a guess.

42. **The test suite fetched from the network, for one commit.**
    `tests/cli.test.ts` asserted that all four commands exit 70 and it spawns
    each one for real, so the moment `./pipeline source` became a real action
    `pnpm test` ran stage 1 against live HN Algolia and wrote `runs/2026-08-22-x/`
    into the repo. Caught by the assertion failing, fixed by taking `source` out
    of that list, and recorded here rather than quietly: CLAUDE.md's rule was
    not broken by adding a test, it was broken by a command becoming real
    underneath a test that had been correct the day before. The structural fix —
    a stubbed `fetch` in a vitest setup file, so no test *can* reach the network
    — is not taken yet, and is a reasonable thing for a reviewer to ask for.

43. **`--limit` is applied before redirect resolution, so a run can end with
    fewer candidates than it asked for.** Two vanity domains that resolve to one
    company merge after the cut, and nothing goes back for a replacement.
    Deliberate — refilling means more requests and a second ranking pass — but a
    manifest that says `limit: 12` above eleven candidates is not a bug.

44. ~~**A url that points *inside* something becomes a candidate for the thing
    it is inside.**~~ **Fixed** in the reopened TICKET-0010 as F3
    ([worklog 0023](./worklog/0023-gate-fixes-canonicalisation.md)), and the
    entry below described the wrong half of the defect. The dedup *key* was
    never broken — `siteKey` has always sliced a code-host path to
    `owner/repo`. What was broken is `canonical_url`, the url a candidate is
    named after and the one **stage 2 would have fetched as that company's
    evidence**: unfixed, the pipeline would have scored Alibaba's Anolis OS on
    the contents of one markdown file. `identityPath` truncates a code-host url
    to its repo and a registry url to its package; it **truncates and never
    rejects**, because `github.com/HelixDB/helix-db/tree/main` is a real company
    and `/tree/main` is just how a repo link gets pasted. All four of the gate's
    real deep urls collapsed on a re-run; no candidate was dropped, and the two
    clean topics were unchanged. Two of the five junk candidates therefore stop
    meeting the gate's definition of junk and join the ten that are *projects
    rather than companies* (inconsistency 22) — they did not disappear.
    `REPO_SUBPATHS` is a hand-written list and the seventh unmeasured guess in
    this codebase; it fails safe, since an unrecognised path segment is left
    alone. Original entry below. Three of the gate's five junk candidates share one shape:
    `github.com/alibaba/anolisa/blob/main/docs/…/agentsight.md` (a documentation
    page in Alibaba's monorepo, which became a company called "AgentSight"),
    `github.com/xqlsystems/xarray-sql/blob/claude/…/benchmarks/nn.py` (one
    Python file on a feature branch) and `demo.coroot.com/p/…` (a live demo
    instance of a company already in the same list). `canonicaliseUrl` strips
    tracking parameters and directory indexes but does not know that a code
    host's `/blob/` and `/tree/` paths are *inside* a repo rather than another
    repo. Scoped as fix F3 on the reopened TICKET-0010. The demo-instance case
    is not fixed by F3 and needs the repo ↔ site join — see 45.

45. **One company took three of twelve slots, and no url said they were one
    company.** On `eBPF observability` the gate produced Coroot three times:
    `github.com/coroot/coroot`, `coroot.ai` and `demo.coroot.com`. All three
    `siteKey`s are correct in isolation — a repo and a company site share
    nothing in their urls, `coroot.com` and `coroot.ai` are genuinely two
    registrable domains, and `demo.coroot.com` collapses to a `coroot.com` that
    was never itself a candidate. Inconsistency 28 predicted the first of the
    three and named the fix: the repo's `homepage` field, which **TICKET-0015**
    fetches. Deliberately **not** patched with a name-similarity heuristic in
    stage 1 — that is the wrong-collapse direction `resolve.ts` argues is
    unrecoverable. The cost is bounded and visible: 25% of one run spent on one
    company, on the run that could least afford it.

46. **The `funding` expansion arm returned zero hits on all four gate topics.**
    `expandQuery` builds `"<seed> raises seed funding"` and runs it `story`
    tagged; on `AI agent infrastructure`, `LLM observability`, `vector database`
    and `eBPF observability` it returned 0 hits and therefore 0 new posts, for
    four requests. As a full-text query against HN post *titles* it matches
    almost nothing. Not cut, because four topics is not a measurement and the
    arm exists precisely for the case where a company's only HN presence is a
    funding announcement — which none of these four contained. Named here so it
    is cut deliberately at TICKET-0028 if the sample run reproduces it, rather
    than surviving because nobody looked. Same class of labelled guess as 23.

47. **The thin-yield fallback buys volume by reaching back past the point where
    a launch is still a launch.** `eBPF observability` yielded 3 sites, fired
    the under-10 fallback, widened 180 → 730 days and re-searched to 13. **Every
    one of that run's five junk candidates came from the widened window** — an
    ACM paper from April 2025, a personal blog post from November 2025, a demo
    instance from December 2024. This is not an argument for cutting the
    fallback (3 candidates is not a pipeline) and the manifest already records
    loudly that it fired. It is an argument for reading `fallback.fired: true`
    in a manifest as *expect a worse list*, which nothing currently says.

49. **F1 reaches the org, not the company.** `github.com/torrix-ai/install` is
    now named `torrix-ai`, which is an improvement on `torrix-ai/install` and
    is still not the company's name. Its own post title says it: *Show HN:
    Torrix, self hosted, LLM Observability*. The rule that would reach "Torrix"
    is the direction inconsistency 40 named and did not take — accept `, ` as a
    title separator when the head is short. Not taken on n=1 across four
    topics, and because a punctuation rule fires on every comma in every HN
    title, which is a far wider change than a thirty-word list. `GENERIC_REPO_SLUGS`
    is itself the eighth unmeasured guess in this codebase and fails safe: an
    unlisted slug keeps `owner/repo`, exactly as before.

50. **A version string can be lifted as a name.** The candidate backfilled into
    the `eBPF observability` re-run after F2 and F4 removed two junk entries is
    named `Aacyn v0.7.0`. `looksLikeName` counts words and characters and has
    no opinion about version numbers, so the rule worked as specified and the
    output is still wrong. One example, no fix, recorded rather than patched on
    n=1 — the same discipline inconsistency 40 was held to, and 40 turned out
    to be worth waiting on.

51. **A thin topic gets thinner when junk is rejected.** `eBPF observability`
    now returns **11 candidates against `--limit 12`**: it had 13 sites, two
    were rejected by the new rules, and nothing goes back for a replacement
    (inconsistency 43). Rejecting junk on a thin topic does not promote a better
    candidate, it just shortens the list. Correct behaviour, and worth knowing
    before stage 2 reads a manifest that says `limit: 12` above eleven
    candidates.

48. **The gate was specified as a human reading a list, and an assistant read
    it.** TICKET-0013 says *"this is not a coding ticket; its deliverable is a
    written finding"* — the finding in [worklog
    0022](./worklog/0022-gate-hand-check.md) is AI-written end to end, including
    the classification of all 48 candidates into company / project / junk. Six
    borderline sites were fetched to confirm what they were; the rest were
    judged from url and post title. The junk rate that stages 2 and 3 are being
    released on is therefore an assistant's reading, and every candidate is
    named in the worklog so the author can check the ones that matter rather
    than re-doing all 48. Flagged rather than glossed: CLAUDE.md's attribution
    rule is about modules, and this is the first time it applies to a *judgement*.

52. **`clarify-query` v1 asks for a shape structured output cannot express.**
    The prompt ends *"Return **only** a JSON array of strings"*, and
    LangChain's `withStructuredOutput` takes an **object** schema
    (`RunOutput extends Record<string, any>`). Wiring the clarifier therefore
    costs a `prompts/clarify-query.v2.md` wrapping the answer —
    `{ "queries": [...] }` — because a prompt that contradicts the tool schema
    it is sent with will be disobeyed in one direction or the other. Found
    while building TICKET-0018 and handed to 0011's re-open rather than fixed
    speculatively; the same re-open still waits on the rubric for `{{thesis}}`.

53. **`.cache/llm/` is committed by policy and empty in fact.** `.gitignore`
    excludes `.cache/http/` and deliberately keeps the LLM cache, which is what
    makes ARCHITECTURE §4's replay claim true — but no entry exists, because no
    call has been made. The replay behaviour is tested against temp
    directories. A reviewer cannot yet open a cached response and read it. It
    fills at the first real call (0011's clarifier or 0020's extraction) and is
    committed for real at TICKET-0028.

54. **Cost is recorded as unknown.** `PRICES` in `src/llm/provider.ts` ships
    empty, so every `cost_usd` is `null` while token counts are real. SPEC and
    ARCHITECTURE both mention cost in the manifest; what they will get is a
    token count and a null. The fix is one dated table entry per model and a
    line saying where the numbers came from — deliberately not guessed, because
    a committed manifest is a number a reader will believe.

---

## Next session — start here

The work is broken down in **[docs/tickets/](./tickets/)** — 30 tickets derived
from the documents in this directory, in dependency order, each one leaving the
repo runnable. **0001–0013 and 0018 are Done.** The gate has reported, so stage
2 is released — the two tickets that reopened on the way out of it are closed
again, and the provider seam behind stage 2 is in.

**All five gate fixes have landed** — worklogs
[0023](./worklog/0023-gate-fixes-canonicalisation.md) and
[0024](./worklog/0024-gate-fixes-classifier-and-naming.md). **Junk over the
gate's own 48 candidates is 5 → 1**, measured by re-running the four topics
rather than estimated. The survivor is `demo.coroot.com`, a demo instance of a
company already in the same list, and it needs TICKET-0015's `homepage` field.

Three things a new session should carry out of that, because they are the parts
that did not go as written:

1. **Two of the gate's three predictions were wrong.** Fallback names were
   predicted 13 → 6 and measured **13 → 13** — F1 changes a fallback name's
   shape, never turns it into a lifted one, and the count was the wrong measure.
   F1's reach was predicted at 7 of 48 and measured at 3.
2. **Two fixes were narrowed while being implemented**, both towards accepting
   more: F4 shipped without its `/p/<slug>` half, and F1 keeps a distinctive
   repo slug. Both are pinned by tests that say the omission is a decision.
3. **Three fixes landed in a different file than the gate scoped them to.** F1
   is naming, so it is in `candidate.ts`; F4 is classification, so it is in
   `hn.ts`. Scoping a fix before opening the file was still cheap and still
   worth doing — but the fix list was written faster than it was checked.

**TICKET-0018 is Done** ([worklog
0025](./worklog/0025-llm-provider-and-cache.md)) — the provider seam and the
committed response cache, 25 offline tests, never run against a live provider.
It did **not** answer the gate's open question, and the reason is worth carrying
forward: wiring the clarifier needs a prompt v2 (structured output cannot
express v1's bare JSON array — inconsistency 52) *and* the rubric behind
`{{thesis}}`, which is TICKET-0021. So the 0011 re-open moved behind stage 2
rather than in front of it.

**Nothing is blocking. One Ready ticket:**

- [TICKET-0014](./tickets/0014-ticket-fixture-capture-script.md) — **Ready.**
  `pnpm capture-fixtures`. Capture `eBPF observability` alongside a rich topic:
  it is the thin, awkward result set the suite has never had — 3 usable of 6, a
  fallback that fires and a triple-counted company all in one payload — and it
  is now an **11-candidate** run against `--limit 12` (inconsistency 51). The
  fixes are all in, so a capture taken now records post-fix behaviour. Its scope
  also names the deliberately malformed **model** outputs that TICKET-0020's
  failure path needs — those are cheap to write now that the shape a call
  returns is fixed.
- [TICKET-0011](./tickets/0011-ticket-query-planning.md) — **reopened, not
  Ready.** The clarifier call: `callModel` exists, `prompts/clarify-query.v2.md`
  does not, and `{{thesis}}` waits on 0021.

Then stage 2 proper: 0015 and 0016 (adapters), 0017 (evidence gather), 0019/0020
(extraction), 0021 (the rubric), 0022 (wiring). Two things the gate hands
forward into them:

1. **`GET /users/<owner>` → `type: User | Organization`** separated all ten
   hobby projects from every real company in the gate's 48 (inconsistency 22).
   It is a **fact for the rubric**, extracted in TICKET-0015 and scored in
   TICKET-0021 — never a filter in stage 1.
2. **The repo ↔ company-site join** (inconsistency 45) is TICKET-0015's
   `homepage` field, and it is the one gate defect stage 1 structurally cannot
   fix.

The shape of the whole thing, unchanged:

1. **Scaffold** — tickets 0001–0004. **Done.** Resolved D-1 and D-3.
2. **Zod contracts** — ticket 0005. **Done.** Two places where it is
   deliberately incomplete are inconsistencies 8 and 9 above.
3. **Stage 1 against live HN** — tickets 0006–0012. **Done**, with 0009 and
   0010 reopened and closed again by the gate's five fixes.
4. **Hand-check the candidate list before writing a line of stage 2** —
   [TICKET-0013](./tickets/0013-ticket-gate-hand-check-candidates.md). **Done**
   — 10% junk, D-6 kept, D-5 taken, five fixes scoped back. Read
   [worklog 0022](./worklog/0022-gate-hand-check.md) before touching stage 2;
   it is the only place the input's real quality is written down.
5. Capture fixtures from those runs — ticket 0014 — so the suite stays offline.
6. **The provider seam and the committed response cache** — ticket 0018.
   **Done**, and outside the gate throughout: it encodes no thesis, no score
   and no prompt.
7. Stage 2, then stage 3, then the sample run on `AI agent infrastructure`.

## Invariants a new session must not break

Full list in [CLAUDE.md](../CLAUDE.md); these are the three that are expensive to
recover from.

1. **Widening yes, narrowing no.** The LLM may decide what to look at (query
   planning). It may never decide what to conclude. Scores, calls, and memo prose
   are never model output. (ADR-0002, ADR-0008)
2. **Every fact carries `evidence_ids`.** Facts without them are dropped at parse
   time, and the memo validator hard-fails on an unresolvable id. (ADR-0003)
3. **Missing data lowers coverage.** It never becomes a zero, a guess, or smooth
   prose. "Unknown" is written as unknown. (SPEC §3)

---

## Submission checklist

The brief asks for a repo plus a ~5 minute walkthrough showing one startup
end-to-end.

- [ ] One command produces memos from a topic
- [ ] Sample run committed — outputs readable without running anything
- [ ] Any memo's call is clear in 60 seconds
- [ ] Any claim traceable to a URL and a retrieval timestamp
- [ ] `pnpm test` passes on a fresh clone with no API key
- [ ] Worklog reflections written by the author (D-4)
- [ ] ~5 min walkthrough video, one startup end-to-end
