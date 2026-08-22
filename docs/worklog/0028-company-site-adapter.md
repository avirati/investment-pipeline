# Session 0028 — 2026-08-22 — The company-site adapter

[TICKET-0016](../tickets/0016-ticket-company-site-adapter.md), in five commits.
`src/evidence/site.ts` reads a company's own pages: the home page, then up to
three of the pages it links to that the rubric has a use for. It answers two
questions nothing else in the pipeline can — **who is named on the team page**
(SPEC D1) and **whether a developer can adopt this without a contract** (the
D-4 disqualifier) — and it is the first customer of the `homepage` join
[TICKET-0015](../tickets/0015-ticket-github-adapter.md) closed.

## What I asked for

Continue implementation, stop for review, small commits on a feature branch,
keep the worklogs going with reflection hints, update ticket statuses.

## What landed

| Commit    | Contents                                                               | Tests |
| --------- | ---------------------------------------------------------------------- | ----- |
| `e8a8f17` | Link discovery and roles, page budget, empty-shell and language checks | 39    |
| `2c389b1` | `extractPeople` — named people with a corroborating role               | 17    |
| `f588fbd` | `Signal` moved to `src/evidence/signal.ts`, shared by both adapters    | —     |
| `1f6bd94` | `gatherSite` — evidence, signals, failures as data                     | 16    |
| `d08783b` | Two defects the first live run found                                   | +3    |

**670 tests** (595 before this ticket: +75), typecheck and lint clean, offline
and with no `.env`.

## The shape

Four rules, three of them inherited from the GitHub adapter so stage 2's two
modules fail the same way. The fourth is this module's own.

**1 — A wrong founder is worse than a missing one** ([SCOPE](../SCOPE.md) cut
corner 1). This is the rule the people extraction is built around, and it is
structural rather than remembered: **no name is emitted without a corroborating
role beside it**. A page of testimonials, a list of investors and a blog byline
all look exactly like a founder list to a name-shaped regex, and the failure is
asymmetric — under-extracting costs coverage, which the memo is required to
state; over-extracting puts a stranger's name in an investment memo. Names seen
and dropped come back in `rejected[]` with a reason, so a thin run can say what
it threw away rather than looking like a site with no team page.

Two patterns produce a person and both need the role: an adjacent role element
(`<h3>Nikolay Sivko</h3><p>Co-founder, CEO</p>`, what a team-card component
compiles to) and a name-dash-role line (`Priya Raghavan — previously staff SRE
at Fathom Logistics`, what a hand-written list looks like).

**2 — The module concludes nothing.** It records that a `/pricing` link exists,
not that the company is self-serve. `site.pricing_url`, `site.docs_url`,
`site.signup_url`, `site.repo_url` and `site.contact_url` are five facts about
links; D-4 is decided in `src/analyse/score.ts` and nowhere else (CLAUDE.md
invariant 7). Coroot's marketing manager is emitted next to its two co-founders
with the page's own words for each — deciding who is a _founder_ is SPEC D1's
job, and a test pins that.

**3 — Failure is data.** [TESTING §6](../TESTING.md)'s three failure shapes are
three recorded outcomes. A 404 and a timeout become `fetch_failed` records with
the reason as their text. An empty JS shell becomes a `company_site` record at
status 200 with `empty_shell: true`, and **its text is the reason** — a record
whose text is a cookie banner reads downstream as a company that says nothing
about itself, rather than as a page this pipeline cannot render.

**4 — English only, and say so** (SCOPE cut corner 4). Three tests read in order
of how hard they are to fool: a declared `lang`, a dominant non-Latin script
which overrules it, and a stopword ratio which only speaks when there is enough
text. `unknown` is a real verdict and is deliberately _not_ treated as "not
English": most company sites declare nothing, and refusing to read them would
cut coverage to nearly nothing for a hazard that hardly occurs on this source.
That is a stated assumption, not a measurement.

## Decisions taken in code

- **The page budget is three, and the module is not a crawler.** Home plus one
  page per fetched role — team, then pricing, then docs, in that order, so a run
  that runs out of budget runs out of it on `docs` and not on founders. A
  `--limit 20` run is 80 requests. A sign-up page is a form, a demo-request page
  is a form, and the repository is the GitHub adapter's job: all three are
  recorded as links and none is fetched.
- **`sameSite` is a suffix test, not `siteKey`.** `src/source/resolve.ts` does
  the same kind of work for stage 1, and CLAUDE.md invariant 5 keeps stages out
  of each other. The suffix test also needs no public suffix list to be right
  about the case it meets — a company and its own `docs.` subdomain. Where it is
  wrong is two accounts on one shared host, and it is wrong in the direction of
  rejecting the link, which costs a page rather than mixing two companies'
  evidence. Pinned by a test.
- **`httpGet` rather than `fetchEvidence`.** Links are read off the markup and
  not off the extracted prose, so this module needs the body. The choke point
  CLAUDE.md requires is `fetch.ts`, which `httpGet` is.
- **A home page is scanned for people only under a heading that says team.** The
  cheapest guard in the module, and what keeps a logo wall and a quote carousel
  out of the founder list. A team page fetched _because_ it is the team page is
  scanned whole.
- **`Signal` moved out of the GitHub adapter** into `src/evidence/signal.ts`,
  unchanged. Two copies of "a metric that cannot be dated is an unknown, never a
  zero" would be one too many: the rule is only structural while there is one
  function that can produce a signal. Its own commit, no behaviour change.

## The first live run against real sites

Seven of the [gate](0022-gate-hand-check.md)'s own candidates, read-only,
nothing committed: `coroot.com`, `zatanna.ai`, `hypercubic.ai`,
`pylonsync.com`, `crosscanon.com`, `syn-cause.com`, `splabs.io`.

Five ran clean end to end. What they measured:

| Site            | Result                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| `coroot.com`    | 4 pages, 4 requests, 1.2s. Three people with roles verbatim, all five D-4 links found |
| `hypercubic.ai` | Team page is at `/company`; two co-founders extracted, no pricing page                |
| `pylonsync.com` | Docs and repo found, no team page — `site.people_named` an unknown with a reason      |
| `splabs.io`     | Two sign-up paths found, one matched on link text (`/login` behind "Try it free")     |
| `syn-cause.com` | DNS failure, 4 attempts, status 0, one `fetch_failed` record. Correct                 |

**Two defects changed the code.**

_F1 — a one-page site recorded no contact link._ `zatanna.ai`'s whole navigation
is in-page fragments and its only call to action is "Book a 15-min demo"
pointing at `zatanna.cal.com`. The same-site filter dropped it, so the run
recorded a company offering **neither** self-serve nor sales — a state that does
not exist, and precisely the distinction D-4 turns on. The off-site exemption is
now a per-rule `offsite` flag rather than a hardcoded check for `repo`, and a
scheduling host carries it for the same reason a code host does.

_F2 — a client-rendered page was reported as merely thin._ `crosscanon.com`
returns 71 characters behind a Remix bundle with no named mount element, so the
mount test alone missed it — and "the company says little" versus "we cannot
render this page" are exactly the two readings the reason exists to separate. A
`<script type="module">` or a hashed bundle path is now the second tell.

Both are pinned by tests against the real markup shapes.

## Known gaps, recorded rather than fixed

- **An unquoted endorsement under a team heading is indistinguishable from a
  colleague.** A customer quote with a job title and no quotation marks around
  it passes every rule available here. Two things bound the damage: the role is
  carried verbatim, so "VP Engineering, Northwind Freight" names another
  company, and TICKET-0020's extractor reads the same page text with the context
  in front of it. Pinned by a test, the same treatment `classifyHit` gives its
  own blind spot.
- **A one-pager's in-page sections are invisible.** `#team` on a single-page
  site is dropped with every other fragment. It costs nothing today — the home
  page is scanned for people anyway — but `site.team_url` will say "the home
  page links to no team page" about a site that has a team section.
- **`extractHtml`'s known cost showed up live.** `4,829,385,502Modeled total
requests processed` on zatanna's page: block-level separation does not split
  two inline elements flush against each other. Recorded in the
  [ADR-0005 amendment](../adr/0005-typescript-stack.md) and unchanged here.

## What this ticket did not do

- **No headless browser.** SCOPE rules out agentic browsing, and the cost is
  dependency weight for a minority of sites. `detectEmptyShell` is that cut made
  visible instead of silent: the run says which pages it could not render.
- **No founder keyword list deciding who is a founder.** That is SPEC D1 and it
  lives in the rubric.
- **No people-data provider.** SCOPE closed this; none is free.
- **Nothing calls `gatherSite` yet.** Wiring it into a candidate loop next to
  `gatherGithub` is TICKET-0017, which also owns the run-level request budget —
  `SITE_PAGE_BUDGET` answers it per candidate, not per run.

## Attribution

`src/evidence/site.ts`, `src/evidence/signal.ts`, all 75 tests and this
worklog's factual sections are AI-written end to end. The seven live subjects
were taken from the gate's own 48 rather than invented. Both live-run fixes were
the AI's, taken after reading the pages the defects were found on.

## Reflection

site.ts is quite bulky. Will do a separate pass on bulky files to split them up. For now, proceeding as usual.

## Next

**TICKET-0016 is Done.** [TICKET-0017](../tickets/0017-ticket-evidence-gather.md)
— evidence gathering per candidate — is now unblocked and is the next thing to
pick up: both adapters exist, both return the same `Signal` shape, and the
`homepage` field joins one to the other.

The open question it inherits is the run-level request budget. `defaultCalls`
answers it per candidate for GitHub and `SITE_PAGE_BUDGET` answers it per
candidate for sites; nothing yet decides what a whole run may spend, and the
live runs above suggest a company costs about 6 requests and 3 seconds.
