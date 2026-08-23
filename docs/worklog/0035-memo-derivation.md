# Session 0035 — 2026-08-23 — The memo's body, derived

[TICKET-0024](../tickets/0024-ticket-memo-template-and-render.md)'s stage-2
half, in six commits. `Analysis` v3 now carries SPEC §4's Team / Product /
Market / Risks split, the "what would change my mind" list and the checkable
upgrade trigger every Watch owes — all three derived mechanically from facts,
dimensions and the rubric. [Inconsistency 9](../STATE.md), open since
TICKET-0005 and half-closed at TICKET-0022, is closed.

The renderer and the template are **not** in this session. They are the second
half of the same ticket and start from an `Analysis` that already has a body.

## What I asked for

Continue implementation, stop for review, small commits on feature branches,
keep the worklogs going with reflection hints, update ticket statuses.

## The decision that came first

TICKET-0024 inherited an open design decision rather than a schema edit, so it
was put to the author before any code:

- **Where the derivation lives** — stage 2 with an `Analysis` bump, split
  between stage 2 and stage 3, or entirely in stage 3 with no schema change.
  **Taken: stage 2, `schema_version` 3.** Stage 3 then renders the analysis and
  nothing else, which is what invariant 3 asks for, and a reader of a committed
  analysis JSON can see the memo's shape without running the renderer.
- **What Risks is built from**, given that no fact key produces a risk.
  **Taken: fired disqualifiers, plus covered dimensions in the rubric's lowest
  band, plus uncovered dimensions.**

## What landed

| Commit    | Contents                                                              | Tests |
| --------- | --------------------------------------------------------------------- | ----- |
| `ff1164b` | Rubric rule 7 — `needs` per band, `refuted_by`, `nextBandUp`         | +14   |
| `9cb3e94` | `Analysis` v3 — `sections`, change-my-mind, `upgrade_trigger`         | +3    |
| `da42c23` | `src/analyse/derive.ts` — the derivation                              | +32   |
| `b0ee4a8` | `analysisFor` calls it; every analysis is written with a body         | +1    |
| `c870092` | Reworded the derived lines after reading three real ones              | 0     |
| `daacaf8` | The committed sample run, re-derived at v3 offline                    | 0     |

**959 tests** (909 at the start of the session: +50), typecheck and lint clean,
offline and with no `.env`. No token was spent: the derivation is pure, and the
committed run was upgraded by re-deriving from the facts it already held.

## Five decisions

**1 — The rubric says what each band asks for; the derivation only composes.**
SPEC §3 wants a Watch's trigger to be *specific and checkable*, and everything
stage 2 had was `Dimension.band` — a range label. A trigger built from that can
only say "seven points higher", which is not a thing anybody can go and look
for. So every band in `score.ts` gained a `needs` sentence restating its own
predicate in searchable terms, every disqualifier gained the observation whose
arrival would refute it, and `nextBandUp` reads the rung above where a dimension
sits. That keeps the thesis in one file (invariant 7): `derive.ts` states no
criterion of its own, and a property test walks every bullet of every fixture
and fails on any text its inputs do not contain.

**2 — Two ends of the ladder say nothing rather than invent a step.** A
dimension in its top band has nothing above it. An **uncovered** dimension gets
the "go and read something" sentence and *no number*, because where it would
land once a source is read is genuinely unknowable — it could be any band — and
a guessed gain is the memo asserting arithmetic it cannot support. The same
refusal is why `upgrade_trigger` is nullable even on a Watch.

**3 — Risks is three mechanical sources, and a gap is printed once.** The
disqualifiers lead, verbatim and cited, because one forced the call. Then any
covered dimension sitting in the rubric's lowest band, phrased as *what the band
above wanted* — the only way to state the finding without judging the company.
Uncovered dimensions were the third source as decided, with one narrowing found
while writing it: SPEC's "what we could not verify" section **is** the list of
uncovered dimensions, so printing them under Risks as well makes every memo say
the same thing twice. They now enter Risks only when coverage is below the
rubric's gate — the case where the gap is not merely a gap but the thing capping
the call. Recorded in the module header as gap 2.

**4 — The contract enforces two of SPEC §4's rules, so the renderer cannot
break them.** A `fact` bullet with no evidence id fails to parse (hard rule 1),
and a section with zero bullets cannot be constructed at all, which is *an empty
section is deleted, never faked* as schema rather than as renderer behaviour.
`BulletKind` distinguishes a claim about the company from a statement about our
reading of it and from a conditional, so TICKET-0025's validator can hard-fail
the first without hard-failing an honest gap.

**5 — The cap says what it dropped.** Five bullets a section, with `omitted`
travelling beside them. A silent truncation reads to a partner as coverage, and
this project has been bitten by silent caps before.

## What running it changed

The derivation was run over the committed live run's three analyses — the first
time it saw sentences a model actually wrote — and two things came out of it.

**The generated prose was bad, in a way no fixture could show.** A band's
`needs` is a noun phrase carrying its own commas and em-dashes, and every
template that wrapped one produced a line a reader has to parse twice:

> If a stated job: the specific task, and the person doing it, the product is
> for exists, D2 Wedge specificity moves from 0–4 to 5–10.

Two rewrites later, every derived line leads with the dimension, says what to
find, and puts the arithmetic in a second sentence:

> D2 Wedge specificity: find a stated job — the specific task the product is
> for, and the person doing it. That moves it from 0–4 to 5–10 (+6).

The fixtures could not have caught this: a fixture's statement is a sentence
written to be short. **Sixth module in a row to change on the day it first met
real data**, and the first where the failure was in prose rather than in logic.

**Freestyle's Market section omitted ten observations.** Team 3, Product 5 (+3),
Market 5 (**+10**), Risks 1. The cap is doing real work, and the reason is the
heading map: SPEC fixes four headings and the vocabulary has nine keys' worth of
traction and "why now" against six for team. New [inconsistency
90](../STATE.md).

Klaus, by contrast, renders with **no Team section at all** — D1 is uncovered,
so there is nothing to file there and the gap goes to "what we could not
verify". That is the design working, and it is worth seeing once before the
renderer exists.

## The tests

**32 new in `tests/derive.test.ts`**, 14 in `tests/score.test.ts`, 3 contract
cases, 1 at the stage seam. The load-bearing ones:

- **"Prints no sentence this module wrote."** Every bullet of every fixture is
  checked to contain a `Fact.statement`, a `Disqualifier.statement`, a band's
  `needs` or a disqualifier's `refuted_by`. This is invariant 1 as a test, and
  it is the assertion that fails first if this file ever starts writing prose.
- **The heading map is total over the vocabulary** — and typed as a `Record<
  FactKey, MemoHeading>`, so a new key that nobody files fails to compile.
- **`nextBandUp` never returns a bottom band's own sentence**, and never
  returns anything for a top band or for a label the rubric did not write.
- **An uncovered dimension yields no gain**, only what to read.
- **The trigger's three shapes**: one dimension clears it, several together
  clear it, and coverage — not points — caps it. The third is `score.ts` gap
  2's unreachable state, reached through `decideCall` directly.
- **Caps, and their `omitted` counts, hold over every fixture.**

## Gaps

1. **The change-my-mind list only looks up.** Every entry is a way to score
   *higher*, because the rubric's bands hold on positive evidence and there is
   no mechanical statement of what would make a call worse. On the run's
   TAKE_A_MEETING that reads oddly: the memo lists three ways to like the
   company more, under a heading a partner reads as "what would make me walk".
   New [inconsistency 91](../STATE.md); it is a rubric question, not a
   derivation one.
2. **Market carries too much of the vocabulary** — [inconsistency
   90](../STATE.md), measured at ten dropped bullets on one of three companies.
3. **`unknowns` and Risks overlap by construction.** Handled with the
   below-the-gate rule (decision 3), which is a judgement call about
   duplication rather than a derivation from SPEC. If a reviewer disagrees, the
   whole of it is one `if` in `riskBullets`.
4. **Nothing here is validated.** Same as the rubric: no eval harness in v1
   (SCOPE). Whether these are the *useful* three checks is a question the first
   read of a real memo answers — TICKET-0028.
5. **The re-derived committed run is one command away from being wrong again.**
   The three analyses were upgraded by a throwaway script, not by re-running the
   stage, because [inconsistency 84](../STATE.md) means `--replay` on a fresh
   clone would overwrite them with empty ones. That is still unsettled and still
   TICKET-0028's blocker.

## Attribution

`src/analyse/derive.ts`, the rubric's `needs` and `refuted_by` sentences,
`nextBandUp`, the `Analysis` v3 fields, all 50 tests and this worklog's factual
sections are AI-written end to end. The two design decisions at the top were the
author's, chosen from options with the trade-offs stated. No human has yet read
a rendered memo, because the renderer does not exist.

## Reflection

TODO(author) — the three questions this session actually raises:

- The derivation composes rubric sentences into memo prose. Is that still
  "widening yes, narrowing no", or has the rubric quietly become a
  sentence-generator with a scoring side-effect?
- Six modules, six defects found by running rather than reading. At what point
  is "budget a live pass per ticket" not a lesson but the process?
- Risks below the gate, change-my-mind only looking up, Market as a catch-all:
  three places where SPEC's memo shape and the fact vocabulary do not line up.
  Is the fix a fifth heading, a bigger vocabulary, or a shorter memo?

## Next

**TICKET-0024's second half** is the renderer: `templates/memo.md.eta`,
`src/memo/render.ts`, no LLM in the stage. It now starts from an `Analysis` that
already carries every section, so the template is a loop over `sections` and the
header line, and the ticket's "if a memo needs prose the analysis does not have,
fix stage 2" clause has nothing left to trip on.

After it: [TICKET-0025](../tickets/0025-ticket-memo-validator.md), whose job
`BulletKind` was designed for.
