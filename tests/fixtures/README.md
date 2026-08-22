# Fixtures

Real captured responses, committed. They are what makes `pnpm test` pass with
the network unplugged and no `.env` (CLAUDE.md, [TESTING](../../docs/TESTING.md)),
and they double as a record of what the external APIs actually returned on the
day the code was written.

Everything here is produced by **`pnpm capture-fixtures`** (TICKET-0014) except
`company-site.html`, which says so in its own first lines. Nothing here is
hand-edited: `capture.json` records the url, status, date, size and sha256 of
every file, and `tests/capture-fixtures.test.ts` fails if a file and its record
disagree. Each record says how the bytes came to exist:

| `captured_by` | Meaning |
|---|---|
| `script` | Fetched by this script on the date in the record |
| `hand` | The four HN fixtures TICKET-0009 captured by `curl` before the script existed. A bare run **adopts** them — records the digest of the committed bytes without fetching — rather than replacing them. Their `url` is a transcription of the command that produced them |
| `derived` | Built from another fixture, not from a response. Only `hn/search-malformed.json` |
| `authored` | Written from a table in `scripts/fixtures.ts`. Model output cannot be captured on demand — the interesting shapes are the ones a model produces on a bad day — so `model/` is authored, with the defect each file demonstrates written next to it |

```bash
pnpm capture-fixtures                 # write what is missing; skip what exists
pnpm capture-fixtures --only github   # one group
pnpm capture-fixtures --refresh       # re-capture what exists — see below
pnpm capture-fixtures --dry-run       # print the plan, make no requests
```

**A bare run never overwrites an existing fixture.** HN Algolia is
relevance-ranked, so the same query returns different hits from one month to the
next, and the suite asserts on these files. Refreshing is `--refresh` and is a
deliberate act with a diff to read afterwards — the first time the four
hand-captured pages were refreshed it broke five assertions in `tests/hn.test.ts`
on the same day they were taken, which is that rule earning its keep.

## Groups

| File | What it is |
|---|---|
| `hn/search-page-0.json`, `hn/search-page-1.json` | Two pages of one query (`llm observability`, `hitsPerPage=5`). Pagination needs two real pages |
| `hn/search-empty.json` | A seed nobody has posted about: zero hits, still a 200 |
| `hn/search-ask-hn.json` | Text posts — every hit has a null url, which the classifier must reject |
| `hn/search-thin.json` | The gate's thin topic (`eBPF observability`), probe-shaped: 6 hits, 3 usable. The run that fell under `--min-hits 8` and produced four of the gate's five junk candidates ([worklog 0022](../../docs/worklog/0022-gate-hand-check.md)). It carries a deep link into a repo, a `medium.com` post and an `infoq.com` article, so canonicalisation and the classifier meet the payload that beat them |
| `hn/search-malformed.json` | **Derived**, not fetched — see below |
| `github/user-organization.json`, `github/user-person.json` | `GET /users/<owner>` for `coroot` and `nullswan`: `type: "Organization"` against `type: "User"`. That one field separated all ten open-source projects from every real company in the gate's 48 (inconsistency 22). It is a **fact for the rubric**, never a filter in stage 1 |
| `github/user-foundation.json` | `ccfos` — an organisation that is a foundation, not a company. The exception that keeps `type` a signal rather than a rule |
| `github/repo-with-homepage.json` | `coroot/coroot`, whose `homepage` is `https://coroot.com`: the repo ↔ company-site join stage 1 structurally cannot make (inconsistency 45) |
| `github/repo-hobby.json` | `nullswan/bpfsnitch`, a personal-account repo from the gate's list. Its `homepage` is `""` — **an empty string, not null**, which is the missing-data path for the join and the kind of thing only a real payload tells you |
| `github/readme-coroot.json` | `GET /repos/<owner>/<repo>/readme`. The README arrives base64-encoded inside a JSON envelope, so the adapter decodes it — the evidence record holds 5.2k characters of markdown, not the envelope |
| `github/contributors-coroot.json` | One page of contributors (`per_page=100`), 33 of them. Two things a real payload teaches: the list is ranked by contributions, and `dependabot[bot]` is in it with `type: "Bot"` |
| `github/commit-activity-coroot.json` | `GET /repos/<owner>/<repo>/stats/commit_activity` — 52 weeks, each with its own week boundary and a daily breakdown. The only dated cadence signal the API gives for free. **It answered `202` with an empty body the first two times it was asked**, while GitHub computed it; that path is tested with a stub, because a 202 cannot be captured on demand |
| `sites/coroot-home.html` | A real company landing page: nav, footer, cookie banner, testimonials, and 5.9k characters of extractable text |
| `sites/coroot-about.html` | The team page behind it — three named people with roles and one prior exit in prose. This is the surface founder facts are extracted from |
| `model/facts-valid.json` | The extraction output a good day produces: five facts about Coroot, every evidence id resolving to a fixture in this directory |
| `model/facts-malformed.json` | Eight items, one deliberate defect each — see below |
| `model/facts-unknown.json` | [TESTING §6](../../docs/TESTING.md)'s missing-data case: valid JSON where the model found nothing. Every value null, every fact still cited |
| `model/not-json.txt` | The model that answered the question instead of filling in the schema |
| `company-site.html` | **Hand-written, not captured.** TICKET-0008's extraction fixture: every hazard on purpose, and no licence question. It says so in a comment at the top |

`capture.json` carries a one-line note per file saying why it exists, plus
`text_chars` for the HTML ones — what `extractHtml` actually gets out of the
page, which is the number that says whether a capture is worth keeping.

## `hn/search-malformed.json` is derived, and says so here

The API does not serve broken records on demand, so this file is
`search-page-0.json` with five deliberate defects — one per hit, in order. The
edits were made by hand for TICKET-0009 and are now a table in
[`scripts/fixtures.ts`](../../scripts/fixtures.ts), so the file regenerates byte
for byte and a test asserts it.

| Hit | Defect | Expected behaviour |
|---|---|---|
| 0 | `created_at` is prose, `created_at_i` intact | dated from the unix field |
| 1 | `created_at` null, `created_at_i` absent | `created_at: null`, hit kept |
| 2 | `created_at_i` is a string, `created_at` intact | dated from the ISO field |
| 3 | `points` absent, `num_comments` null | both `null` — never `0` |
| 4 | `objectID` absent | dropped, with a reason |

The mix is the point: four of the five are *survivable*, and a parser that treats
malformed as fatal throws away four usable posts to reject one.

## `model/facts-malformed.json`, item by item

The table lives in [`scripts/fixtures.ts`](../../scripts/fixtures.ts) and
`tests/model-fixtures.test.ts` asserts each row against the real `Fact` contract,
so a defect the parser quietly tolerates fails the suite rather than becoming a
fixture TICKET-0020 writes a passing test against.

| Item | Defect | Parse |
|---|---|---|
| 0 | `evidence_ids` absent | dropped — the citation guarantee *is* this drop (ADR-0003) |
| 1 | `evidence_ids` present but empty | dropped — an empty array is not a weaker citation, it is none |
| 2 | an `evidence_ids` entry that resolves to nothing | **kept** — well-formed and still wrong |
| 3 | `value` is an object | dropped — facts are atoms |
| 4 | `confidence` outside the enum | dropped — a model asked for three levels invents a fourth |
| 5 | `schema_version` from a future contract | dropped — a version bump must fail loudly |
| 6 | `statement` is empty | dropped — a citation attached to nothing |
| 7 | `key` absent | dropped — the rubric switches on `key` |

Item 2 is the one that matters. Nothing at parse time can tell a well-formed id
from a resolvable one, so it is the memo validator that must (TICKET-0025), and
this item is the fixture that proves the gap is real rather than theoretical.

## Credentials

No token, cookie or key appears anywhere under `tests/fixtures/`, and that is
enforced twice rather than promised:

- `captureOne` scans every body **before** it becomes a file. A hit fails that
  fixture, writes nothing, names the rule that fired — never the match — and the
  run exits non-zero.
- `tests/capture-fixtures.test.ts` re-scans every committed file on every
  `pnpm test`.

Only three response headers are recorded (`content-type`, `etag`,
`last-modified`); request headers are never written, so the `GITHUB_TOKEN` a
capture may have used cannot reach this directory.

## Two things these fixtures do not have

- **An empty-shell page.** [TESTING §6](../../docs/TESTING.md) wants a company
  site that serves a JavaScript stub and no text. Both captured pages render
  server-side; a real one has to be found rather than written, and TICKET-0023
  owns that path.
- **A 404 body.** `httpGet` turns a non-2xx into a `fetch_failed` record and
  drops the body (`src/evidence/fetch.ts` rule 1), so there is nothing for a
  fixture to hold. That path is tested with a stub transport instead.

## Third-party content

`sites/` and `github/` hold other people's pages and payloads, captured verbatim
for offline testing and unmodified. `capture.json` records the url and the date
for each. They are test inputs, not content this project publishes.
