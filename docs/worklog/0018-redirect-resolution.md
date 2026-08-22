# Session 0018 — 2026-08-22 — Redirect resolution, and TICKET-0010 closed

The second half of [TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md),
continuing directly from [worklog 0017](./0017-url-canonicalisation-and-dedup.md).
That session canonicalised and deduped urls without touching the network; this
one follows the redirect, which is the only way two vanity domains pointing at
one company can be seen to be one company.

## What I asked for

Same instruction as 0017, continued: keep the commits small, keep adding
worklogs, update the ticket status.

## What the AI produced

Appended to `src/source/resolve.ts` (~150 lines) and `tests/resolve.test.ts`
(+10 tests, 221 in the suite). One small refactor in `src/source/hn.ts`.

| Export                                   | What it is                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `resolveSites(sites, opts)`              | Follows each site's url through `httpGet`, re-keys, merges what now collides  |
| `SiteResolution`                         | `{ requested_url, resolved_url, status, redirected, rekeyed, reason }`        |
| `ResolvedSiteWithRedirect`               | A `ResolvedSite` that carries its resolution                                  |
| `classifyUrl(url)` _(moved, in `hn.ts`)_ | The body of `classifyHit`, split out so a landing url can be judged by it too |

`classifyHit(hit)` is now a one-liner over `classifyUrl(hit.url)`. Nothing about
its behaviour changed and its 11 tests were untouched.

## Three judgement calls

**1. It resolves sites, not hits.** One request per deduped company rather than
one per post, which is why `dedupeHits` is pure and cheap and runs first: a seed
returning 200 hits collapses to a few dozen sites, TICKET-0012 applies `--limit`
to those, and only what survives is fetched. The request is not spent twice
either — `httpGet` writes the body into the cache the evidence fetch will read,
so resolving a candidate and later fetching its page is one round trip.

**2. `redirected` and `rekeyed` are two different booleans**, and the first
version of this collapsed them into one called `moved`. The test caught it:
`launch.acme.dev/hn` → `acme.dev` is a redirect that changes nothing about
identity, because canonicalisation had already collapsed the subdomain onto its
apex. Only a redirect that lands on a _different dedup key_ can merge two
candidates, and that is the case worth a distinct name and distinct handling.

**3. A failed request keeps the site; an unusable landing rejects it.** A
company that 403s a bot user-agent is still a company, and ARCHITECTURE §5
already has a place for the failure — the evidence fetch records `fetch_failed`
with a citation, so coverage drops with something to cite. But a shortener that
resolves to `medium.com` is content, and it is rejected by exactly the rules
that would have rejected it had it been posted directly. Re-classification runs
**only** when the key moved: re-running the rules within one key would let a
company's own redirect to `/blog` reject the company.

## What the record should be honest about

**Rejection is at group granularity.** When a resolved site turns out to be
unusable, every post in the group is rejected with the same reason, including
posts whose own urls were fine before the merge. That is correct — they were
merged because they name the same surface — but it means one rejection line in
the audit trail can stand for several posts. There is a test that pins it.

**Requests are sequential.** One at a time is polite to a stranger's site and
the batch is a run's `--limit`, not a crawl. If `--limit` ever grows past a few
dozen this is the obvious place to add bounded concurrency, and the fetch layer
already has the retry policy it would need.

## Verification

- `pnpm test` — **221 passed** (211 before; +10 here: no-redirect, redirect
  within one key, redirect across keys, two sites merging onto one, a rejected
  landing from the url classifier, a rejected landing from this layer's own
  rules, a failed request keeping its site, group-granularity rejection,
  one-request-per-site, and empty-in-empty-out). Offline, no key, stub transport.
- `pnpm typecheck` and `pnpm lint` clean.
- Ticket acceptance, now fully covered: every canonicalisation case TESTING §3
  lists has a table row, and two fixture posts pointing at one company collapse
  to one site whose `posts[]` records both.

## What went wrong

The `moved` flag described above — one boolean doing two jobs, caught by the
test that expected a re-key on a subdomain that canonicalisation had already
handled. Split into `redirected` and `rekeyed`.

## Decisions taken

None. **TICKET-0010 is Done.** Inconsistency 25 (`Candidate.provenance` is
singular and dedup produces a group) is recorded in STATE and is TICKET-0012's
to resolve.

## Attribution

`resolveSites`, `SiteResolution`, the `classifyUrl` split and all 10 tests are
AI-written end-to-end. All three judgement calls above were made by the AI.

## Reflection

Redirect resolution, might be overkill for v1. But definitely a nice to have.

## Next

[TICKET-0011](../tickets/0011-ticket-query-planning.md) — the probe half of
query planning, and the last ticket before
[TICKET-0012](../tickets/0012-ticket-stage-1-wiring.md) can wire stage 1 and
answer the run-level failure question `searchHn` deliberately does not
(inconsistency 24). The gate at
[TICKET-0013](../tickets/0013-ticket-gate-hand-check-candidates.md) is then two
tickets away.
