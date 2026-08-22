# Session 0024 — 2026-08-22 — The gate's classifier and naming fixes

The other half of the [gate's](0022-gate-hand-check.md) five fixes: F2 and F4 in
`src/source/hn.ts`, F1 in `src/source/candidate.ts`. Junk over the gate's own
candidate lists is now **5 → 1**, measured on a re-run.

## What I asked for

Do the 0009 fixes next.

## What landed

|        | Fix                                    | Where         | Effect on the gate's 48         |
| ------ | -------------------------------------- | ------------- | ------------------------------- |
| **F2** | ACM's typesetting host is a paper host | `PAPER_HOSTS` | 1 junk candidate gone           |
| **F4** | A `blog.` subdomain is a blog          | `classifyUrl` | 1 junk candidate gone           |
| **F1** | A generic repo slug drops to its owner | `nameFromKey` | 3 names improved, **0 removed** |

384 tests (376 before: +8), typecheck and lint clean.

## F1 is not in TICKET-0009's file, and the ticket said it was

`deriveName` and `nameFromKey` live in `src/source/candidate.ts`, which is
TICKET-0012's module. The gate's instruction was _"any classifier or
canonicalisation bug found here is fixed in TICKET-0009 or TICKET-0010"_, and a
naming rule is neither — it is candidate derivation, and inconsistency 40 was
raised against 0012 in the first place.

Not reshuffled a third time. The fix is where the code is, the ticket says so,
and this is the third scoping correction in three sessions — which is either a
sign the gate's fix list was written faster than it was checked, or a sign that
scoping a fix before opening the file is worth doing anyway because it is cheap
to correct. That judgement is the author's.

## Three of my own estimates were wrong. All three in the same direction

The gate predicted the effect of these fixes on its own 48 candidates. Re-running
the four topics turned every prediction into a measurement, and two of the three
numbers were optimistic.

**Junk: predicted 5 → 1, measured 5 → 1.** Correct. The ACM paper
(`camps.aptaracorp.com/ACM_PMS/…`) and the personal blog
(`blog.zmalik.dev/p/…`) both dropped out. The survivor is `demo.coroot.com`, a
live demo instance of a company already in the same list, and it needs
TICKET-0015's `homepage` field exactly as predicted.

**Fallback names: predicted 13 → 6, measured 13 → 13.** Wrong, and wrong about
what the fix does. F1 does not turn a fallback name into a lifted one — nothing
about the post title changed, so a candidate named from its address is still
named from its address. What F1 changes is the _shape_ of the fallback:
`torrix-ai/install` → `torrix-ai`, `betterdb-inc/monitor` → `betterdb-inc`,
`rocketgraph/rocketgraph` → `rocketgraph`. Three of thirteen stop reading as a
product. **The count was never the right measure** — a candidate named
`splabs.io` is fine and always was, and the gate should have counted _misleading_
names rather than fallback ones. It counted 13 fallbacks and 7 "avoidable"; the
honest number for what F1 can reach is 3.

**F1's own reach: the gate said 7 of 48, measured 3 of 48.** Of the seven names
it listed, four have distinctive repo slugs — `nullswan/bpfsnitch`,
`liquidos-ai/autoagents`, `yantrikos/yantrikdb-server`, `xqlsystems/xarray-sql`
— and dropping those would lose the only word that tells two repos from one
owner apart. They are kept, and pinned by a test that says so.

`torrix-ai/install` is the case worth staring at. The company is **Torrix**; its
own post title says so — `Show HN: Torrix, self hosted, LLM Observability`. F1
gets to `torrix-ai`, which is the org that owns the repo, and not to `Torrix`,
which is the name. The rule that would reach it is the _other_ direction
inconsistency 40 named: accept `, ` as a title separator when the head is short.
It is not taken here. n=1 across four topics, the gate chose this direction, and
a punctuation rule that fires on every comma in every HN title is a much wider
change than a thirty-word list. Recorded as inconsistency 49.

## F4 is narrower than the fix as written down

The scoped fix was "a `blog.` subdomain **and** a `/p/<slug>` path are an
article". Only the first landed.

`/p/` is one publisher's convention — Substack's — rather than a shape of the
web, and `acme.dev/p/pricing` is a product page. `classifyHit`'s asymmetry
decides it: a wrong reject leaves no trace anywhere in the output while a wrong
accept costs one analysis and is visible in a memo (worklog 0015). A `blog.`
host does not have that problem; it is a blog by its own declaration, whoever
owns it. The omission is pinned by a test rather than left as an absence.

## What the re-run also found

**A thin list gets thinner.** `eBPF observability` came back with **11**
candidates against `--limit 12`. Both rejections landed on the run that had 13
sites to begin with, and nothing goes back for a replacement (inconsistency 43).
Rejecting junk on a thin topic does not promote a better candidate — it just
leaves a shorter list. That is correct behaviour and worth seeing before stage 2
reads a manifest that says `limit: 12` above eleven candidates.

**A new naming defect, n=1.** The backfilled candidate on that run is named
`Aacyn v0.7.0` — a version string lifted from a post title, through a rule that
is working exactly as specified (`looksLikeName` counts words and characters; it
has no opinion about version numbers). One example, no fix, recorded as
inconsistency 50.

**Names inherit the dedup key's lowercasing.** `BetterDB-inc` prints as
`betterdb-inc` because `siteKey` lowercases a code-host key for identity and the
name is lifted from the key. A real loss of fidelity, and cheaper than letting
the name and the grouping drift apart. Noted in the test.

## Verification

- `pnpm test` — **384 passed** (376 before: +8). Offline, no key.
- `pnpm typecheck`, `pnpm lint` clean.
- The gate's four topics re-run and the candidate lists diffed by hand. `AI
agent infrastructure` and `vector database` unchanged; `LLM observability`
  changed in three names and nothing else; `eBPF observability` lost the paper
  and the blog and gained one candidate at rank 11.
- Nothing from those runs is committed.

## What the record should be honest about

**`GENERIC_REPO_SLUGS` is a thirty-word guess** — the eighth unmeasured constant
in this codebase, and the one with the least data behind it. It fires on two
real examples. It fails in the safe direction: an unlisted slug keeps
`owner/repo`, which is what happened before this commit.

**F2 is one host.** There is no general rule for "is this a paper" learnable
from one url, and a general rule is how a classifier starts rejecting companies.

**The gate's fix list was written from a hand-read and its predictions were not
checked.** Two of three were wrong, one badly. The fixes themselves survived
contact; the arithmetic around them did not.

## Decisions taken

No open decision in STATE.md was answered. Two scoping decisions were taken
against the gate's own text: **F1 lands in `candidate.ts`** (TICKET-0012's
module, because that is where the code is), and **F4 ships without its
`/p/<slug>` half**.

**TICKET-0009 is Done again.** All five gate fixes have landed or been
deliberately narrowed.

## Attribution

`GENERIC_REPO_SLUGS`, `BLOG_SUBDOMAIN`, the `PAPER_HOSTS` entry, the
`nameFromKey` rewrite, all 8 tests and this worklog's factual sections are
AI-written end-to-end. The decision to narrow F4, the decision to leave the
comma-separator direction alone, and the correction of the gate's three
estimates were the AI's.

## Reflection

Some static guardrails were added to avoid junk results, but I think these might not hold well in a large dataset

## Next

Stage 1's gate is fully closed. Two Ready tickets and no blockers between them:

- [TICKET-0014](../tickets/0014-ticket-fixture-capture-script.md) —
  `pnpm capture-fixtures`, now against post-fix behaviour. `eBPF observability`
  is the awkward payload the suite has never had.
- [TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md) — the provider
  and response cache, which is the only way to answer the question the gate
  could not: _were the clarification options actually good?_
