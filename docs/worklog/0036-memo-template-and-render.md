# Session 0036 — 2026-08-23 — The memo template and renderer

[TICKET-0024](../tickets/0024-ticket-memo-template-and-render.md)'s second half,
in three commits. `templates/memo.md.eta` and `src/memo/render.ts` turn an
`Analysis` into the page a partner reads. **The ticket is done**; every
acceptance item is met, and two golden memos are committed so that a change to
how a memo reads is reviewed by reading a memo.

## What I asked for

Continue with the renderer and template.

## What landed

| Commit    | Contents                                                       | Tests |
| --------- | -------------------------------------------------------------- | ----- |
| `133dde9` | `why_this_call` derived in stage 2 — `Analysis` v4             | +7    |
| `c00edf2` | `eta` as a dependency, D-2 taken, ADR-0005 amended             | 0     |
| `6502cd0` | The template, the renderer, `pnpm golden`, two committed memos | +19   |

**985 tests** (959 at the start: +26), typecheck and lint clean, offline and
with no `.env`. No token was spent — stage 3 cannot spend one.

## Four decisions

**1 — D-2 taken at its documented default: `eta`.** The amendment in
[ADR-0005](../adr/0005-typescript-stack.md) records both halves honestly. The
argument for a template was _a partner can edit a memo without reading
TypeScript_ — and after the derivation shipped, the template is a header line,
four loops and a table, which is exactly the shape a plain string function could
produce with no dependency at all. The default still holds because the layout is
the one part of this pipeline a **reader** of the output is entitled to change,
and asking them to edit TypeScript to move a heading is the wrong trade for one
small library. The counter-argument is written down rather than left out.

**2 — "Why this call" is derived, not templated.** SPEC §4 opens with three
sentences leading with the decisive factor, and _deciding which dimension is
decisive_ is a reading of the rubric's output. A template that picks it has a
judgement in it, and a judgement in a template is invariant 3 broken somewhere
nobody looks. So it became `Analysis` v4, one commit after v3 — the version bump
is the cost of keeping stage 3 free of decisions, and it is cheap now and not
after TICKET-0028.

The mechanical stand-in for "decisive" is deliberately crude and named as such
in the module: the strongest covered dimension for a meeting, the covered
dimension furthest from its own ceiling otherwise, and nothing at all when
nothing was covered.

**3 — Citation labels are memo-local.** An evidence id is sixteen hex
characters; a bullet ending in `[a1b2c3d4e5f60002]` is unreadable, and one
ending in `[E1]` is untraceable on its own. The sources table carries both —
`| E1 (`a1b2c3d4e5f60002`) | url | retrieved | type |` — which keeps SPEC §4's
four columns and still lets a reader go from a bullet to a file on disk.

**4 — An unresolvable id is written as unknown, never dropped.** If a cited id
has no record behind it, the row still appears with `unknown` in every column.
Dropping it would produce a memo that looks complete while citing something
nobody can check, and the memo validator (TICKET-0025) can only fail the run
over it if the renderer leaves it visible. That is rule 1 in `render.ts`, and it
has a test.

## The tests

**19 in `tests/memo-render.test.ts`**, plus TESTING §7's snapshot as two
committed goldens in `tests/golden/`:

- **`golden`** — a Watch at 69/100, three fact sections, a low-confidence
  statement, a partial status, an upgrade trigger three points from a meeting.
- **`thin`** — a Pass forced by two disqualifiers: a Risks section, two
  uncovered dimensions, a site that did not resolve, and no Team or Market
  section at all, because an empty section is deleted rather than faked.

Both analyses were produced by running the real `scoreCandidate` and
`deriveMemoFields` over hand-written facts, so their scores, bands and triggers
are the pipeline's own arithmetic rather than numbers somebody typed. They are
frozen inputs; `pnpm golden` regenerates the memos from them and
`pnpm golden --check` fails when the snapshots are stale.

The acceptance items, literally:

- **The call is legible in the first line** — `# Acme Traces — WATCH · score
69/100 · coverage 100%`, with the company on line three.
- **Empty `unknowns[]` renders no "could not verify" section**, and a non-empty
  one renders every entry.
- **Zero network calls, asserted with a stub** — `globalThis.fetch` is replaced
  by a function that fails the test if it is reached.

Two more that guard the citation guarantee rather than the layout: every `fact`
bullet in the markdown ends in a label, and every label has a row in the sources
table. Those are the halves a template can silently drop.

The three committed live analyses are also rendered, structurally rather than as
a snapshot — TICKET-0028 will replace them, and a memo test pinned to a real
company's prose would then fail for the wrong reason.

## What running it changed

Rendering the live run's three analyses before writing any test caught four
things, all layout and all invisible in the JSON:

1. **The header was three lines and SPEC's is two.** The call, score and
   coverage now share line one.
2. **Blank lines multiplied** wherever a template block ended. Fixed by
   normalising whitespace in the renderer rather than by turning on eta's
   `autoTrim`, which decides where paragraph breaks go — and a paragraph break
   in markdown is syntax.
3. **`why_this_call` sentences printed without citations**, so ids reached the
   sources table without ever appearing inline. The template prints their labels
   now.
4. **"disqualifier D-2, D-3 fired"** — the plural case had never been rendered.

## Gaps

1. **`pnpm golden --check` is not wired into `pnpm test`.** The snapshot test
   catches a stale memo already; the script exists for regenerating and for a
   CI step that does not exist yet.
2. **The goldens are invented companies.** They pin the template, not the
   thesis. Whether a partner can act on these memos is TICKET-0028's question.
3. **The renderer takes an evidence array, not the store.** Reading
   `runs/<id>/evidence/` is TICKET-0026's job, which is also where a memo
   reaches disk. Nothing writes a `.md` file yet.
4. **The `Memo` contract is unchanged at v1** and carries `markdown` plus
   `citations`. If TICKET-0025's validator wants structure — per-bullet
   citations, say — that is a bump, and this is the note that it was considered
   and not taken.

## Attribution

`templates/memo.md.eta`, `src/memo/render.ts`, `scripts/render-golden.ts`, the
`why_this_call` derivation, both golden fixtures, all 26 tests and this
worklog's factual sections are AI-written end to end. The four layout defects in
"what running it changed" were found by rendering real analyses and reading
them, not by a test.

## Reflection

Analysis schema changed a number of times. Seems like the planning did not scope it out properly.

## Next

**TICKET-0024 is Done.** The two that follow it are both unblocked:

- [TICKET-0025](../tickets/0025-ticket-memo-validator.md) — the memo validator.
  `BulletKind` was designed for it: hard-fail an uncited `fact`, never an honest
  gap, and resolve every id in `Memo.citations` against the run's evidence
  store.
- [TICKET-0026](../tickets/0026-ticket-stage-3-wiring.md) — `./pipeline memo`,
  which is where a memo first reaches disk.

[Inconsistency 84](../STATE.md) is still unsettled and still blocks
TICKET-0028.
