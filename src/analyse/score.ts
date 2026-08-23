import type { Call, Dimension, Disqualifier, Evidence, Fact } from "../contracts/index.js";
import type { Signal } from "../evidence/signal.js";

/**
 * The rubric (TICKET-0021). SPEC §1–3 as behaviour, and **the only place in the
 * repo where a score comes into existence** (CLAUDE.md invariants 1 and 7,
 * ADR-0002). Nothing here reads a clock, a file, an environment variable or a
 * model. Facts and signals in, dimensions and a call out; the same inputs
 * always produce the same number, and a reviewer can recompute it by hand from
 * the analysis JSON and SPEC §2.
 *
 * Six rules shape it.
 *
 * 1. **It switches on keys, never on English.** A band predicate may ask
 *    whether a `founder.prior_exit` fact exists and what `github.stars` said.
 *    It may never read a `statement`. A rubric that pattern-matches prose is
 *    the model scoring the company through a regex, which is the thing
 *    ADR-0002 exists to prevent (STATE inconsistency 8). The cost is the
 *    limitation in gap 1 below and it is paid deliberately.
 *
 * 2. **A number comes from the signal, never from the fact.**
 *    `traction.github_stars` is a sentence the model wrote about a star count;
 *    `github.stars` is the star count, read off the payload with no model
 *    involved and dated by `as_of` (`src/evidence/signal.ts`). Where both
 *    exist the rubric reads the signal, and the fact is only ever a citation
 *    and a sentence for the memo. This closes STATE inconsistency 58.
 *
 * 3. **A band pays its top; a gap pays the floor of the second band.** SPEC
 *    gives ranges, and a band is a claim that has been *met* — so meeting it
 *    pays in full, and five top bands come to exactly 100. A dimension with no
 *    primary source behind it is not graded at all: every bottom band in SPEC
 *    §2 is a negative *finding* ("no identifiable founders", "could have been
 *    built in 2021") and a finding needs evidence, so absence cannot land
 *    there. It lands one band up, at that band's floor, and is marked
 *    `covered: false`. This is CLAUDE.md invariant 4 made arithmetic: missing
 *    data lowers coverage and never becomes a zero.
 *
 *    The visible consequence is deliberate. A company whose team page names
 *    nobody scores 5 on D1; a company with no site at all scores 6 and loses a
 *    fifth of its coverage. The first is an observation and the second is a
 *    gap, and the gap is the one that can cap the call at Watch.
 *
 * 4. **A disqualifier is cited or it does not fire.** SPEC §1.1: *we do not
 *    pass on inference*. Each of the four is written as a positive, cited
 *    observation plus the absence that makes it damning — the sales gate we
 *    read, with no self-serve path anywhere beside it — and `disqualify()`
 *    returns null when it has no id to point at, so an uncitable disqualifier
 *    is structurally unable to reach the output. Precedence over score is
 *    absolute and is the first line of `decideCall`.
 *
 * 5. **Confidence is not scored.** `Fact.confidence` is the model's own
 *    estimate, and letting it move a band lets the model move the score by one
 *    remove. It is carried to the memo, where a partner can see it. That is
 *    STATE inconsistency 78's answer.
 *
 * 6. **One list per dimension drives both the citation and the coverage.** A
 *    dimension declares the keys it reads; its `evidence_ids` are the ids
 *    behind those keys and `covered` is whether that set is non-empty. There is
 *    no way to score a dimension off a key it did not declare, and no way to
 *    claim coverage for evidence that did not reach the number.
 *
 * ## What this file is not
 *
 * It is not configurable. The thesis is one fund's and lives here, not in a
 * YAML file a caller could swap (SCOPE cut corner #3, CLAUDE.md invariant 7).
 * It is not validated either: no eval harness ships in v1, the bands below have
 * never been run against a real company, and no test in this repo can tell you
 * they are right. The predicted symptom is candidates clustering in the middle
 * two bands of every dimension — TICKET-0028 is where that gets looked at.
 *
 * ## Known gaps
 *
 * 1. **It cannot read meaning, only presence.** Rule 1's price. SPEC D1 asks
 *    whether the team is *technical*; what this file can ask is whether anybody
 *    is named and whether a named person is stated to have built something
 *    before. A marketing hire with a prior role scores exactly what a kernel
 *    maintainer with a prior role scores. Wherever a band substitutes an
 *    observation for SPEC's criterion the substitution is named in a comment
 *    beside it, because those comments are the list of places this rubric is
 *    weakest and the person validating it should not have to find them.
 *
 * 2. **The coverage gate is correct and unreachable.** Below 60% coverage at
 *    most two of five dimensions carry evidence, and two dimensions cannot
 *    reach 72 points with the other three sitting at their unknown floors — the
 *    ceiling is D1 + D3 covered at 25 each, plus 5 + 4 + 4, which is 63. So
 *    SPEC §3's gate is implemented, tested through `decideCall`, and never
 *    fires through `scoreCandidate`. It is left exactly as SPEC writes it
 *    rather than tuned into reachability, because moving a floor or a threshold
 *    to make a rule fire, before a single real run, is choosing a number to fit
 *    a rule we also invented. A property test pins the claim so it fails loudly
 *    if it stops being true.
 *
 * 3. **Hacker News contributes prose and no metric.** STATE inconsistency 67,
 *    biting where it said it would: points and comment counts never reach the
 *    rubric, so SPEC D3's "HN front page" is not observable and a Show HN with
 *    400 points is worth what one with 4 points is worth. Both cost D3 a band.
 *
 * 4. **Every quantity but one is invented.** SPEC names ">200 stars". The other
 *    six constants below are this file's, chosen to make prose mechanical, and
 *    they are the twelfth hand-written list of guesses in this codebase
 *    (STATE inconsistency 59).
 */

/* -------------------------------------------------------------------------- */
/* The numbers this rubric invented                                            */
/* -------------------------------------------------------------------------- */

/**
 * SPEC names one threshold — ">200 stars" — and every other quantity below is
 * this file's, chosen to make a prose band mechanical. They are exported
 * because a test that hard-codes 200 in two places is a test that stops
 * agreeing with the rubric silently.
 */

/** SPEC D3 band 1, verbatim: *>200 stars*. Strictly greater. */
export const STARS_CREDIBLE = 200;
/** SPEC D3 band 3: *velocity across ≥3 months*, in the weeks GitHub reports. */
export const SUSTAINED_WEEKS = 12;
/** SPEC D3 band 2: *both within 90 days*, measured on the repository's push. */
export const RECENT_PUSH_DAYS = 90;
/** SPEC D4 band 2: *a curve crossed in the last ~18 months*, in days. */
export const RECENT_PROJECT_DAYS = 548;
/** *Unsolicited community usage* (D3) — humans committing who are not the team. */
export const COMMUNITY_CONTRIBUTORS = 5;
/** *A compounding loop already visible in public artifacts* (D5). */
export const LOOP_CONTRIBUTORS = 10;

/** SPEC §3, the three thresholds of the call. */
export const MEETING_SCORE = 72;
export const WATCH_SCORE = 55;
export const COVERAGE_GATE = 0.6;

/* -------------------------------------------------------------------------- */
/* Input and output                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything the rubric is allowed to see. `evidence` is here for two reasons
 * and no others: an id must resolve to a record that is not a `fetch_failed`
 * before it can count as a primary source, and D3's bottom band needs to know
 * whether a launch post exists at all.
 */
export interface ScoreInput {
  facts: readonly Fact[];
  signals: readonly Signal[];
  evidence: readonly Evidence[];
}

export interface ScoreResult {
  dimensions: Dimension[];
  /** Arithmetic over `dimensions`, always. SPEC §4 hard rule 3. */
  score: number;
  /** Share of the five dimensions with a primary source behind them. */
  coverage: number;
  disqualifiers: Disqualifier[];
  call: Call;
  /** One line per uncovered dimension. Unknown written as unknown. */
  unknowns: string[];
}

/* -------------------------------------------------------------------------- */
/* The observation index                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The only view of the inputs a band predicate gets. Deliberately narrow: there
 * is no accessor here that returns a `statement`, which is how rule 1 stays
 * structural rather than remembered.
 */
interface Observed {
  /** Does a citable fact exist under this key? */
  fact(key: string): boolean;
  /** The signal under this key, if one was produced. Rule 2. */
  signal(key: string): Signal | null;
  /** The signal's value as a finite number, or null. */
  num(key: string): number | null;
  /** The signal's value as a non-empty string, or null. */
  text(key: string): string | null;
  /** Every primary evidence id behind these keys, deduped, in input order. */
  ids(keys: readonly string[]): string[];
  /** Whether any of these keys produced a dated signal. */
  dated(keys: readonly string[]): boolean;
  /** Whether the run holds a Hacker News thread for this candidate. */
  hn: boolean;
}

function observe(input: ScoreInput): Observed {
  // Rule 6's first half. A `fetch_failed` record is real evidence and a memo
  // may cite it as evidence of absence (ARCHITECTURE §5), but it is not a
  // primary source for a claim, so nothing behind one counts toward coverage.
  const primary = new Set(
    input.evidence.filter((record) => record.type !== "fetch_failed").map((record) => record.id),
  );

  const factIds = new Map<string, string[]>();
  for (const fact of input.facts) {
    const cited = fact.evidence_ids.filter((id) => primary.has(id));
    if (cited.length === 0) continue;
    const known = factIds.get(fact.key);
    if (known) known.push(...cited);
    else factIds.set(fact.key, [...cited]);
  }

  // First writer wins. A candidate has one repository and one site, so a
  // repeated signal key is a duplicate rather than a disagreement; if that ever
  // stops being true the rubric should be told which record to prefer, not
  // silently take the last one it happened to see.
  const signals = new Map<string, Signal>();
  for (const signal of input.signals) {
    if (!primary.has(signal.evidence_id)) continue;
    if (!signals.has(signal.key)) signals.set(signal.key, signal);
  }

  const signalOf = (key: string): Signal | null => signals.get(key) ?? null;

  return {
    fact: (key) => (factIds.get(key)?.length ?? 0) > 0,
    signal: signalOf,
    num: (key) => {
      const value = signalOf(key)?.value;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    },
    text: (key) => {
      const value = signalOf(key)?.value;
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    ids: (keys) => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        for (const id of factIds.get(key) ?? []) {
          if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        }
        const signal = signals.get(key);
        if (signal && !seen.has(signal.evidence_id)) {
          seen.add(signal.evidence_id);
          out.push(signal.evidence_id);
        }
      }
      return out;
    },
    dated: (keys) => keys.some((key) => signals.has(key)),
    hn: input.evidence.some((record) => record.type === "hn_item"),
  };
}

/* -------------------------------------------------------------------------- */
/* Shared readings                                                             */
/* -------------------------------------------------------------------------- */

/** Somebody is named with a role beside them, on a page or in the repository. */
const namedPeople = (o: Observed): boolean =>
  o.fact("founder.name_role") ||
  (o.num("site.people_named") ?? 0) > 0 ||
  o.text("github.top_contributor") !== null;

/** A prior shipped artifact at scale — SPEC D1's top band. */
const priorArtifact = (o: Observed): boolean =>
  o.fact("founder.prior_exit") || o.fact("founder.prior_artifact");

/** The company has a public repository at all. Read from the signal (rule 2). */
const hasRepo = (o: Observed): boolean => o.text("github.repo") !== null;

/** An accumulating asset — SPEC D5's third band, and half of D-2. */
const accumulatingAsset = (o: Observed): boolean =>
  o.fact("product.data_accumulated") ||
  o.fact("product.runtime_position") ||
  (o.fact("product.open_source") && (o.num("github.stars") ?? 0) > STARS_CREDIBLE);

/** The product is described by somebody — the precondition both D-1 and D-2 need. */
const productDescribed = (o: Observed): boolean =>
  o.fact("product.one_liner") || o.fact("product.category_claim");

/**
 * SPEC D3 band 1's list — *HN front page, >200 stars, a named design partner* —
 * as the subset of it this pipeline can actually observe, one entry per
 * *record* so that "two independent signals" can be counted honestly.
 *
 * **The HN front page is not in it.** Points and comment counts never reach the
 * rubric (STATE inconsistency 67): they were on the Algolia hit in stage 1, the
 * `Candidate` contract does not keep them, and the thread page is scraped as
 * prose. So a Show HN with 400 points is worth exactly what a Show HN with 4
 * points is worth here, which is a band. This is the predicted bite, recorded
 * rather than papered over with a proxy we cannot date.
 */
function credibleSignals(o: Observed): string[] {
  const records: string[] = [];
  const push = (id: string | undefined): void => {
    if (id !== undefined && !records.includes(id)) records.push(id);
  };

  if ((o.num("github.stars") ?? 0) > STARS_CREDIBLE) push(o.signal("github.stars")?.evidence_id);
  if (o.fact("traction.named_user")) push(o.ids(["traction.named_user"])[0]);
  if (o.fact("traction.integration")) push(o.ids(["traction.integration"])[0]);
  return records;
}

/* -------------------------------------------------------------------------- */
/* The five dimensions                                                         */
/* -------------------------------------------------------------------------- */

interface Band {
  /** SPEC's own range text. Printed to `Dimension.band`, so the number is traceable. */
  label: string;
  /** What meeting this band pays — its top (rule 3). */
  score: number;
  when: (o: Observed) => boolean;
}

interface DimensionSpec {
  id: string;
  name: string;
  max: number;
  /** Rule 6. Fact keys and signal keys, together — the citation and the coverage. */
  reads: readonly string[];
  /** Strongest first. The first band that holds is the one that pays. */
  bands: readonly Band[];
  /** What a dimension with no primary source pays: the floor of the second band. */
  unknown: { score: number; label: string };
}

/**
 * SPEC §2, in order and at its stated weights. Where a band's criterion is not
 * observable from what this pipeline fetches, the substitution is named in a
 * comment rather than hidden in a predicate — those are the places the rubric
 * is weakest and they should be legible to whoever validates it.
 */
export const RUBRIC: readonly DimensionSpec[] = [
  {
    id: "D1",
    name: "Founder–market fit & technical depth",
    max: 25,
    reads: [
      "founder.name_role",
      "founder.prior_role",
      "founder.prior_exit",
      "founder.prior_artifact",
      "team.size_visible",
      "org.github_account_type",
      "site.people_named",
      "github.owner_type",
      "github.top_contributor",
    ],
    bands: [
      // "Technical" is not observable as such — see gap 1. What is observable is
      // that a named person is stated to have built something before, which is
      // the evidence a partner would look for anyway.
      {
        label: "20–25",
        score: 25,
        when: (o) => namedPeople(o) && o.fact("founder.prior_role") && priorArtifact(o),
      },
      { label: "13–19", score: 19, when: (o) => namedPeople(o) && o.fact("founder.prior_role") },
      { label: "6–12", score: 12, when: namedPeople },
      { label: "0–5", score: 5, when: () => true },
    ],
    unknown: { score: 6, label: "uncovered · floor of 6–12" },
  },
  {
    id: "D2",
    name: "Wedge specificity",
    max: 20,
    reads: [
      "product.job",
      "product.one_liner",
      "product.category_claim",
      "product.capability_dependency",
      "product.runtime_position",
      "traction.named_user",
    ],
    bands: [
      {
        label: "16–20",
        score: 20,
        when: (o) => o.fact("product.job") && o.fact("traction.named_user"),
      },
      // *The incumbent is structurally unable to serve it* is a judgement no
      // page states. The nearest observation is that the job leans on something
      // an incumbent would have to rebuild around — a capability the product
      // depends on, or a position in the runtime.
      {
        label: "11–15",
        score: 15,
        when: (o) =>
          o.fact("product.job") &&
          (o.fact("product.capability_dependency") || o.fact("product.runtime_position")),
      },
      { label: "5–10", score: 10, when: (o) => o.fact("product.job") },
      { label: "0–4", score: 4, when: () => true },
    ],
    unknown: { score: 5, label: "uncovered · floor of 5–10" },
  },
  {
    id: "D3",
    name: "Evidence of pull",
    max: 25,
    reads: [
      "traction.github_stars",
      "traction.repo_activity",
      "traction.contributors",
      "traction.named_user",
      "traction.integration",
      "traction.hn_engagement",
      "github.stars",
      "github.active_weeks",
      "github.commits_last_12_weeks",
      "github.days_since_push",
      "github.human_contributors",
    ],
    bands: [
      {
        label: "20–25",
        score: 25,
        when: (o) =>
          ((o.num("github.active_weeks") ?? 0) >= SUSTAINED_WEEKS &&
            (o.num("github.commits_last_12_weeks") ?? 0) > 0) ||
          (o.num("github.human_contributors") ?? 0) >= COMMUNITY_CONTRIBUTORS ||
          // A single integration line on a company's own site is the company
          // talking about itself, so it carries the top band only alongside a
          // second, independent signal. A deliberate tightening of SPEC's "or".
          (o.fact("traction.integration") && credibleSignals(o).length >= 2),
      },
      {
        label: "13–19",
        score: 19,
        when: (o) => {
          const since = o.num("github.days_since_push");
          const recent = since === null || since <= RECENT_PUSH_DAYS;
          return credibleSignals(o).length >= 2 && recent;
        },
      },
      { label: "6–12", score: 12, when: (o) => credibleSignals(o).length >= 1 },
      // *A launch post and nothing else.* The thread is the dated artifact.
      { label: "0–5", score: 5, when: (o) => o.hn },
      // SPEC D3, verbatim: *undated claims score 0 for this dimension*. Reached
      // when the only pull evidence is prose the model wrote with no dated
      // signal underneath it and no thread behind it.
      { label: "0 · undated", score: 0, when: () => true },
    ],
    unknown: { score: 6, label: "uncovered · floor of 6–12" },
  },
  {
    id: "D4",
    name: "Why now",
    max: 15,
    reads: [
      "product.capability_dependency",
      "product.launch_date",
      "product.one_liner",
      "product.category_claim",
      "product.data_accumulated",
      "product.runtime_position",
      "github.age_days",
    ],
    bands: [
      // *Defensible against fast-followers for ≥12 months* is a forecast, and
      // this pipeline observes the past. The nearest observation is that the
      // timing thesis is attached to something that accumulates.
      {
        label: "13–15",
        score: 15,
        when: (o) => o.fact("product.capability_dependency") && accumulatingAsset(o),
      },
      { label: "9–12", score: 12, when: (o) => o.fact("product.capability_dependency") },
      {
        label: "4–8",
        score: 8,
        when: (o) =>
          o.fact("product.launch_date") ||
          (o.num("github.age_days") ?? Number.POSITIVE_INFINITY) <= RECENT_PROJECT_DAYS,
      },
      { label: "0–3", score: 3, when: () => true },
    ],
    unknown: { score: 4, label: "uncovered · floor of 4–8" },
  },
  {
    id: "D5",
    name: "Path to defensibility",
    max: 15,
    reads: [
      "product.data_accumulated",
      "product.runtime_position",
      "product.open_source",
      "product.one_liner",
      "product.job",
      "traction.integration",
      "github.stars",
      "github.human_contributors",
    ],
    bands: [
      {
        label: "13–15",
        score: 15,
        when: (o) =>
          accumulatingAsset(o) &&
          (o.fact("traction.integration") ||
            (o.num("github.human_contributors") ?? 0) >= LOOP_CONTRIBUTORS),
      },
      { label: "9–12", score: 12, when: accumulatingAsset },
      // *Execution speed or design taste only* — there is a product, and
      // nothing about it that compounds was observed.
      { label: "4–8", score: 8, when: (o) => o.fact("product.one_liner") || o.fact("product.job") },
      { label: "0–3", score: 3, when: () => true },
    ],
    unknown: { score: 4, label: "uncovered · floor of 4–8" },
  },
];

/* -------------------------------------------------------------------------- */
/* The four disqualifiers                                                      */
/* -------------------------------------------------------------------------- */

interface DisqualifierSpec {
  id: string;
  statement: string;
  when: (o: Observed) => boolean;
  /** The keys whose ids are the citation. Empty at call time means it cannot fire. */
  cite: (o: Observed) => string[];
}

/**
 * SPEC §1.1. Each of the four is an absence in prose — *nobody has shipped*,
 * *no proprietary surface*, *no self-serve path* — and an absence cannot be
 * cited. So each is written here as **the observation that makes the absence
 * damning**, plus the absence: we read the team page and it names three people
 * with no shipped artifact between them; we read the pricing page and it says
 * contact sales, with no signup, no prices and no repository beside it.
 *
 * The citation is always the positive half. When it resolves to nothing the
 * disqualifier does not fire — a candidate we have no evidence about is not a
 * candidate we pass on, it is one we say we do not know about (invariant 4).
 */
export const DISQUALIFIERS: readonly DisqualifierSpec[] = [
  {
    id: "D-1",
    statement:
      "The team is named and nothing any of them is stated to have built appears in the evidence, and the company has no public repository.",
    when: (o) =>
      namedPeople(o) &&
      !o.fact("founder.prior_role") &&
      !priorArtifact(o) &&
      !hasRepo(o) &&
      o.text("github.top_contributor") === null,
    cite: (o) => o.ids(["founder.name_role", "site.people_named"]),
  },
  {
    id: "D-2",
    statement:
      "The product is described and nothing it could own — a model, a data asset, a runtime position, a repository — appears in the evidence.",
    when: (o) =>
      productDescribed(o) &&
      !o.fact("product.runtime_position") &&
      !o.fact("product.data_accumulated") &&
      !o.fact("product.open_source") &&
      !o.fact("product.capability_dependency") &&
      !hasRepo(o),
    cite: (o) => o.ids(["product.one_liner", "product.category_claim"]),
  },
  {
    id: "D-3",
    statement:
      "The company claims a category, a platform or a scope for itself and no single job for a single user appears in the evidence.",
    when: (o) => o.fact("product.category_claim") && !o.fact("product.job"),
    cite: (o) => o.ids(["product.category_claim"]),
  },
  {
    id: "D-4",
    statement:
      "Using it is stated to require contacting someone, and no self-serve or open-source path appears in the evidence.",
    when: (o) =>
      o.fact("adoption.sales_gate") &&
      !o.fact("adoption.self_serve") &&
      !o.fact("adoption.pricing_public") &&
      !o.fact("product.open_source") &&
      o.text("site.signup_url") === null &&
      o.text("site.pricing_url") === null &&
      o.text("github.license") === null &&
      !hasRepo(o),
    cite: (o) => o.ids(["adoption.sales_gate"]),
  },
];

/* -------------------------------------------------------------------------- */
/* The call                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * SPEC §3, in four lines. Exported separately from `scoreCandidate` because the
 * coverage gate has to be testable at inputs the rubric may not be able to
 * reach on its own — see gap 2.
 *
 * The gate is the fall-through rather than a branch: a score at or above
 * `MEETING_SCORE` with coverage below `COVERAGE_GATE` fails the first test and
 * lands on Watch, which is what "capped at Watch" means. A score below
 * `WATCH_SCORE` is a Pass whatever the coverage — a cap is a ceiling, not a
 * floor.
 */
export function decideCall(
  score: number,
  coverage: number,
  disqualifiers: readonly Disqualifier[],
): Call {
  if (disqualifiers.length > 0) return "PASS";
  if (score >= MEETING_SCORE && coverage >= COVERAGE_GATE) return "TAKE_A_MEETING";
  if (score >= WATCH_SCORE) return "WATCH";
  return "PASS";
}

/* -------------------------------------------------------------------------- */
/* The rubric                                                                  */
/* -------------------------------------------------------------------------- */

/** Score one candidate. Pure: same inputs, same output, no clock, no IO. */
export function scoreCandidate(input: ScoreInput): ScoreResult {
  const o = observe(input);

  const dimensions: Dimension[] = RUBRIC.map((spec) => {
    const evidence_ids = o.ids(spec.reads);
    const covered = evidence_ids.length > 0;
    if (!covered) {
      return {
        id: spec.id,
        name: spec.name,
        score: spec.unknown.score,
        max: spec.max,
        band: spec.unknown.label,
        evidence_ids,
        covered,
      };
    }
    // The last band is total by construction, so this cannot miss. The fallback
    // is written out anyway rather than asserted, because a rubric that throws
    // costs a candidate its memo (ARCHITECTURE §5).
    const band = spec.bands.find((candidate) => candidate.when(o)) ?? {
      label: "0 · no band held",
      score: 0,
    };
    return {
      id: spec.id,
      name: spec.name,
      score: band.score,
      max: spec.max,
      band: band.label,
      evidence_ids,
      covered,
    };
  });

  const disqualifiers: Disqualifier[] = [];
  for (const spec of DISQUALIFIERS) {
    if (!spec.when(o)) continue;
    const evidence_ids = spec.cite(o);
    // Rule 4. No citation, no disqualifier — we do not pass on inference.
    if (evidence_ids.length === 0) continue;
    disqualifiers.push({ id: spec.id, statement: spec.statement, evidence_ids });
  }

  const score = dimensions.reduce((total, dimension) => total + dimension.score, 0);
  const coverage = dimensions.filter((dimension) => dimension.covered).length / dimensions.length;
  const unknowns = dimensions
    .filter((dimension) => !dimension.covered)
    .map(
      (dimension) =>
        `${dimension.id} ${dimension.name}: unknown — no primary source in this candidate's evidence, scored at ${dimension.band}`,
    );

  return {
    dimensions,
    score,
    coverage,
    disqualifiers,
    call: decideCall(score, coverage, disqualifiers),
    unknowns,
  };
}
