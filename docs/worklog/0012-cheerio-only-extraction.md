# Session 0012 — 2026-08-22 — D-8: cheerio only, no DOM

A decision and no code. [D-8](../STATE.md) was raised at the end of
[worklog 0011](./0011-cached-fetch-layer.md) and answered by the author in the
same sitting; this entry exists because the decision changes an accepted ADR,
and a decision that edits an ADR without a worklog behind it is exactly the
retro-assembled trail this project is trying not to produce.

## What I asked for

Review of the fetch layer, and then: _"Log cheerio use, leave implementation for
later."_ Take D-8 at its default, write it down properly, do not write the
extraction code yet.

## The decision

**`cheerio` alone. `@mozilla/readability` is cut, and with it the DOM
(`jsdom` / `linkedom` / `happy-dom`) it requires.**

Extraction becomes: strip `script/style/nav/footer/aside`, read `<title>`, the
`og:` tags, and the main content block. That covers what stage 2 actually reads
— a team page, a meta description, repo metadata — which is what ADR-0005 said
the extraction was for in the first place: _"our extraction is mostly
structured, not prose."_

The cost is real and is recorded rather than waved off: long-form pages, a
founder's blog post or a launch write-up, will extract with more boilerplate
than a readability pass would leave. If facts start arriving with navigation
text attached, the fix is one library plus a DOM and the amendment says so.

## What changed

Documents only. No `src/` change, no dependency added or removed, no test
touched — `cheerio` is not in `package.json` yet either, because nothing imports
it yet.

| File                                                          | Change                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [ADR-0005](../adr/0005-typescript-stack.md)                   | New **Amendment** section, and a pointer on the original consequence paragraph so it cannot be read alone. Original text left intact |
| [`adr/README.md`](../adr/README.md)                           | 0005's status reads `Accepted · amended 2026-08-22`                                                                                  |
| [ARCHITECTURE](../ARCHITECTURE.md)                            | §6 layout comment and the §8 stack row both drop readability                                                                         |
| [TICKET-0008](../tickets/0008-ticket-cached-fetch-layer.md)   | Scope and dependency lines rewritten to cheerio-only; Progress says the half is unblocked and unwritten                              |
| [TICKET-0016](../tickets/0016-ticket-company-site-adapter.md) | Same, for the company site adapter that would have used the prose path                                                               |
| [STATE](../STATE.md)                                          | D-8 moved to _Recently closed_ with the reasoning; "next session" now says write the extraction                                      |
| [worklog 0011](./0011-cached-fetch-layer.md)                  | One `Update` line pointing here. The entry is otherwise unedited                                                                     |

## Two judgement calls

**1. Amend ADR-0005 rather than write ADR-0009.** The pairing was decided in
0005's consequences, so that is where a reader looking for "why cheerio" will
land, and a second ADR would leave the first one quietly wrong. The amendment is
dated and additive — the original paragraph still says what it said, with a
pointer appended — because an ADR that is edited to look correct in hindsight is
worth as little as a worklog that is. The counter-argument, that a dependency
cut is its own decision and deserves its own record, is not unreasonable; if a
reviewer prefers it, promoting the amendment to ADR-0009 is a copy-paste.

**2. Record it with no code behind it.** A decision landing one commit ahead of
its implementation is a small risk: the docs describe extraction that does not
exist. It is mitigated by TICKET-0008 staying Ready-not-Done and by STATE naming
the extraction as the next thing to write. The alternative — hold the decision
until the code is ready — is how trails get assembled after the fact.

## Verification

Documents only, so the gates are unchanged rather than re-proven: `pnpm test`
103 passed, `pnpm typecheck` and `pnpm lint` clean, as at worklog 0011.
`grep -rn "readability" docs/` now returns only the ADR-0005 amendment, the
lines that record the cut in ARCHITECTURE, STATE and the two tickets, and these
two worklog entries. No document still describes readability as something this
pipeline will use.

## Decisions taken

**D-8 closed**, at its default, by the author. D-2, D-4, D-5, D-6 and D-7 stay
open. No new decision raised.

## Attribution

The decision is the author's — the question was surfaced by the AI at the end of
session 0011 with a recommendation, and the author took it. The document edits
and the factual sections of this entry are AI-written end-to-end, reviewed
before the commit.

## Reflection

Contemplating between readability and Cheerio, I am leaning more towards Cheerio for now.

## Next

Finish [TICKET-0008](../tickets/0008-ticket-cached-fetch-layer.md) — the
cheerio extraction, `fetchEvidence(url, type)`, and a committed fixture page —
then [TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md), the HN Algolia
adapter and the first real caller of `httpGet`.
