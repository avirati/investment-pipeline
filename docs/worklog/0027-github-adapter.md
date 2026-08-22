# Session 0027 — 2026-08-22 — The GitHub adapter

[TICKET-0015](../tickets/0015-ticket-github-adapter.md), in three commits.
`src/evidence/github.ts` turns a candidate url into an account, reads up to five
endpoints, and returns evidence records plus dated signals — including the two
fields the [gate](0022-gate-hand-check.md) handed forward: `owner.type`, which
separated all ten hobby projects from every real company in its 48
(inconsistency 22), and `repo.homepage`, the repo ↔ company-site join stage 1
structurally cannot make (inconsistency 45).

## What I asked for

Continue implementation, stop for review, small commits on a feature branch,
keep the worklogs going, update ticket statuses.

## What landed

| Commit    | Contents                                                                | Tests |
| --------- | ----------------------------------------------------------------------- | ----- |
| `884ac3e` | Three more GitHub fixtures: `readme`, `contributors`, `commit_activity` | —     |
| `f4281ac` | Ref parsing, response schemas, evidence projections                     | 68    |
| `8354717` | `gatherGithub` — the five calls, degraded mode, failures as data        | 14    |

**595 tests** (513 before this ticket: +82), typecheck and lint clean, offline
and with no `.env`.

## Four rules the module is built around

1. **Everything the rubric reads carries a date.** SPEC D3 scores an undated
   claim at 0, so an undated metric is not merely useless — it looks like a
   signal and scores like a lie. `add` is the only way a metric leaves this
   module, and a value that is null, blank or not finite becomes an `unknown`
   with a reason instead of a number.
2. **The evidence text is a projection, not the response.** `GET /repos/…` is
   7 KB of API urls and `…/contributors` is 36 KB of avatar links. Each payload
   renders to a compact `key: value` block whose missing fields are written
   `unknown`, and `meta.projection` names the renderer. Same departure
   `extractHtml` already makes for a web page (inconsistency 18).
3. **Failure is not an error.** 404, 202, 204 and a 200 of the wrong shape are
   four recorded outcomes.
4. **This module concludes nothing.** No keyword list, no threshold, no opinion
   about what a good repo looks like. The thesis lives in one place and it is
   not here (CLAUDE.md invariant 7).

## Signals are not facts, and that is the decision worth reviewing

A `Fact` is the model's output surface: it carries a `statement` a partner reads
and a `confidence` (`src/contracts/fact.ts`). What this adapter produces is
underneath that — a star count read off a payload, or an age computed from two
dates by subtraction. There is no model involved and nothing to be confident
about, so it is a separate shape:

```ts
interface Signal {
  key;
  value;
  as_of;
  evidence_id;
  derived_from?;
}
```

Every signal carries the moment it was observed and the id of the record it came
from, so it resolves to a citation the same way a fact does. `as_of` is the
retrieval timestamp rather than the clock, which is what makes a re-run over a
warm HTTP cache reproduce the same numbers rather than drifting by a day.

The open question this leaves is where signals meet facts: TICKET-0020 extracts
facts from an evidence bundle with a model, and these are already facts without
one. Named in STATE as inconsistency 58 rather than answered here — the answer
belongs to 0020/0021, and guessing it now would put a fact vocabulary in an
adapter.

## Degraded mode is a request budget, not a footnote

Unauthenticated GitHub is 60 requests an hour. Five calls a candidate against
`--limit 12` is **exactly 60**: the last candidate in a run would be
rate-limited by the run's own first candidate, and the retry budget would be
spent discovering it.

So `defaultCalls(mode)` reads two endpoints without a token — `repo` and
`owner`, the two carrying the fields the gate asked for — and five with one.
Every call not made is an `unknown` naming `GITHUB_TOKEN`. The alternative,
always making five and letting the fourth candidate start failing, gives a run
whose coverage depends on where in the list a company happened to sit; a
uniformly thinner run that says why is easier to read and easier to fix.

## The first live run changed the code

Three candidates from the gate's own list, unauthenticated, ~1s a call.

- **`coroot/coroot`** — 2 requests, 24 signals, `homepage`
  `https://coroot.com/`. That is inconsistency 45 closed at the point where it
  can be closed: the join the gate lost 25% of one run to.
- **`nullswan/bpfsnitch`** with all five calls — the **202 path fired live**.
  `stats/commit_activity` is computed on demand and answers 202 with `{}` while
  GitHub works; it did the same twice while its fixture was being captured. It
  is now a recorded not-yet with the other four calls unaffected, and it is the
  one shape that cannot be a fixture, so a stub tests it.
- **`anilatambharii/argus-ai`** — the gate's 404 candidate (inconsistency 39).
  The repo 404s, the account exists, and **its `blog` field is a LinkedIn
  profile**.

That last one changed the code. The account's `blog` had been a fallback for
`homepage`, which would have sent TICKET-0016 to extract founders from a
personal profile page — a social host stage 1's own classifier rejects, and the
wrong-founder failure SCOPE calls worse than a missing one. Only `repo.homepage`
now makes the join. The field survives as a signal (`github.owner_site`) because
it is a true, dated fact about the account; it is just not a company site.

## Two measurements to carry forward

- **`bpfsnitch`'s README is 9,649 characters and was truncated to 8,000.** The
  first real number bearing on `EVIDENCE_TEXT_LIMIT` (inconsistency 14), which
  has been labelled a guess since TICKET-0007. One README over the limit is not
  an argument for raising it — a README's first 8,000 characters are its pitch
  and its install instructions — but it is the first evidence that the limit
  binds at all.
- **A real contributor list has a bot in it.** `dependabot[bot]` is 1 of
  Coroot's 33, so `github.contributors` and `github.human_contributors` are
  separate numbers. A "33 contributors" claim that counts it is partly a claim
  about a robot.

## Three decisions taken in the code

1. **`parseGithubRef` duplicates a little of `src/source/resolve.ts`.** Both
   pull an owner and repo out of a url. Importing stage 1's version would be
   stage 2 reaching into stage 1's internals (CLAUDE.md invariant 5), and the
   cost of the duplication is one small path parser against the benefit that
   stage 2 keeps working if canonicalisation changes under it. It ignores
   everything past `owner/repo` rather than rejecting it, so it does not
   _depend_ on stage 1's fix F3 having run.
2. **`RESERVED_OWNERS` is the ninth hand-written list in this codebase.**
   `github.com/topics/ebpf` would otherwise resolve to an account called
   "topics". It fails safe in the cheap direction: an unlisted reserved word
   costs one request that 404s, which is what a candidate with no GitHub
   presence already costs.
3. **`stars_per_day_lifetime`, not `star velocity`.** The ticket asks for
   velocity. Real velocity needs two observations and GitHub charges for the
   second — the stargazer-timestamps endpoint is paginated one page per hundred
   stars. Stars ÷ age is a lifetime average and is named as one, because a
   number called velocity that is not one would be scored as though it were.

## What this ticket did not do

- **No third-party integration keyword list.** The ticket names "third-party
  integration signals". Reading a README for `kubernetes`, `datadog`, `slack`
  would be a rubric hiding in an adapter, and CLAUDE.md invariant 7 puts the
  thesis in exactly one place. The README text and the repo topics are in the
  bundle; TICKET-0020 extracts from them and TICKET-0021 scores them.
- **No per-contributor profile fetch.** The ticket allows contributor profiles
  "within what the API gives free", and the contributor list gives logins and
  commit counts in one request. A profile each is N more requests against a
  60/hour budget, for a founder signal the company's own team page carries
  better (TICKET-0016).
- **Nothing calls `gatherGithub` yet.** Wiring it into a candidate loop is
  TICKET-0017, which is also where the run-level request budget belongs.

## Attribution

`src/evidence/github.ts`, all 82 tests, the three fixture specs and this
worklog's factual sections are AI-written end to end. The three live subjects
were taken from the gate's own 48 rather than invented. The decision to drop the
`blog` fallback was the AI's, taken after the live run produced the LinkedIn url.

## Reflection

GH adapter is built, returns a structured data against a repo. Tests have grown quite a lot, build time checks are taking a while to complete.

## Next

**TICKET-0015 is Done.** [TICKET-0016](../tickets/0016-ticket-company-site-adapter.md)
— the company site adapter — is Ready and unchanged, and it now has a first
customer: `gatherGithub` returns the homepage it should fetch.

Then TICKET-0017 gathers both into one bundle per candidate, and owns the
question this ticket left open: how many GitHub requests a run may spend, given
that `defaultCalls` answers it per candidate and not per run.
