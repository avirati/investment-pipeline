# Project State

Last updated: 2026-08-22 · at commit `c4dfbe1` · **Phase: stage 1 — every piece the `source` command composes now exists, including run identity and candidate derivation; the command itself is unwritten and nothing has yet touched the live API**

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

TICKET-0012 has started, from the inside out. Three pieces the wiring composes
now exist. `Candidate.provenance` is a **non-empty list, primary first**
(`schema_version` 2) — the fix for inconsistency 25, expressed as a tuple with a
rest element so `provenance[0]` needs no undefined check — and it gained three
fields the wiring found it needed: `title` (the post title the name was derived
from), `posted_url` (the link as submitted, so a redirect is visible in one
JSONL line) and `posted_at`, which is null when the hit carried no date while
`at` stays the run clock. `src/run.ts` owns run identity for all three stages:
`deriveRunId` is `<utc-day>-<seed-slug>` derived from the seed *as typed*
(the id has to exist before the plan is written into the directory it names),
`validateRunId` rejects an operator's `--run` rather than sanitising it,
`runPaths` is the single definition of ARCHITECTURE §4's layout, and
`createRunDir` is a bare `mkdir` — ADR-0001's concurrency guard without the race
an `existsSync` check would leave — which only `--replay` may reuse.
`src/source/candidate.ts` is the last pure step: a name is **lifted verbatim
from the post title or it is the company's own address**, never composed, and a
title is read as a name only when a separator splits a short head from a tail.
Slugs are derived once, deduplicated within the run, and reserved only after the
candidate parses. **TICKET-0012 is In progress**; `./pipeline source` still
exits 70 and the manifest does not exist.

**The first live run happened** — not through `./pipeline source`, which still
exits 70, but by driving the modules in the order the command will call them
against live HN Algolia (`"LLM observability"`, `--limit 10 --since 180`, 15
requests, 13.5s, scratch directory, nothing committed). It is not the sample run
(D-5) and it is not the gate (TICKET-0013). What it measured is recorded in
inconsistencies 36–40 below, and one number belongs here: **the probe returned
50 hits, 35 of them usable**, against a `--min-hits` default of 8. On a query at
the centre of the thesis the threshold is nowhere near binding.

`prompts/clarify-query.v1.md` and `prompts/CHANGELOG.md` exist and nothing reads
them: the prompt waits on 0018 for a provider and on 0020/0021 for the rubric
that fills its `{{thesis}}` placeholder.

**Nothing in `src/source/` has touched the live API yet** — every test drives a
stub transport over one topic's committed fixtures. TICKET-0012 is the wiring,
and it is the last ticket before the gate.

| Area | State |
|---|---|
| Thesis and rubric | Written, **unvalidated against any real company** |
| Architecture and stage contracts | Written; contracts implemented in `src/contracts/` (0005) |
| ADRs 0001–0008 | Written |
| Test strategy | Written; 320 tests — 17 CLI (0003), 35 contracts (0005, 0011, 0012), 14 config (0006), 19 evidence store (0007), 45 fetch and extraction (0008), 40 HN parse, classifier and search (0009), 58 canonicalisation, dedup and redirect resolution (0010), 34 probe and query planning (0011), 24 run identity and 34 candidate derivation (0012). Offline, no key |
| Worklogs 0001–0020 | Factual sections written; reflections pending (see D-4) |
| Ticket backlog | [docs/tickets/](./tickets/) — 30 tickets: 11 Done, 1 In progress (0012), 1 Ready (0018), 17 Blocked. Status is in each ticket header |
| Toolchain | `pnpm install/test/typecheck/lint` all pass, offline, no key (0001) |
| CLI surface | `src/cli.ts` — four commands, flags and `--help` pinned and tested (0003) |
| Exit codes | `src/exit-codes.ts` — 0/1/2/3, plus a temporary 70 for unimplemented stages (0003) |
| Stage contracts (code) | `src/contracts/` — six schemas, versioned, plus `parseOrDrop` (0005). `QueryPlan` is at `schema_version` 2 — `probe` is nullable (0011). `Candidate` is at `schema_version` 2 — `provenance` is a non-empty list, primary first, carrying `title`, `posted_url` and `posted_at` (0012) |
| Config and model routing | `src/config.ts` — role-scoped LLM config, GitHub degraded mode, `.env` loading (0006) |
| Evidence store | `src/evidence/store.ts` — content-addressed ids, truncation, typed misses (0007) |
| Fetch layer | `src/evidence/fetch.ts` — cache, bounded retries, `fetch_failed` records, `cheerio` HTML→text, `fetchEvidence(url, type)` (0008, Done) |
| HN adapter | `src/source/hn.ts` — url building, four expansion arms, tolerant hit parsing, usable-vs-unusable classifier, paginated `searchHn` with failures as data (0009, Done) |
| URL resolution and dedup | `src/source/resolve.ts` — canonicalisation, site keys, `dedupeHits`, redirect-following `resolveSites` (0010, Done) |
| Query planning | `src/source/plan.ts` — `probeSeed`, `planQuery`, the `query_plan.json` artifact, the clarifier seam and the model-output sanitiser (0011, Done) |
| Run identity | `src/run.ts` — `deriveRunId`/`validateRunId`, `runPaths` (ARCHITECTURE §4 in one place), `createRunDir` and ADR-0001's overwrite guard (0012, In progress) |
| Candidate derivation | `src/source/candidate.ts` — `deriveName` (lift or fall back to the domain; never compose), `slugFor`, `toCandidates` with drops as data (0012, In progress) |
| Prompts | `prompts/clarify-query.v1.md` and `prompts/CHANGELOG.md` — written, versioned, **not wired** (0011) |
| `setup.sh`, `./pipeline` | Steps 1–5 done (0004). Step 6, the offline self-verification, waits on 0026 and 0028 |
| Stages 1–3 | Not wired — every command still exits 70. Every module stage 1 needs now exists (0009–0012); what is missing is the command that calls them in order, the manifest, and the run-level failure decision |
| Sample run, walkthrough video | Not started |

---

## Open decisions

`Default if unanswered` exists so a new session is never blocked. Take the
default, state that you took it, and record it in that session's worklog.

| # | Decision | Blocked on | Default if unanswered |
|---|---|---|---|
| **D-2** | Memo rendering: `eta` templates vs typed TS render functions | Author preference | `eta` — a partner can edit a memo template without reading TypeScript |
| **D-4** | Reflection sections in worklogs 0001 and 0002 | Author. Must not be AI-written — see CLAUDE.md | Leave as `TODO(author)`. Do not fill in |
| **D-5** | Which topic becomes the committed sample run | First real stage-1 output | Pick whichever topic yields the cleanest 10–15 candidates and say why in the worklog |
| **D-6** | Probe threshold `--min-hits` default of 8 | First real stage-1 run | Keep 8 until data contradicts it. It is a guess and is labelled as one. Now *measured*: `probeSeed` computes `probe.usable` and `planQuery` compares it, so every run writes the number into `query_plan.json`. Both halves of the comparison lean generous — the classifier errs towards accepting (inconsistency 21) — so a thin probe is thinner than it looks. **First live measurement (2026-08-22, `"LLM observability"`): 35 usable of 50 hits.** Four times the threshold on a centre-of-thesis query, which says nothing yet about an awkward one |
| **D-7** | Whether ADR-0005 and ADR-0006 clear the "someone would disagree" bar | Author review | Keep both. Revisit only if a reviewer calls the ADR set padded |

### Recently closed

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
   `README.md`, `ARCHITECTURE.md`, and `SCOPE.md`. Replace all three once D-5 is
   settled.
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
    Whether stage 2's scoring actually separates them is an open question the
    gate at 0013 should answer, not an assumption to carry quietly.

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

36. **Package-registry hosts collapse every package into one candidate.**
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

38. **On one topic the three expansion arms contributed nothing.** `show_hn`
    returned 42 hits and 0 new, `launch` 4 and 0, `funding` 0 and 0 — the `raw`
    arm's two pages already contained all 70 posts. Three of five pages bought
    nothing on this query. One topic is not a measurement, and the arms exist
    for the topics where the raw seed is thin, which is exactly not this one.
    Recorded because it is the first evidence bearing on inconsistencies 23
    (`HN_MAX_PAGES_PER_ARM`) and 31 (`--no-expand`), and because the fixture
    capture at TICKET-0014 should include a topic where the arms do earn their
    requests — otherwise the suite only ever tests the case where they do not.

39. **A 404 stays a candidate.** `github.com/anilatambharii/argus-ai` returned
    404 during redirect resolution and became candidate 9 of 10. `resolveSites`
    keeps a site whose request failed on purpose (a company that 403s a bot is
    still a company), and ARCHITECTURE §5 says a candidate's unreachable site is
    a `fetch_failed` record and a coverage drop, not a rejection. The cost is
    real anyway: a deleted repo will spend a stage-2 analysis to produce a memo
    that says nothing. Whether a hard 404 on the *only* url a candidate has
    should drop it is a TICKET-0013 question with real numbers behind it.

40. **A generic repository name makes a poor candidate name.**
    `github.com/torrix-ai/install` is named `torrix-ai/install` while its own
    post title says "Torrix" — the title uses a comma where the naming rule
    wants a separator. `betterdb-inc/monitor` and `lunargate-ai/gateway` have
    the same shape. Two directions exist (accept `, ` as a separator when the
    head is short; or prefer the owner over a generic repo name) and both are
    guesses until the hand-check at TICKET-0013 says how often this happens.

---

## Next session — start here

The work is broken down in **[docs/tickets/](./tickets/)** — 30 tickets derived
from the documents in this directory, in dependency order, each one leaving the
repo runnable. **0001–0011 are Done**, 0012 is **In progress**, and
[TICKET-0018](./tickets/0018-ticket-llm-provider-and-cache.md) is the one Ready
ticket that is not it.

Every piece of stage 1 now exists as a module — including run identity and
candidate derivation, added this session. Nothing calls any of them:

- [TICKET-0012](./tickets/0012-ticket-stage-1-wiring.md) — **the next ticket**,
  and the last one before the gate. What remains is the command itself:
  `resolveRunId` → `createRunDir` → `planQuery` → `searchHn` → `dedupeHits` →
  `--limit` → `resolveSites` → `toCandidates` → `candidates.jsonl` +
  `manifest.json`, and it is the first thing in this repo to touch a live API.
  Of the four things it owed beyond the wiring, one is closed:
  1. the run-level failure decision `searchHn` deliberately does not make
     (inconsistency 24) — ARCHITECTURE §5 says something fails the run and
     nothing currently does. **Open**;
  2. ~~the `Candidate.provenance` plurality question (inconsistency 25)~~ —
     **closed**: a non-empty list, primary first, `schema_version` 2;
  3. the `dedupeHits` → `--limit` → `resolveSites` ordering, which is what keeps
     redirect resolution to one request per candidate rather than one per post.
     **Open**, and now a matter of writing the calls in that order;
  4. whether `--no-expand` also cuts the four search arms (inconsistency 31).
     **Open**.

  Two more the command still owes: the `urls` seed form (one url per line, the
  other survivor of TICKET-0002), and the documented fallback when candidate
  yield comes in under 10 — widened window and expansion, *recorded in the
  manifest* so a reviewer sees that it fired.

  The run-id sequencing note this section carried is now settled in code:
  `resolveRunId` derives the id from the seed as typed, before `planQuery` runs,
  so `runs/<run_id>/query_plan.json` has a directory to be written into. The
  "refuse to overwrite" guard (`createRunDir`) and `writeQueryPlan`'s `wx` are
  still two guards on the same thing, and they now nest rather than race —
  see inconsistency 35 for what `--replay` is allowed to reuse.
- [TICKET-0018](./tickets/0018-ticket-llm-provider-and-cache.md) — still Ready,
  still off the critical path to the gate. It is what turns the `Clarifier` seam
  in `plan.ts` into a real call, and what gives
  `prompts/clarify-query.v1.md` somewhere to run.

0015 and 0016 still wait on 0014, which waits on the gate.

The shape is unchanged from what this section said before the backlog existed:

1. **Scaffold** — tickets 0001–0004. **Done.** Resolved D-1 and D-3.
2. **Zod contracts** — ticket 0005. **Done.** The stage boundary is fixed; two
   places where it is deliberately incomplete are inconsistencies 8 and 9 above.
3. **Stage 1 against live HN** — tickets 0006–0012. **0006–0011 Done**, 0012
   In progress. 0012 is the wiring, and the first ticket that spends a real
   request.
   0018 is also Ready and sits outside the TICKET-0013 gate (inconsistency 13),
   but it is not on the critical path to the gate.
4. **Stop and hand-check the candidate list before writing a line of stage 2** —
   [TICKET-0013](./tickets/0013-ticket-gate-hand-check-candidates.md). This gate
   is deliberate. Stage 1 gates everything downstream, and the probe threshold
   (D-6) and the usable-vs-unusable classifier can only be validated against real
   output. Record what the junk rate actually was.
5. Capture fixtures from that run — ticket 0014 — so the suite is offline from
   the start.

Do not build stages 2 and 3 speculatively before step 4 reports back.

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
