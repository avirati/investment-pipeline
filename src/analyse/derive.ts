import type {
  Call,
  Dimension,
  Disqualifier,
  Fact,
  MemoBullet,
  MemoHeading,
  MemoSection,
} from "../contracts/index.js";
import { FACT_KEY_LIST, type FactKey, isFactKey } from "./keys.js";
import {
  type BandUp,
  COVERAGE_GATE,
  MEETING_SCORE,
  nextBandUp,
  refutedBy,
  WATCH_SCORE,
} from "./score.js";

/**
 * The memo's body, derived (TICKET-0024, STATE inconsistency 9).
 *
 * SPEC §4 asks for three sentences on why this call, a Team / Product / Market /
 * Risks split, a falsifiable "what would change my mind" list, and — SPEC §3 —
 * a checkable upgrade trigger on every Watch. Two invariants close off the
 * obvious ways to produce them: the
 * model may not write them (invariant 1, ADR-0002) and stage 3 may not invent
 * them (invariant 3). So they are derived here, from what stage 2 already has,
 * and stage 3 becomes a rendering of this file's output.
 *
 * Four rules shape it.
 *
 * 1. **Nothing here writes a sentence about a company.** A bullet's text is
 *    either a `Fact.statement` verbatim, a `Disqualifier.statement` verbatim,
 *    or a rubric band's own `needs` sentence with the dimension's name and
 *    arithmetic around it. This module contributes conjunctions and nothing
 *    else. If a memo ever says something neither the model nor the rubric said,
 *    this is the file that broke. The one exception is `why_this_call`, whose
 *    sentences are about *this analysis* rather than about the company — they
 *    restate the call, its arithmetic and the dimension that decided it, and
 *    every number in them is already in the file.
 *
 * 2. **It states no criterion.** Every threshold, band and refutation is read
 *    from `src/analyse/score.ts` through `nextBandUp` and `refutedBy` — the
 *    thesis stays in one file (invariant 7). The only judgement expressed here
 *    is *which* of the rubric's own sentences is worth printing, and that is
 *    ordering, which rule 3 makes mechanical.
 *
 * 3. **Order is the vocabulary's, not a ranking.** Bullets come out in
 *    `FACT_KEY_LIST` order and dimensions in rubric order, because any other
 *    order would be this module deciding what matters — and "what matters" is
 *    the rubric's, expressed as points. The one place points do the ordering is
 *    the change-my-mind list, where the ordering *is* the arithmetic.
 *
 * 4. **A cap says what it dropped.** Sections are capped at
 *    `SECTION_BULLET_CAP`, and the count that did not fit travels with the
 *    section. A silent truncation reads to a partner as coverage.
 *
 * ## Known gaps
 *
 * 1. **Market is where the traction vocabulary lands.** SPEC §4 fixes four
 *    headings and the 24 keys have far more to say about pull than about market
 *    size — so stars, contributors, named users, integrations and the HN thread
 *    are filed under Market, beside the "why now" keys. The alternative was a
 *    fifth heading SPEC does not have. It reads acceptably (a named user *is* a
 *    competitive-set observation) and it is the loosest join in this file.
 *
 * 2. **A gap is printed once, not twice.** SPEC's "what we could not verify"
 *    list is exactly the uncovered dimensions, so listing them under Risks as
 *    well would make every memo say the same thing twice. They enter Risks only
 *    when coverage is below the rubric's gate — the case where the gap is not
 *    merely a gap but the thing capping the call.
 *
 * 3. **Nothing here is validated.** Same as the rubric: no eval harness in v1
 *    (SCOPE). Whether three change-my-mind lines are the *useful* three is a
 *    question the first read of a real memo answers, not this file.
 */

/** SPEC §4: *≤ 5 bullets* per section. */
export const SECTION_BULLET_CAP = 5;

/** SPEC §4: *2–3 falsifiable, checkable statements*. The ceiling of that range. */
export const CHANGE_MY_MIND_CAP = 3;

/** SPEC §4: *≤ 3 sentences* on why this call. */
export const WHY_THIS_CALL_CAP = 3;

/* -------------------------------------------------------------------------- */
/* Which heading a fact is filed under                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every key in the vocabulary, and the memo heading it prints under. Typed as a
 * total record over `FactKey` so that adding a key to `keys.ts` without filing
 * it here fails to compile rather than dropping an observation quietly.
 *
 * Risks is deliberately absent: no key produces a risk. Risks is built from the
 * rubric's own findings, below.
 */
export const HEADING_OF: Record<FactKey, MemoHeading> = {
  "founder.name_role": "Team",
  "founder.prior_role": "Team",
  "founder.prior_exit": "Team",
  "founder.prior_artifact": "Team",
  "team.size_visible": "Team",
  "org.github_account_type": "Team",
  "product.one_liner": "Product",
  "product.job": "Product",
  "product.category_claim": "Product",
  "product.runtime_position": "Product",
  "product.data_accumulated": "Product",
  "product.open_source": "Product",
  "adoption.self_serve": "Product",
  "adoption.pricing_public": "Product",
  "adoption.sales_gate": "Product",
  // Gap 1: the "why now" keys and the whole traction vocabulary, together.
  "product.capability_dependency": "Market",
  "product.launch_date": "Market",
  "traction.github_stars": "Market",
  "traction.repo_activity": "Market",
  "traction.contributors": "Market",
  "traction.named_user": "Market",
  "traction.integration": "Market",
  "traction.hn_engagement": "Market",
  "funding.raised_usd": "Market",
};

/** The order the memo prints its body in (SPEC §4). */
export const HEADINGS: readonly MemoHeading[] = ["Team", "Product", "Market", "Risks"];

/* -------------------------------------------------------------------------- */
/* Input and output                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything the derivation is allowed to see: the analysis, minus the parts
 * that describe how it was produced. Deliberately not an `Analysis` — this runs
 * *while* one is being assembled, and taking the whole thing would let a future
 * edit reach for `inputs` or `status` and start writing prose about the run.
 */
export interface DeriveInput {
  facts: readonly Fact[];
  dimensions: readonly Dimension[];
  disqualifiers: readonly Disqualifier[];
  score: number;
  coverage: number;
  call: Call;
}

export interface Derived {
  why_this_call: MemoBullet[];
  sections: MemoSection[];
  what_would_change_my_mind: MemoBullet[];
  upgrade_trigger: string | null;
}

/* -------------------------------------------------------------------------- */
/* The four sections                                                           */
/* -------------------------------------------------------------------------- */

const KEY_ORDER = new Map<string, number>(FACT_KEY_LIST.map((key, index) => [key, index]));

/**
 * A fact as a bullet. The statement is printed verbatim — rule 1 — with one
 * addition: the model's own confidence, when it is `low`. The rubric refuses to
 * score confidence (`score.ts` rule 5) precisely so that a partner can see it
 * instead, and a low-confidence sentence printed like any other is the one
 * place that promise could quietly break.
 */
function bulletOf(fact: Fact): MemoBullet {
  const text =
    fact.confidence === "low" ? `${fact.statement} (model confidence: low)` : fact.statement;
  return { kind: "fact", text, evidence_ids: [...fact.evidence_ids] };
}

/** Normalised for duplicate detection only. Never printed. */
const normalise = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Facts under their headings, in vocabulary order, deduplicated by statement.
 *
 * A model asked the same question about two pages will sometimes return the
 * same sentence twice with different citations; that is one observation with
 * two sources, so the ids merge rather than the line repeating.
 */
function factSections(facts: readonly Fact[]): Map<MemoHeading, MemoBullet[]> {
  const ordered = [...facts]
    .map((fact, index) => ({ fact, index }))
    .filter((entry) => isFactKey(entry.fact.key))
    .sort((left, right) => {
      const byKey =
        (KEY_ORDER.get(left.fact.key) ?? Number.MAX_SAFE_INTEGER) -
        (KEY_ORDER.get(right.fact.key) ?? Number.MAX_SAFE_INTEGER);
      return byKey !== 0 ? byKey : left.index - right.index;
    });

  const sections = new Map<MemoHeading, MemoBullet[]>();
  const seen = new Map<string, MemoBullet>();

  for (const { fact } of ordered) {
    const heading = HEADING_OF[fact.key as FactKey];
    const bullet = bulletOf(fact);
    const key = `${heading} ${normalise(bullet.text)}`;
    const already = seen.get(key);
    if (already) {
      for (const id of bullet.evidence_ids) {
        if (!already.evidence_ids.includes(id)) already.evidence_ids.push(id);
      }
      continue;
    }
    seen.set(key, bullet);
    const bullets = sections.get(heading);
    if (bullets) bullets.push(bullet);
    else sections.set(heading, [bullet]);
  }
  return sections;
}

/* -------------------------------------------------------------------------- */
/* Risks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Risks, from three mechanical sources and no fourth.
 *
 * 1. **Every fired disqualifier**, verbatim and cited. It forced the call
 *    (SPEC §1.1), so it leads.
 * 2. **Every covered dimension sitting in the rubric's lowest band** — we read
 *    something and what we read did not meet the band above. The bullet says
 *    what that band wanted, which is the only honest way to state the finding
 *    without judging the company.
 * 3. **Uncovered dimensions, when coverage is below the gate** — gap 2. Below
 *    the gate the missing reading is what caps the call, so it belongs beside
 *    the risks rather than only in the list of things we could not verify.
 */
function riskBullets(input: DeriveInput): MemoBullet[] {
  const bullets: MemoBullet[] = [];

  for (const disqualifier of input.disqualifiers) {
    bullets.push({
      kind: "fact",
      text: `Disqualifier ${disqualifier.id} — ${disqualifier.statement}`,
      evidence_ids: [...disqualifier.evidence_ids],
    });
  }

  for (const dimension of input.dimensions) {
    const up = nextBandUp(dimension);
    if (!up?.bottom) continue;
    bullets.push({
      kind: "gap",
      text:
        `${dimension.id} ${dimension.name} scored in its lowest band (${dimension.band}): ` +
        `nothing in the evidence read met ${up.to}, which asks for ${up.needs}.`,
      evidence_ids: [...dimension.evidence_ids],
    });
  }

  if (input.coverage < COVERAGE_GATE) {
    for (const dimension of input.dimensions) {
      if (dimension.covered) continue;
      const up = nextBandUp(dimension);
      bullets.push({
        kind: "gap",
        text:
          `${dimension.id} ${dimension.name} is unknown, and coverage is below the ` +
          `${percent(COVERAGE_GATE)}% gate: nothing was read, and reading it asks ` +
          `for ${up?.needs ?? "any primary source"}.`,
        evidence_ids: [],
      });
    }
  }

  return bullets;
}

/* -------------------------------------------------------------------------- */
/* What would change my mind                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The rubric's own next steps, ordered by what they are worth.
 *
 * Quantified moves come first, largest gain first — that ordering *is* the
 * arithmetic, which is rule 3's one exception. An uncovered dimension carries
 * no gain (`nextBandUp` refuses to guess one), so it sorts after them, in rubric
 * order. Ties break on rubric order too, so the list is stable.
 */
function opportunities(dimensions: readonly Dimension[]): BandUp[] {
  const ups = dimensions
    .map((dimension, index) => ({ up: nextBandUp(dimension), index }))
    .filter((entry): entry is { up: BandUp; index: number } => entry.up !== null);

  return ups
    .sort((left, right) => {
      const byGain = (right.up.gain ?? -1) - (left.up.gain ?? -1);
      return byGain !== 0 ? byGain : left.index - right.index;
    })
    .map((entry) => entry.up);
}

/**
 * One line of "what would change my mind", from one step up the rubric.
 *
 * Two short sentences — the thing to find, then what finding it is worth —
 * rather than one conditional. A band's `needs` is a noun phrase carrying its
 * own commas and dashes, so both "if … exists," and a dash-joined clause
 * produced sentences a partner had to read twice. That was visible in the first
 * three real analyses this was run over and invisible in every fixture.
 */
function checkOf(up: BandUp): MemoBullet {
  const text = up.uncovered
    ? `${up.id} ${up.name}: find ${up.needs}. Nothing was read for this dimension — it is ` +
      `scored at ${up.from} and drags coverage down.`
    : `${up.id} ${up.name}: find ${up.needs}. That moves it from ${up.from} to ${up.to} ` +
      `(+${up.gain ?? 0}).`;
  return { kind: "check", text, evidence_ids: [] };
}

function changeMyMind(input: DeriveInput): MemoBullet[] {
  const bullets: MemoBullet[] = [];

  // A fired disqualifier decided the call, so what would refute it is the first
  // thing worth checking — and it is the only entry here that carries citations,
  // because the observation it turns on was itself cited (rubric rule 4).
  for (const disqualifier of input.disqualifiers) {
    const refutation = refutedBy(disqualifier.id);
    if (!refutation) continue;
    bullets.push({
      kind: "check",
      text:
        `Disqualifier ${disqualifier.id}: find ${refutation}. It would then no longer hold, ` +
        "and the call would no longer be forced to Pass.",
      evidence_ids: [...disqualifier.evidence_ids],
    });
  }

  for (const up of opportunities(input.dimensions)) bullets.push(checkOf(up));

  return bullets.slice(0, CHANGE_MY_MIND_CAP);
}

/* -------------------------------------------------------------------------- */
/* Why this call                                                               */
/* -------------------------------------------------------------------------- */

const percent = (share: number): number => Math.round(share * 100);

/**
 * The verdict, in one sentence: what the call is and the arithmetic that
 * produced it. Four shapes, and the first is the one that overrides everything
 * (SPEC §1.1) — a cited disqualifier forces a pass whatever the score, so it is
 * the only sentence here that carries evidence ids.
 */
function verdict(input: DeriveInput): MemoBullet {
  const at = `${input.score}/100, ${percent(input.coverage)}% coverage`;

  if (input.disqualifiers.length > 0) {
    const ids = input.disqualifiers.map((entry) => entry.id);
    const named =
      ids.length === 1
        ? `disqualifier ${ids[0]}`
        : `disqualifiers ${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
    return {
      kind: "summary",
      text:
        `Pass — ${named} fired, and a cited disqualifier forces a pass whatever ` +
        `the score (${at}).`,
      evidence_ids: [...new Set(input.disqualifiers.flatMap((entry) => entry.evidence_ids))],
    };
  }

  const text =
    input.call === "TAKE_A_MEETING"
      ? `Take a meeting — ${input.score}/100 clears the ${MEETING_SCORE} threshold, at ` +
        `${percent(input.coverage)}% coverage.`
      : input.call === "WATCH" && input.score >= MEETING_SCORE
        ? `Watch — ${input.score}/100 clears ${MEETING_SCORE}, but ${percent(input.coverage)}% ` +
          `coverage is below the ${percent(COVERAGE_GATE)}% gate, which caps the call at Watch.`
        : input.call === "WATCH"
          ? `Watch — ${input.score}/100 meets the ${WATCH_SCORE} a watch needs and is below ` +
            `the ${MEETING_SCORE} a meeting needs, at ${percent(input.coverage)}% coverage.`
          : `Pass — ${input.score}/100 is below the ${WATCH_SCORE} a watch needs, at ` +
            `${percent(input.coverage)}% coverage.`;

  return { kind: "summary", text, evidence_ids: [] };
}

/**
 * The decisive factor, mechanically chosen: for a meeting it is the strongest
 * covered dimension, and for anything else it is the covered dimension furthest
 * from its own ceiling. Ties break on rubric order.
 *
 * This is the one place the derivation picks *which* number to lead with, and
 * the rule is deliberately crude — "decisive" as SPEC means it is a judgement,
 * and the honest mechanical stand-in is the largest number in the direction the
 * call went. Null when nothing was covered: there is then no reading to lead
 * with, and the coverage sentence says so instead.
 */
function decisive(input: DeriveInput): MemoBullet | null {
  const covered = input.dimensions.filter((dimension) => dimension.covered);
  if (covered.length === 0) return null;

  const best = covered.reduce((left, right) =>
    input.call === "TAKE_A_MEETING"
      ? right.score > left.score
        ? right
        : left
      : right.max - right.score > left.max - left.score
        ? right
        : left,
  );
  const lead = input.call === "TAKE_A_MEETING" ? "The strongest reading" : "The largest shortfall";
  return {
    kind: "summary",
    text: `${lead} is ${best.id} ${best.name} at ${best.score}/${best.max} (band ${best.band}).`,
    evidence_ids: [...best.evidence_ids],
  };
}

/**
 * SPEC §4's opening: at most three sentences, leading with what decided it.
 *
 * The third sentence exists only when something was not read, and it points at
 * the section that lists it rather than repeating it — invariant 4 asks for
 * unknowns to be written down, not written down twice.
 */
function whyThisCall(input: DeriveInput): MemoBullet[] {
  const bullets: MemoBullet[] = [verdict(input)];

  const factor = decisive(input);
  if (factor) bullets.push(factor);

  const uncovered = input.dimensions.filter((dimension) => !dimension.covered).length;
  if (uncovered > 0) {
    bullets.push({
      kind: "summary",
      text:
        `${uncovered} of ${input.dimensions.length} dimensions had no primary source behind ` +
        "them; they are listed under what we could not verify.",
      evidence_ids: [],
    });
  }

  return bullets.slice(0, WHY_THIS_CALL_CAP);
}

/* -------------------------------------------------------------------------- */
/* The Watch upgrade trigger                                                   */
/* -------------------------------------------------------------------------- */

const points = (n: number): string => `${n} point${n === 1 ? "" : "s"}`;

const move = (up: BandUp): string =>
  `${up.id} ${up.name} from ${up.from} to ${up.to} (+${up.gain ?? 0})`;

/** A move and what it asks for, kept together — see `checkOf` on why. */
const moveNeeding = (up: BandUp): string => `${move(up)}, by finding ${up.needs}`;

/**
 * SPEC §3's checkable trigger, for a Watch and for nothing else.
 *
 * Three shapes, in the order they are tested:
 *
 * 1. **Coverage is what caps it.** A score at or above the threshold with
 *    coverage below the gate is a Watch by SPEC §3's cap, so the trigger is the
 *    reading that is missing, not points. (The rubric cannot currently reach
 *    this state — `score.ts` gap 2 — and it is written anyway, because the
 *    unreachability is arithmetic that a band edit could change.)
 * 2. **One dimension closes the gap.** The cheapest single move that reaches
 *    the threshold, named with what it asks for.
 * 3. **Several together do.** The largest moves, accumulated until the deficit
 *    is covered.
 *
 * `null` when no combination of the bands above reaches the threshold. That is
 * the honest answer, and it is why `upgrade_trigger` is nullable even on a
 * Watch: a memo that invents a trigger to fill a heading is worse than one that
 * says the heading does not apply.
 */
function upgradeTrigger(input: DeriveInput): string | null {
  if (input.call !== "WATCH") return null;

  const covered = percent(input.coverage);
  const gate = percent(COVERAGE_GATE);
  const ups = opportunities(input.dimensions);
  const uncovered = ups.filter((up) => up.uncovered);

  const coverageClause =
    uncovered.length === 0
      ? `coverage is ${covered}% against the ${gate}% gate`
      : `coverage is ${covered}% against the ${gate}% gate — ` +
        uncovered.map((up) => `${up.id} needs ${up.needs}`).join("; ");

  if (input.score >= MEETING_SCORE) {
    return (
      `${coverageClause}. The score already clears ${MEETING_SCORE}; ` +
      "the gate is what caps this at Watch."
    );
  }

  const deficit = MEETING_SCORE - input.score;
  const quantified = ups.filter((up) => (up.gain ?? 0) > 0);
  const belowGate = input.coverage < COVERAGE_GATE;
  const andCoverage = belowGate ? ` — and ${coverageClause}, which must also be met` : "";

  // The cheapest single move that clears it — and, where two are worth the
  // same, the one the rubric lists first. `quantified` is largest-first, so a
  // strict `<` keeps the earlier of equals rather than the later.
  let single: BandUp | undefined;
  for (const up of quantified) {
    const gain = up.gain ?? 0;
    if (gain < deficit) continue;
    if (single === undefined || gain < (single.gain ?? 0)) single = up;
  }
  if (single) {
    return (
      `${points(deficit)} short of ${MEETING_SCORE} (score ${input.score}). ` +
      `${moveNeeding(single)}, alone clears it${andCoverage}.`
    );
  }

  const taken: BandUp[] = [];
  let gained = 0;
  for (const up of quantified) {
    if (gained >= deficit) break;
    taken.push(up);
    gained += up.gain ?? 0;
  }
  if (gained < deficit) return null;

  return (
    `${points(deficit)} short of ${MEETING_SCORE} (score ${input.score}); no single ` +
    "dimension covers it, but these together do: " +
    `${taken.map(moveNeeding).join("; ")}${andCoverage}.`
  );
}

/* -------------------------------------------------------------------------- */
/* The derivation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `Analysis`'s three derived fields. Pure: same analysis, same memo body, no
 * clock, no IO, no model.
 */
export function deriveMemoFields(input: DeriveInput): Derived {
  const byHeading = factSections(input.facts);
  byHeading.set("Risks", riskBullets(input));

  const sections: MemoSection[] = [];
  for (const heading of HEADINGS) {
    const bullets = byHeading.get(heading) ?? [];
    // SPEC §4: an empty section is deleted, never faked.
    if (bullets.length === 0) continue;
    sections.push({
      heading,
      bullets: bullets.slice(0, SECTION_BULLET_CAP),
      omitted: Math.max(0, bullets.length - SECTION_BULLET_CAP),
    });
  }

  return {
    why_this_call: whyThisCall(input),
    sections,
    what_would_change_my_mind: changeMyMind(input),
    upgrade_trigger: upgradeTrigger(input),
  };
}
