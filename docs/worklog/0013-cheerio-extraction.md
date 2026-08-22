# Session 0013 — 2026-08-22 — HTML→text extraction, and TICKET-0008 closes

The second half of [TICKET-0008](../tickets/0008-ticket-cached-fetch-layer.md).
[Worklog 0011](./0011-cached-fetch-layer.md) shipped the transport and raised
D-8; [worklog 0012](./0012-cheerio-only-extraction.md) closed D-8 in documents
with no code behind it. This entry is the code.

## What I asked for

_"Continue implementation, stop for me to review changes, keep commits / changes
small and easy to review."_ No new decision to take — D-8 was already closed, so
the instruction was to write what the amendment says.

## What the AI produced

Appended to `src/evidence/fetch.ts` (~200 lines), because ARCHITECTURE §6 puts
extraction in that file — _"`fetch.ts` — cached HTTP + cheerio extraction"_ — and
a new `html.ts` would have been a doc change smuggled in with a feature.

| Export                              | What it is                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `extractHtml(html)`                 | Pure, synchronous. Returns `{ title, text, meta }`. No transport, no clock, no I/O — the boilerplate test is a fixture in and a string out |
| `looksLikeHtml(body, contentType)`  | Content type first, body sniff second. Decides whether extraction runs at all                                                              |
| `fetchEvidence(url, type, options)` | The convenience the adapters call: one url in, one `Evidence` out, whatever happened                                                       |

Plus `tests/fixtures/company-site.html` — a hand-written landing page, not a
captured one, so there is no licence question and every hazard is present on
purpose: nav/footer/aside chrome, an inline script and style, `og:` tags that
differ from the visible copy, a `<header>` hero, block elements flush against
each other, and `&nbsp;`/tab whitespace.

`cheerio@1.2.0` added as a runtime dependency. Already justified in ARCHITECTURE
§8 and ADR-0005, so no new ADR — per the CLAUDE.md rule, this line is the record
that it was checked rather than skipped.

## Four judgement calls, in descending order of how much they need review

**1. `<header>` is kept while `nav`, `footer` and `aside` are stripped.** The
ticket's list reads `script/style/nav/footer/aside`, and `<header>` is not on it
— but it is the tag most likely to be _called_ chrome on sight. It is kept
because on a seed-stage company site the hero lives in it, and the hero is the
one-line statement of what the company does, which is exactly what stage 2 is
reading the page for. The cost: sites that put their top nav inside `<header>`
rather than beside it will leak menu text. Mitigated in practice by the main
block usually being selected instead, and by `main_selector` in `meta` making it
visible when it is not.

**2. The meta description leads the extracted text.** `store.ts` already notes
that the model reads the text and not the metadata, so an `og:description` left
in `meta` is invisible to fact extraction — and on a company site it is
routinely the crispest sentence available. So it is prepended, guarded against
the common case where the hero copy _is_ the meta description. The
counter-argument is real: it is the only place extraction reorders a page rather
than transcribing it. It stays because the alternative is losing the sentence,
and the url and timestamp are unchanged, so the citation still resolves to the
page it came from.

**3. An empty `<main>` falls back to `<body>`.** A client-rendered marketing
site ships `<main id="root"></main>`; selecting it extracts nothing from a page
whose server-rendered header does say what the company does. So a matched block
under `MAIN_MIN_CHARS` (200) is treated as a shell and `body` is used instead.
The number is a guess with no measurement behind it, in the same class as
`EVIDENCE_TEXT_LIMIT` and `HTTP_CACHE_MAX_AGE_MS` — carried as STATE
inconsistency 17 rather than raised to a decision, because there is no fork
behind it, only a number.

**4. A non-HTML body is passed through unextracted.** `fetchEvidence` is one
entry point for every evidence type, but the HN and GitHub adapters (0009, 0015)
read JSON structure, not prose. Rather than two functions, the content type
decides, and `meta.extracted` records which path ran. `extract: true | false`
overrides it for the case where a server lies about its content type.

## Two things the record should be honest about

**The record is addressed by the url as requested, not `final_url`.** A redirect
that changes between runs would otherwise change an evidence id and duplicate
the record. Where the body actually came from is in `meta.final_url`. This was
already true of `fetchFailedEvidence`; it is restated here because
`fetchEvidence` is the function adapters will actually call.

**Extraction quality on prose is untested against a real page.** The fixture is
hand-written, which makes it a test of the rules and not of the web. The
ADR-0005 amendment already says long-form pages will extract with more chrome
than readability would leave; nothing in this session measured that, and nothing
should be read as having validated it. The first real check is TICKET-0016.

## Verification

- `pnpm test` — **123 passed** (103 before; +20 here: 12 on `extractHtml`,
  three of them on main-block selection, 2 on `looksLikeHtml`, 6 on
  `fetchEvidence`). Offline, no key, as required.
- `pnpm typecheck` and `pnpm lint` clean. `pnpm format` rewrapped one test line.
- Ticket acceptance: `grep -rn "fetch(" src/ --include='*.ts'` returns one hit —
  the injectable default inside `httpGet`. No stage can reach the network
  another way.

## What went wrong

Nothing that survived. Two things worth naming:

- The first draft took `.text()` off the selected block directly, which returns
  `AboutCareersContact` — cheerio does not insert boundaries at block elements.
  The fix is two text nodes per block element rather than one, so an inline
  element flush against a block cannot fuse across the boundary. There is a test
  for exactly this string.
- `readdirSync` and the biome line-width rule both bit trivially and were fixed
  by `pnpm format`.

## Decisions taken

None. D-8 was already closed and this session implemented it as written. D-2,
D-4, D-5, D-6 and D-7 stay open. One new labelled guess — `MAIN_MIN_CHARS` —
recorded as STATE inconsistency 17, not as a decision.

## Attribution

`src/evidence/fetch.ts`'s extraction half, the fixture page, and the 20 tests
are AI-written end-to-end. The four judgement calls above were made by the AI
and are flagged here so they can be overruled cheaply; none of them was reviewed
before this entry was written.

## Reflection

Cheerio was kept and readability was dropped. Not sure if this alone will hold things together but we shall see.

## Next

[TICKET-0009](../tickets/0009-ticket-hn-algolia-adapter.md) — the HN Algolia
adapter and the first real caller of `httpGet`, now Ready along with
[TICKET-0010](../tickets/0010-ticket-url-resolution-and-dedup.md). 0015 and 0016
unblock from 0008 but still wait on the fixture capture script (0014), which
waits on the hand-check gate (0013).
