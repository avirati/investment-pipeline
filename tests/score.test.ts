import { describe, expect, it } from "vitest";
import { FACT_KEY_LIST } from "../src/analyse/keys.js";
import {
  COMMUNITY_CONTRIBUTORS,
  COVERAGE_GATE,
  DISQUALIFIERS,
  decideCall,
  LOOP_CONTRIBUTORS,
  MEETING_SCORE,
  RECENT_PROJECT_DAYS,
  RECENT_PUSH_DAYS,
  RUBRIC,
  type ScoreResult,
  STARS_CREDIBLE,
  SUSTAINED_WEEKS,
  scoreCandidate,
  WATCH_SCORE,
} from "../src/analyse/score.js";
import type { Evidence, EvidenceType, Fact } from "../src/contracts/index.js";
import type { Signal, SignalValue } from "../src/evidence/signal.js";

/**
 * TESTING §1. The rubric is the highest-value test target in the repo for one
 * reason: it fails quietly. A crash announces itself; an off-by-one on a band
 * edge changes a partner's call and nobody finds out.
 *
 * What these tests can and cannot do is worth being clear about. They check
 * that the rubric computes what SPEC §2–3 *says* — every band edge, both sides
 * of every threshold, disqualifier precedence, the coverage arithmetic and the
 * gate. They cannot check that the bands are *right*: there is no eval harness
 * in v1 (SCOPE) and no scored real company to compare against. A green suite
 * here means the thesis was implemented faithfully, not that the thesis works.
 */

const AT = "2026-08-22T10:00:00.000Z";

/** Evidence ids are 16 hex characters (`src/evidence/store.ts`). */
const idOf = (name: string): string => name.padEnd(16, "0").slice(0, 16);

/**
 * The record type is read off the id's first letter, so a fixture reads as one
 * line per observation rather than three: `g*` GitHub, `s*` site, `h*` the HN
 * thread, `x*` a fetch that failed and is therefore not a primary source.
 */
const typeOf = (name: string): EvidenceType => {
  if (name.startsWith("g")) return "github_repo";
  if (name.startsWith("h")) return "hn_item";
  if (name.startsWith("x")) return "fetch_failed";
  return "company_site";
};

const f = (key: string, from = "s1", confidence: Fact["confidence"] = "high"): Fact => ({
  schema_version: 1,
  key,
  statement: `something a page said about ${key}`,
  value: true,
  evidence_ids: [idOf(from)],
  confidence,
});

const s = (key: string, value: SignalValue, from = "g1"): Signal => ({
  key,
  value,
  as_of: AT,
  evidence_id: idOf(from),
});

interface Seed {
  facts?: readonly Fact[];
  signals?: readonly Signal[];
  /** Extra records with nothing cited off them — an HN thread, a dead page. */
  records?: readonly string[];
}

/**
 * Every id anything cites becomes a record, so a fixture never has to declare
 * the evidence store twice. `records` adds the ones that carry no claim.
 */
function run(seed: Seed): ScoreResult {
  const facts = seed.facts ?? [];
  const signals = seed.signals ?? [];
  const names = new Set<string>(seed.records ?? []);
  for (const fact of facts) for (const id of fact.evidence_ids) names.add(unname(id));
  for (const signal of signals) names.add(unname(signal.evidence_id));

  const evidence: Evidence[] = [...names].map((name) => ({
    schema_version: 1,
    id: idOf(name),
    url: `https://example.test/${name}`,
    type: typeOf(name),
    retrieved_at: AT,
    status: typeOf(name) === "fetch_failed" ? 404 : 200,
    title: null,
    text: "text",
    meta: {},
  }));

  return scoreCandidate({ facts, signals, evidence });
}

/** `idOf` pads; this reverses it so a cited id can be typed by its name. */
const unname = (id: string): string => id.replace(/0+$/, "");

const dim = (result: ScoreResult, id: string) => {
  const found = result.dimensions.find((dimension) => dimension.id === id);
  if (!found) throw new Error(`no dimension ${id}`);
  return found;
};

/* -------------------------------------------------------------------------- */
/* The shape of the rubric                                                     */
/* -------------------------------------------------------------------------- */

describe("the rubric's shape", () => {
  it("is SPEC §2's five dimensions at SPEC §2's weights", () => {
    expect(RUBRIC.map((spec) => [spec.id, spec.max])).toEqual([
      ["D1", 25],
      ["D2", 20],
      ["D3", 25],
      ["D4", 15],
      ["D5", 15],
    ]);
  });

  it("sums to exactly 100 when every top band holds", () => {
    expect(RUBRIC.reduce((total, spec) => total + spec.max, 0)).toBe(100);
    for (const spec of RUBRIC) expect(spec.bands[0]?.score).toBe(spec.max);
  });

  it("scores a gap above the bottom band, never at zero (invariant 4)", () => {
    for (const spec of RUBRIC) {
      const bottom = spec.bands[spec.bands.length - 1];
      expect(spec.unknown.score).toBeGreaterThan(0);
      expect(spec.unknown.score).toBeGreaterThan(bottom?.score ?? 0);
    }
  });

  it("reads only keys that exist — every fact key it names is in the vocabulary", () => {
    const vocabulary = new Set<string>(FACT_KEY_LIST);
    for (const spec of RUBRIC) {
      for (const key of spec.reads) {
        if (key.includes(".") && !key.startsWith("github.") && !key.startsWith("site.")) {
          expect(vocabulary.has(key), `${spec.id} reads ${key}`).toBe(true);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* D1 — founder–market fit                                                     */
/* -------------------------------------------------------------------------- */

describe("D1 — founder–market fit & technical depth", () => {
  const cases: [string, Seed, string, number][] = [
    ["nothing read at all", {}, "uncovered · floor of 6–12", 6],
    ["evidence exists, nobody named", { facts: [f("team.size_visible")] }, "0–5", 5],
    ["a named founder", { facts: [f("founder.name_role")] }, "6–12", 12],
    [
      "named, and named on the site rather than in a fact",
      { signals: [s("site.people_named", 3, "s1")] },
      "6–12",
      12,
    ],
    [
      "named with a prior role — direct exposure",
      { facts: [f("founder.name_role"), f("founder.prior_role")] },
      "13–19",
      19,
    ],
    [
      "exposure without anyone named stays at the floor band",
      { facts: [f("founder.prior_role")] },
      "0–5",
      5,
    ],
    [
      "exposure plus a prior exit",
      { facts: [f("founder.name_role"), f("founder.prior_role"), f("founder.prior_exit")] },
      "20–25",
      25,
    ],
    [
      "exposure plus a prior artifact — the other route to the top band",
      { facts: [f("founder.name_role"), f("founder.prior_role"), f("founder.prior_artifact")] },
      "20–25",
      25,
    ],
    [
      "a prior artifact without exposure is one band down",
      { facts: [f("founder.name_role"), f("founder.prior_artifact")] },
      "6–12",
      12,
    ],
  ];

  it.each(cases)("%s → %s", (_name, seed, band, score) => {
    expect(dim(run(seed), "D1")).toMatchObject({ band, score });
  });

  it("counts a person named only in the repository's top contributor", () => {
    expect(dim(run({ signals: [s("github.top_contributor", "ada")] }), "D1").score).toBe(12);
  });

  it("does not count a site that named zero people", () => {
    expect(dim(run({ signals: [s("site.people_named", 0, "s1")] }), "D1").score).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */
/* D2 — wedge specificity                                                      */
/* -------------------------------------------------------------------------- */

describe("D2 — wedge specificity", () => {
  const cases: [string, Seed, string, number][] = [
    ["nothing read at all", {}, "uncovered · floor of 5–10", 5],
    ["a category and no job", { facts: [f("product.category_claim")] }, "0–4", 4],
    ["one job", { facts: [f("product.job")] }, "5–10", 10],
    [
      "a job leaning on a capability",
      { facts: [f("product.job"), f("product.capability_dependency")] },
      "11–15",
      15,
    ],
    [
      "a job leaning on a runtime position",
      { facts: [f("product.job"), f("product.runtime_position")] },
      "11–15",
      15,
    ],
    [
      "a capability without a job is still the bottom band",
      { facts: [f("product.capability_dependency")] },
      "0–4",
      4,
    ],
    [
      "a job and a named user",
      { facts: [f("product.job"), f("traction.named_user")] },
      "16–20",
      20,
    ],
    ["a named user without a job", { facts: [f("traction.named_user")] }, "0–4", 4],
  ];

  it.each(cases)("%s → %s", (_name, seed, band, score) => {
    expect(dim(run(seed), "D2")).toMatchObject({ band, score });
  });
});

/* -------------------------------------------------------------------------- */
/* D3 — evidence of pull, and its edges                                        */
/* -------------------------------------------------------------------------- */

describe("D3 — evidence of pull", () => {
  const cases: [string, Seed, string, number][] = [
    ["nothing read at all", {}, "uncovered · floor of 6–12", 6],
    [
      "pull claimed in prose with no dated signal under it",
      { facts: [f("traction.repo_activity")] },
      "0 · undated",
      0,
    ],
    [
      "a launch post and nothing else",
      { facts: [f("traction.hn_engagement", "h1")], records: ["h1"] },
      "0–5",
      5,
    ],
    [
      "one credible signal — a named design partner",
      { facts: [f("traction.named_user")] },
      "6–12",
      12,
    ],
    [
      "two credible signals from one record are not independent",
      { facts: [f("traction.named_user", "s1"), f("traction.integration", "s1")] },
      "6–12",
      12,
    ],
    [
      "two credible signals from two records",
      { facts: [f("traction.named_user", "s1"), f("traction.integration", "s2")] },
      "20–25",
      25,
    ],
    [
      "stars and a named user, from two records",
      { facts: [f("traction.named_user", "s1")], signals: [s("github.stars", 900)] },
      "13–19",
      19,
    ],
  ];

  it.each(cases)("%s → %s", (_name, seed, band, score) => {
    expect(dim(run(seed), "D3")).toMatchObject({ band, score });
  });

  // SPEC D3 band 1 says ">200 stars". Strictly greater, and this is the test
  // that would catch it silently becoming ">=".
  it.each([
    [STARS_CREDIBLE - 1, 0],
    [STARS_CREDIBLE, 0],
    [STARS_CREDIBLE + 1, 1],
  ])("stars %i counts as %i credible signal(s)", (stars, expected) => {
    const result = dim(run({ signals: [s("github.stars", stars)] }), "D3");
    expect(result.score).toBe(expected === 0 ? 0 : 12);
  });

  it.each([
    [SUSTAINED_WEEKS - 1, 12],
    [SUSTAINED_WEEKS, 25],
    [SUSTAINED_WEEKS + 1, 25],
  ])("%i active weeks of commits → %i", (weeks, score) => {
    const seed: Seed = {
      signals: [
        s("github.stars", 900),
        s("github.active_weeks", weeks),
        s("github.commits_last_12_weeks", 4),
      ],
    };
    expect(dim(run(seed), "D3").score).toBe(score);
  });

  it("does not call three months of empty weeks sustained", () => {
    const seed: Seed = {
      signals: [
        s("github.stars", 900),
        s("github.active_weeks", 40),
        s("github.commits_last_12_weeks", 0),
      ],
    };
    expect(dim(run(seed), "D3").score).toBe(12);
  });

  it.each([
    [RECENT_PUSH_DAYS - 1, 19],
    [RECENT_PUSH_DAYS, 19],
    [RECENT_PUSH_DAYS + 1, 12],
  ])("last push %i days ago → %i on two independent signals", (days, score) => {
    const seed: Seed = {
      facts: [f("traction.named_user", "s1")],
      signals: [s("github.stars", 900), s("github.days_since_push", days)],
    };
    expect(dim(run(seed), "D3").score).toBe(score);
  });

  it.each([
    [COMMUNITY_CONTRIBUTORS - 1, 12],
    [COMMUNITY_CONTRIBUTORS, 25],
    [COMMUNITY_CONTRIBUTORS + 1, 25],
  ])("%i human contributors → %i", (humans, score) => {
    const seed: Seed = {
      signals: [s("github.stars", 900), s("github.human_contributors", humans)],
    };
    expect(dim(run(seed), "D3").score).toBe(score);
  });

  // Rule 2, and STATE inconsistency 58's answer. The model's sentence about a
  // star count is a citation, not a number.
  it("reads the star count off the signal, never off the fact", () => {
    const claimed = run({
      facts: [f("traction.github_stars", "g1")],
      signals: [s("github.stars", 4)],
    });
    expect(dim(claimed, "D3").score).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* D4 — why now                                                                */
/* -------------------------------------------------------------------------- */

describe("D4 — why now", () => {
  const cases: [string, Seed, string, number][] = [
    ["nothing read at all", {}, "uncovered · floor of 4–8", 4],
    ["a product described and nothing dated", { facts: [f("product.one_liner")] }, "0–3", 3],
    ["a launch date", { facts: [f("product.launch_date")] }, "4–8", 8],
    [
      "a capability the product depends on",
      { facts: [f("product.capability_dependency")] },
      "9–12",
      12,
    ],
    [
      "a capability plus something that accumulates",
      { facts: [f("product.capability_dependency"), f("product.data_accumulated")] },
      "13–15",
      15,
    ],
    [
      "a capability plus a runtime position",
      { facts: [f("product.capability_dependency"), f("product.runtime_position")] },
      "13–15",
      15,
    ],
  ];

  it.each(cases)("%s → %s", (_name, seed, band, score) => {
    expect(dim(run(seed), "D4")).toMatchObject({ band, score });
  });

  it.each([
    [RECENT_PROJECT_DAYS - 1, 8],
    [RECENT_PROJECT_DAYS, 8],
    [RECENT_PROJECT_DAYS + 1, 3],
  ])("a repository %i days old → %i", (days, score) => {
    expect(dim(run({ signals: [s("github.age_days", days)] }), "D4").score).toBe(score);
  });
});

/* -------------------------------------------------------------------------- */
/* D5 — path to defensibility                                                  */
/* -------------------------------------------------------------------------- */

describe("D5 — path to defensibility", () => {
  const cases: [string, Seed, string, number][] = [
    ["nothing read at all", {}, "uncovered · floor of 4–8", 4],
    [
      "a repository and nothing said about the product",
      { signals: [s("github.stars", 4)] },
      "0–3",
      3,
    ],
    ["a product and nothing that compounds", { facts: [f("product.one_liner")] }, "4–8", 8],
    ["an accumulating data asset", { facts: [f("product.data_accumulated")] }, "9–12", 12],
    ["a runtime position", { facts: [f("product.runtime_position")] }, "9–12", 12],
    [
      "an asset and a third-party integration on top",
      { facts: [f("product.runtime_position"), f("traction.integration")] },
      "13–15",
      15,
    ],
  ];

  it.each(cases)("%s → %s", (_name, seed, band, score) => {
    expect(dim(run(seed), "D5")).toMatchObject({ band, score });
  });

  it.each([
    [STARS_CREDIBLE, 8],
    [STARS_CREDIBLE + 1, 12],
  ])("open source with %i stars → %i", (stars, score) => {
    const seed: Seed = {
      facts: [f("product.one_liner"), f("product.open_source")],
      signals: [s("github.stars", stars)],
    };
    expect(dim(run(seed), "D5").score).toBe(score);
  });

  it.each([
    [LOOP_CONTRIBUTORS - 1, 12],
    [LOOP_CONTRIBUTORS, 15],
    [LOOP_CONTRIBUTORS + 1, 15],
  ])("%i human contributors on an asset → %i", (humans, score) => {
    const seed: Seed = {
      facts: [f("product.runtime_position")],
      signals: [s("github.human_contributors", humans)],
    };
    expect(dim(run(seed), "D5").score).toBe(score);
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

describe("coverage", () => {
  it("is zero, and every dimension sits above zero, when nothing was read", () => {
    const result = run({});
    expect(result.coverage).toBe(0);
    expect(result.dimensions.every((dimension) => !dimension.covered)).toBe(true);
    expect(result.dimensions.every((dimension) => dimension.score > 0)).toBe(true);
    expect(result.score).toBe(6 + 5 + 6 + 4 + 4);
    expect(result.call).toBe("PASS");
  });

  // `product.job` is declared by D2 and by D5, so one fact covers two
  // dimensions. That is rule 6 working: a dimension is covered by the keys it
  // reads, not by the key's group name.
  it("writes one unknown per uncovered dimension, naming the floor it took", () => {
    const result = run({ facts: [f("product.job")] });
    expect(result.unknowns.map((line) => line.slice(0, 2))).toEqual(["D1", "D3", "D4"]);
    for (const line of result.unknowns) expect(line).toContain("unknown");
  });

  it("counts a dimension as covered only through the keys it declares", () => {
    // `founder.name_role` is D1's alone. Four dimensions stay uncovered.
    const result = run({ facts: [f("founder.name_role")] });
    expect(dim(result, "D1").covered).toBe(true);
    expect(result.coverage).toBe(0.2);
  });

  it("does not count a fetch that failed as a primary source", () => {
    const result = run({ facts: [f("founder.name_role", "x1")] });
    expect(dim(result, "D1")).toMatchObject({ covered: false, score: 6, evidence_ids: [] });
    expect(result.coverage).toBe(0);
  });

  it("carries the ids the number was read off, so it is recomputable by hand", () => {
    const result = run({
      facts: [f("founder.name_role", "s1"), f("founder.prior_role", "s2")],
    });
    expect(dim(result, "D1").evidence_ids).toEqual([idOf("s1"), idOf("s2")]);
  });
});

/* -------------------------------------------------------------------------- */
/* The call                                                                    */
/* -------------------------------------------------------------------------- */

describe("the call", () => {
  it.each([
    [MEETING_SCORE, 1, "TAKE_A_MEETING"],
    [MEETING_SCORE - 1, 1, "WATCH"],
    [WATCH_SCORE, 1, "WATCH"],
    [WATCH_SCORE - 1, 1, "PASS"],
    [100, COVERAGE_GATE, "TAKE_A_MEETING"],
  ])("score %i at coverage %f → %s", (score, coverage, call) => {
    expect(decideCall(score, coverage, [])).toBe(call);
  });

  // TESTING §1's coverage gate: score ≥ 72 with coverage 40% caps at Watch.
  it.each([0.4, 0.2, 0])("caps a %f-coverage candidate at WATCH however high it scores", (c) => {
    expect(decideCall(100, c, [])).toBe("WATCH");
  });

  it("caps and does not floor — a thin candidate scoring under 55 is still a PASS", () => {
    expect(decideCall(WATCH_SCORE - 1, 0.2, [])).toBe("PASS");
  });

  it("puts a disqualifier ahead of everything", () => {
    const disqualifier = { id: "D-2", statement: "…", evidence_ids: [idOf("s1")] };
    expect(decideCall(100, 1, [disqualifier])).toBe("PASS");
  });
});

/* -------------------------------------------------------------------------- */
/* Disqualifiers                                                               */
/* -------------------------------------------------------------------------- */

/** A company that scores 100 and trips nothing. Each case below breaks one part. */
const strong: Seed = {
  facts: [
    f("founder.name_role"),
    f("founder.prior_role"),
    f("founder.prior_exit"),
    f("product.one_liner"),
    f("product.job"),
    f("product.capability_dependency"),
    f("product.runtime_position"),
    f("traction.named_user", "s1"),
    f("traction.integration", "s2"),
  ],
  signals: [
    s("github.repo", "acme/acme"),
    s("github.stars", 900),
    s("github.active_weeks", 20),
    s("github.commits_last_12_weeks", 40),
    s("github.days_since_push", 2),
    s("github.human_contributors", 12),
  ],
};

/** `strong` with some facts removed and others added. */
const variant = (drop: readonly string[], add: readonly Fact[], keepSignals: boolean): Seed => ({
  facts: [...(strong.facts ?? []).filter((fact) => !drop.includes(fact.key)), ...add],
  signals: keepSignals ? (strong.signals ?? []) : [],
});

describe("disqualifiers", () => {
  it("the baseline scores 100 and takes a meeting", () => {
    const result = run(strong);
    expect(result.score).toBe(100);
    expect(result.coverage).toBe(1);
    expect(result.disqualifiers).toEqual([]);
    expect(result.call).toBe("TAKE_A_MEETING");
  });

  const cases: [string, Seed][] = [
    ["D-1", variant(["founder.prior_role", "founder.prior_exit"], [], false)],
    [
      "D-2",
      variant(
        ["product.capability_dependency", "product.runtime_position"],
        [f("product.launch_date")],
        false,
      ),
    ],
    ["D-3", variant(["product.job"], [f("product.category_claim")], true)],
    ["D-4", variant([], [f("adoption.sales_gate")], false)],
  ];

  // SPEC §1.1: precedence over score is absolute. Each case still scores well
  // clear of the meeting threshold, so the PASS is the disqualifier's doing and
  // not the score quietly falling.
  it.each(cases)("%s alone forces PASS from a score that would take a meeting", (id, seed) => {
    const result = run(seed);
    expect(result.score).toBeGreaterThanOrEqual(MEETING_SCORE);
    expect(result.disqualifiers.map((entry) => entry.id)).toEqual([id]);
    expect(result.call).toBe("PASS");
  });

  it.each(cases)("%s cites the observation it fired on", (_id, seed) => {
    for (const entry of run(seed).disqualifiers) {
      expect(entry.evidence_ids.length).toBeGreaterThan(0);
      expect(entry.statement.length).toBeGreaterThan(0);
    }
  });

  it("fires none of the four on a candidate nothing is known about", () => {
    expect(run({}).disqualifiers).toEqual([]);
  });

  // Rule 4. Absence is not a disqualifier; the citation is what separates the
  // two, and a fact citing only a dead fetch has none.
  it("does not fire on an observation whose only citation is a failed fetch", () => {
    const result = run({ facts: [f("product.category_claim", "x1")] });
    expect(result.disqualifiers).toEqual([]);
  });

  it("has one spec per SPEC §1.1 disqualifier", () => {
    expect(DISQUALIFIERS.map((spec) => spec.id)).toEqual(["D-1", "D-2", "D-3", "D-4"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Properties                                                                  */
/* -------------------------------------------------------------------------- */

/** Deterministic, so a failure is reproducible without a recorded seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const SIGNAL_KEYS: [string, SignalValue][] = [
  ["github.repo", "acme/acme"],
  ["github.stars", 900],
  ["github.active_weeks", 20],
  ["github.commits_last_12_weeks", 4],
  ["github.days_since_push", 3],
  ["github.human_contributors", 11],
  ["github.age_days", 200],
  ["github.top_contributor", "ada"],
  ["github.license", "MIT"],
  ["site.people_named", 2],
  ["site.signup_url", "https://example.test/signup"],
  ["site.pricing_url", "https://example.test/pricing"],
];

function* generated(): Generator<ScoreResult> {
  const random = lcg(20260822);
  for (let round = 0; round < 400; round += 1) {
    const facts = FACT_KEY_LIST.filter(() => random() < 0.35).map((key) =>
      f(key, random() < 0.5 ? "s1" : "s2", random() < 0.2 ? "low" : "high"),
    );
    const signals = SIGNAL_KEYS.filter(() => random() < 0.35).map(([key, value]) =>
      s(key, value, random() < 0.5 ? "g1" : "g2"),
    );
    yield run({ facts, signals, records: random() < 0.5 ? ["h1"] : [] });
  }
}

describe("properties, over 400 generated fact sets", () => {
  it("total is the sum of its parts, and never leaves 0–100", () => {
    for (const result of generated()) {
      const sum = result.dimensions.reduce((total, dimension) => total + dimension.score, 0);
      expect(result.score).toBe(sum);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result.score)).toBe(true);
    }
  });

  it("keeps every dimension inside its own weight, and always emits five", () => {
    for (const result of generated()) {
      expect(result.dimensions).toHaveLength(5);
      for (const dimension of result.dimensions) {
        expect(dimension.score).toBeGreaterThanOrEqual(0);
        expect(dimension.score).toBeLessThanOrEqual(dimension.max);
        expect(dimension.band.length).toBeGreaterThan(0);
      }
    }
  });

  it("agrees with its own coverage arithmetic and its own unknowns", () => {
    for (const result of generated()) {
      const covered = result.dimensions.filter((dimension) => dimension.covered);
      expect(result.coverage).toBeCloseTo(covered.length / 5, 10);
      expect(result.unknowns).toHaveLength(5 - covered.length);
      for (const dimension of result.dimensions) {
        expect(dimension.covered).toBe(dimension.evidence_ids.length > 0);
      }
    }
  });

  it("never reaches TAKE_A_MEETING under the coverage gate", () => {
    for (const result of generated()) {
      if (result.call === "TAKE_A_MEETING") expect(result.coverage).toBeGreaterThanOrEqual(0.6);
    }
  });

  /**
   * Gap 2 in `score.ts`. Coverage below 60% means at most two of five
   * dimensions carry evidence, and two dimensions cannot reach 72 points with
   * the other three at their unknown floors. The gate is therefore correct,
   * exercised by `decideCall` above, and unreachable through `scoreCandidate`.
   * If this ever fails, the gate has become live and the note should go.
   */
  it("cannot in fact reach the gate — no generated case scores 72 under 60% coverage", () => {
    for (const result of generated()) {
      if (result.coverage < COVERAGE_GATE) expect(result.score).toBeLessThan(MEETING_SCORE);
    }
  });

  // Rule 5, and STATE inconsistency 78's answer: the model's own confidence is
  // the model's judgement, and it does not reach the score.
  it("scores a low-confidence fact set exactly as it scores a high-confidence one", () => {
    const keys = ["founder.name_role", "founder.prior_role", "product.job", "traction.named_user"];
    const high = run({ facts: keys.map((key) => f(key, "s1", "high")) });
    const low = run({ facts: keys.map((key) => f(key, "s1", "low")) });
    expect(low).toEqual(high);
  });

  // Rule 1. The statement is a sentence for a partner, not an input.
  it("ignores the prose entirely — rewriting every statement changes nothing", () => {
    const keys = ["founder.name_role", "product.job", "product.runtime_position"];
    const plain = run({ facts: keys.map((key) => f(key, "s1")) });
    const shouty = run({
      facts: keys.map((key) => ({
        ...f(key, "s1"),
        statement: "AN EXCEPTIONAL, WORLD-CLASS TEAM",
      })),
    });
    expect(shouty).toEqual(plain);
  });
});
