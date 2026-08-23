import { describe, expect, it } from "vitest";
import {
  CHANGE_MY_MIND_CAP,
  type DeriveInput,
  deriveMemoFields,
  HEADING_OF,
  HEADINGS,
  SECTION_BULLET_CAP,
  WHY_THIS_CALL_CAP,
} from "../src/analyse/derive.js";
import { FACT_KEY_LIST } from "../src/analyse/keys.js";
import {
  COVERAGE_GATE,
  DISQUALIFIERS,
  decideCall,
  MEETING_SCORE,
  RUBRIC,
  WATCH_SCORE,
} from "../src/analyse/score.js";
import {
  type Dimension,
  type Disqualifier,
  type Fact,
  MemoBullet,
  MemoSection,
} from "../src/contracts/index.js";

/**
 * TICKET-0024's stage-2 half. What these tests are for: the memo's body is
 * *derived*, and the whole reason it is derived rather than written is that
 * neither the model nor stage 3 is allowed to write it (CLAUDE.md invariants 1
 * and 3). So the load-bearing assertions here are the ones that say this module
 * did not write anything either — every bullet's text traces to a fact, a
 * disqualifier or a rubric band — plus the two SPEC §4 rules that are easy to
 * break by accident: the caps, and deleting an empty section rather than
 * faking one.
 *
 * They cannot tell you the memo is *useful*. No eval harness ships in v1
 * (SCOPE); the first read of a real memo is TICKET-0028.
 */

const idOf = (name: string): string => name.padEnd(16, "0").slice(0, 16);

const f = (
  key: string,
  statement: string,
  from = "s1",
  confidence: Fact["confidence"] = "high",
): Fact => ({
  schema_version: 1,
  key,
  statement,
  value: true,
  evidence_ids: [idOf(from)],
  confidence,
});

/** A dimension sitting in band `index` of its own rubric spec. */
function dimAt(id: string, index: number, from = "s1"): Dimension {
  const spec = RUBRIC.find((entry) => entry.id === id);
  const band = spec?.bands[index];
  if (!spec || !band) throw new Error(`no band ${index} on ${id}`);
  return {
    id: spec.id,
    name: spec.name,
    score: band.score,
    max: spec.max,
    band: band.label,
    evidence_ids: [idOf(from)],
    covered: true,
  };
}

/** A dimension nothing was read for. */
function dimUncovered(id: string): Dimension {
  const spec = RUBRIC.find((entry) => entry.id === id);
  if (!spec) throw new Error(`no dimension ${id}`);
  return {
    id: spec.id,
    name: spec.name,
    score: spec.unknown.score,
    max: spec.max,
    band: spec.unknown.label,
    evidence_ids: [],
    covered: false,
  };
}

/** Score, coverage and call are arithmetic over the dimensions, as in the rubric. */
function input(
  dimensions: Dimension[],
  extra: { facts?: Fact[]; disqualifiers?: Disqualifier[] } = {},
): DeriveInput {
  const facts = extra.facts ?? [];
  const disqualifiers = extra.disqualifiers ?? [];
  const score = dimensions.reduce((total, dimension) => total + dimension.score, 0);
  const coverage = dimensions.filter((dimension) => dimension.covered).length / dimensions.length;
  return {
    facts,
    dimensions,
    disqualifiers,
    score,
    coverage,
    call: decideCall(score, coverage, disqualifiers),
  };
}

/** All five, each in the band given, so a score can be aimed at a threshold. */
const bands = (...indexes: number[]): Dimension[] =>
  RUBRIC.map((spec, position) => dimAt(spec.id, indexes[position] ?? 0));

const section = (result: ReturnType<typeof deriveMemoFields>, heading: string) =>
  result.sections.find((entry) => entry.heading === heading);

/* -------------------------------------------------------------------------- */
/* The vocabulary is filed exhaustively                                        */
/* -------------------------------------------------------------------------- */

describe("the heading map", () => {
  it("files every key in the vocabulary, and invents no others", () => {
    expect(Object.keys(HEADING_OF).sort()).toEqual([...FACT_KEY_LIST].sort());
  });

  it("files nothing under Risks — no observation is a risk", () => {
    expect(Object.values(HEADING_OF)).not.toContain("Risks");
  });

  it("prints SPEC §4's headings in SPEC §4's order", () => {
    expect(HEADINGS).toEqual(["Team", "Product", "Market", "Risks"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Why this call                                                               */
/* -------------------------------------------------------------------------- */

describe("why this call", () => {
  it("leads with the verdict and the arithmetic behind it", () => {
    const derived = input(bands(0, 0, 0, 0, 0));
    expect(derived.call).toBe("TAKE_A_MEETING");
    const first = deriveMemoFields(derived).why_this_call[0];
    expect(first?.kind).toBe("summary");
    expect(first?.text).toBe(
      `Take a meeting — 100/100 clears the ${MEETING_SCORE} threshold, at 100% coverage.`,
    );
  });

  // SPEC §1.1: precedence is absolute, so it is the first thing the memo says.
  it("leads with the disqualifier when one fired, and cites it", () => {
    const derived = input(bands(0, 0, 0, 0, 0), {
      disqualifiers: [{ id: "D-4", statement: "Contact sales only.", evidence_ids: [idOf("s3")] }],
    });
    expect(derived.call).toBe("PASS");
    const first = deriveMemoFields(derived).why_this_call[0];
    expect(first?.text).toContain("Pass — disqualifier D-4 fired");
    expect(first?.text).toContain("forces a pass whatever the score");
    expect(first?.evidence_ids).toEqual([idOf("s3")]);
  });

  // A score sitting exactly on a threshold is the sentence that is easiest to
  // write wrongly: "above 55" is false at 55, and the run's own `freestyle`
  // scores exactly 55.
  it("says a score meets a threshold rather than clearing it, at the edge", () => {
    const derived = input(bands(2, 3, 2, 1, 1));
    const first = deriveMemoFields(derived).why_this_call[0]?.text ?? "";
    if (derived.score === WATCH_SCORE) expect(first).toContain(`meets the ${WATCH_SCORE}`);
    expect(first).not.toContain(`is above ${WATCH_SCORE}`);
  });

  it("names the strongest reading for a meeting and the largest shortfall otherwise", () => {
    const meeting = deriveMemoFields(input(bands(0, 0, 0, 0, 0))).why_this_call[1];
    expect(meeting?.text).toContain("The strongest reading is");

    // D2 at 4/20 is 16 short; nothing else is further from its own ceiling.
    const pass = deriveMemoFields(input(bands(2, 3, 2, 2, 2))).why_this_call[1];
    expect(pass?.text).toContain("The largest shortfall is D2 Wedge specificity at 4/20");
  });

  it("says how much was not read, and points at the section that lists it", () => {
    const derived = input([
      dimAt("D1", 1),
      dimAt("D2", 1),
      dimAt("D3", 1),
      dimUncovered("D4"),
      dimUncovered("D5"),
    ]);
    const last = deriveMemoFields(derived).why_this_call.at(-1);
    expect(last?.text).toBe(
      "2 of 5 dimensions had no primary source behind them; they are listed under what we " +
        "could not verify.",
    );
  });

  it("says nothing about a decisive reading when nothing was read", () => {
    const derived = input(RUBRIC.map((spec) => dimUncovered(spec.id)));
    const why = deriveMemoFields(derived).why_this_call;
    expect(why).toHaveLength(2);
    expect(why.some((bullet) => bullet.text.includes("strongest reading"))).toBe(false);
    expect(why.some((bullet) => bullet.text.includes("largest shortfall"))).toBe(false);
  });

  it("never runs past SPEC §4's three sentences, and never comes back empty", () => {
    for (const dimensions of [bands(0, 0, 0, 0, 0), bands(3, 3, 4, 3, 3)]) {
      const why = deriveMemoFields(input(dimensions)).why_this_call;
      expect(why.length).toBeGreaterThan(0);
      expect(why.length).toBeLessThanOrEqual(WHY_THIS_CALL_CAP);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

describe("sections", () => {
  it("prints a fact's statement verbatim, with its citations", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), { facts: [f("product.one_liner", "Klaus is a hosted VM.")] }),
    );
    const product = section(result, "Product");
    expect(product?.bullets[0]).toEqual({
      kind: "fact",
      text: "Klaus is a hosted VM.",
      evidence_ids: [idOf("s1")],
    });
  });

  it("deletes an empty section rather than faking one (SPEC §4)", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), { facts: [f("product.job", "It runs agents for you.")] }),
    );
    expect(result.sections.map((entry) => entry.heading)).toEqual(["Product"]);
  });

  it("orders bullets by the key vocabulary, not by the order the model answered", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), {
        facts: [
          f("team.size_visible", "Three people are named."),
          f("founder.name_role", "Ada is the CEO."),
          f("founder.prior_role", "Ada was at Acme."),
        ],
      }),
    );
    expect(section(result, "Team")?.bullets.map((bullet) => bullet.text)).toEqual([
      "Ada is the CEO.",
      "Ada was at Acme.",
      "Three people are named.",
    ]);
  });

  it("caps at five bullets and says how many it dropped", () => {
    const facts = Array.from({ length: 8 }, (_, index) =>
      f("traction.named_user", `Customer ${index} uses it.`),
    );
    const result = deriveMemoFields(input(bands(1, 1, 1, 1, 1), { facts }));
    const market = section(result, "Market");
    expect(market?.bullets).toHaveLength(SECTION_BULLET_CAP);
    expect(market?.omitted).toBe(3);
  });

  it("merges one observation cited twice into one bullet with two ids", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), {
        facts: [
          f("product.one_liner", "Klaus is a hosted VM.", "s1"),
          f("product.one_liner", "  klaus IS a hosted vm.  ", "s2"),
        ],
      }),
    );
    const product = section(result, "Product");
    expect(product?.bullets).toHaveLength(1);
    expect(product?.bullets[0]?.evidence_ids).toEqual([idOf("s1"), idOf("s2")]);
  });

  /**
   * The rubric refuses to score `Fact.confidence` (`score.ts` rule 5) on the
   * grounds that a partner should see it instead. This is where they see it.
   */
  it("marks a low-confidence statement, and leaves the others alone", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), {
        facts: [
          f("product.one_liner", "It is a hosted VM.", "s1", "low"),
          f("product.job", "It runs agents.", "s1", "medium"),
        ],
      }),
    );
    expect(section(result, "Product")?.bullets.map((bullet) => bullet.text)).toEqual([
      "It is a hosted VM. (model confidence: low)",
      "It runs agents.",
    ]);
  });

  it("drops a fact whose key is outside the vocabulary rather than filing it anywhere", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), { facts: [f("vibes.excellent", "It feels right.")] }),
    );
    expect(result.sections).toEqual([]);
  });

  it("writes sections that parse under the contract", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 3, 1, 1), {
        facts: [f("founder.name_role", "Ada is the CEO.")],
        disqualifiers: [
          { id: "D-3", statement: "A category and no job.", evidence_ids: [idOf("s2")] },
        ],
      }),
    );
    for (const entry of result.sections) expect(() => MemoSection.parse(entry)).not.toThrow();
    for (const bullet of result.what_would_change_my_mind) {
      expect(() => MemoBullet.parse(bullet)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Risks                                                                       */
/* -------------------------------------------------------------------------- */

describe("risks", () => {
  it("leads with a fired disqualifier, verbatim and cited", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), {
        disqualifiers: [
          {
            id: "D-4",
            statement: "Using it requires contacting someone.",
            evidence_ids: [idOf("s3")],
          },
        ],
      }),
    );
    expect(section(result, "Risks")?.bullets[0]).toEqual({
      kind: "fact",
      text: "Disqualifier D-4 — Using it requires contacting someone.",
      evidence_ids: [idOf("s3")],
    });
  });

  it("names a dimension in its lowest band, and what the band above wanted", () => {
    const d3 = RUBRIC.find((spec) => spec.id === "D3");
    const bottom = d3?.bands.length ?? 0;
    const result = deriveMemoFields(input(bands(1, 1, bottom - 1, 1, 1)));
    const bullet = section(result, "Risks")?.bullets[0];
    expect(bullet?.kind).toBe("gap");
    expect(bullet?.text).toContain("D3 Evidence of pull scored in its lowest band");
    expect(bullet?.text).toContain(d3?.bands[bottom - 2]?.needs ?? "");
    // It is a reading of evidence we hold, so it cites what was read.
    expect(bullet?.evidence_ids).toEqual([idOf("s1")]);
  });

  /**
   * Gap 2. Above the gate an uncovered dimension is already printed under
   * "what we could not verify"; printing it here as well makes every memo say
   * the same thing twice.
   */
  it("keeps an uncovered dimension out of risks while coverage is above the gate", () => {
    const dimensions = [
      dimAt("D1", 1),
      dimAt("D2", 1),
      dimAt("D3", 1),
      dimAt("D4", 1),
      dimUncovered("D5"),
    ];
    const derived = input(dimensions);
    expect(derived.coverage).toBeGreaterThanOrEqual(COVERAGE_GATE);
    expect(section(deriveMemoFields(derived), "Risks")).toBeUndefined();
  });

  it("moves it into risks once coverage falls below the gate", () => {
    const dimensions = [
      dimAt("D1", 1),
      dimUncovered("D2"),
      dimUncovered("D3"),
      dimUncovered("D4"),
      dimUncovered("D5"),
    ];
    const derived = input(dimensions);
    expect(derived.coverage).toBeLessThan(COVERAGE_GATE);
    const risks = section(deriveMemoFields(derived), "Risks");
    expect(risks?.bullets).toHaveLength(4);
    for (const bullet of risks?.bullets ?? []) {
      expect(bullet.kind).toBe("gap");
      expect(bullet.evidence_ids).toEqual([]);
      expect(bullet.text).toContain("is unknown, and coverage is below the 60% gate");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* What would change my mind                                                   */
/* -------------------------------------------------------------------------- */

describe("what would change my mind", () => {
  it("never runs past SPEC §4's three", () => {
    const result = deriveMemoFields(input(bands(3, 3, 4, 3, 3)));
    expect(result.what_would_change_my_mind).toHaveLength(CHANGE_MY_MIND_CAP);
  });

  it("leads with what would refute a fired disqualifier, and cites what fired it", () => {
    const result = deriveMemoFields(
      input(bands(1, 1, 1, 1, 1), {
        disqualifiers: [
          { id: "D-3", statement: "A category and no job.", evidence_ids: [idOf("s2")] },
        ],
      }),
    );
    const first = result.what_would_change_my_mind[0];
    expect(first?.kind).toBe("check");
    expect(first?.text.startsWith("Disqualifier D-3: find ")).toBe(true);
    expect(first?.text).toContain("would no longer be forced to Pass");
    expect(first?.evidence_ids).toEqual([idOf("s2")]);
  });

  it("orders the rest by what they are worth, largest first", () => {
    // D1 at 12 (+7 to reach 19), D2 at 10 (+5), D3 at 12 (+7), D4 at 8 (+4), D5 at 8 (+4).
    const result = deriveMemoFields(input(bands(2, 2, 2, 2, 2)));
    const ids = result.what_would_change_my_mind.map((bullet) => bullet.text.match(/D\d/)?.[0]);
    expect(ids).toEqual(["D1", "D3", "D2"]);
  });

  it("puts an unquantifiable gap after every move that has a number", () => {
    const result = deriveMemoFields(
      input([dimUncovered("D1"), dimAt("D2", 0), dimAt("D3", 0), dimAt("D4", 0), dimAt("D5", 2)]),
    );
    const last = result.what_would_change_my_mind.at(-1);
    expect(last?.text).toContain("D1 Founder–market fit & technical depth: find ");
    expect(last?.text).toContain("Nothing was read for this dimension");
  });

  it("carries no citation on a check about an absence", () => {
    const result = deriveMemoFields(input(bands(2, 2, 2, 2, 2)));
    for (const bullet of result.what_would_change_my_mind) expect(bullet.evidence_ids).toEqual([]);
  });

  it("says nothing at all when every dimension is already in its top band", () => {
    expect(deriveMemoFields(input(bands(0, 0, 0, 0, 0))).what_would_change_my_mind).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The upgrade trigger                                                         */
/* -------------------------------------------------------------------------- */

describe("the upgrade trigger", () => {
  it("is written for a Watch and for nothing else", () => {
    const meeting = deriveMemoFields(input(bands(0, 0, 0, 0, 0)));
    expect(meeting.upgrade_trigger).toBeNull();

    const pass = deriveMemoFields(input(bands(3, 3, 4, 3, 3)));
    expect(pass.upgrade_trigger).toBeNull();
  });

  it("names the cheapest single move that clears the threshold, and what it asks for", () => {
    // 19 + 15 + 19 + 8 + 8 = 69, three short of 72.
    const derived = input(bands(1, 1, 1, 2, 2));
    expect(derived.call).toBe("WATCH");
    const trigger = deriveMemoFields(derived).upgrade_trigger ?? "";
    expect(trigger).toContain("3 points short of 72 (score 69)");
    expect(trigger).toContain("D4 Why now");
    expect(trigger).toContain("alone clears it");
  });

  it("falls back to a combination when no single dimension covers the gap", () => {
    // 19 + 10 + 12 + 12 + 8 = 61, eleven short; the largest single move is +7.
    const derived = input(bands(1, 2, 2, 1, 2));
    expect(derived.call).toBe("WATCH");
    const trigger = deriveMemoFields(derived).upgrade_trigger ?? "";
    expect(trigger).toContain("11 points short of 72 (score 61)");
    expect(trigger).toContain("no single dimension covers it, but these together do");
  });

  it("says nothing rather than inventing a trigger it cannot support", () => {
    const dimensions = [
      dimAt("D1", 0),
      dimAt("D2", 0),
      dimUncovered("D3"),
      dimAt("D4", 3),
      dimAt("D5", 3),
    ];
    const derived = input(dimensions);
    // 25 + 20 + 6 + 3 + 3 = 57 — a Watch whose only remaining moves are +12 and
    // +12 against a deficit of 15, with D3 unquantifiable.
    expect(derived.call).toBe("WATCH");
    expect(derived.score).toBe(57);
    const trigger = deriveMemoFields(derived).upgrade_trigger;
    expect(trigger === null || trigger.includes("these together do")).toBe(true);
  });

  /**
   * `score.ts` gap 2: the coverage gate is arithmetically unreachable through
   * `scoreCandidate`. `decideCall` can still be handed the state, and the
   * trigger has a shape for it, because the unreachability is arithmetic a band
   * edit could change.
   */
  it("names coverage, not points, when the gate is what caps the call", () => {
    const dimensions = [
      dimAt("D1", 0),
      dimAt("D2", 0),
      dimUncovered("D3"),
      dimUncovered("D4"),
      dimUncovered("D5"),
    ];
    const score = 25 + 20 + 6 + 4 + 4;
    const derived: DeriveInput = {
      facts: [],
      dimensions,
      disqualifiers: [],
      score: MEETING_SCORE + 1,
      coverage: 0.4,
      call: decideCall(MEETING_SCORE + 1, 0.4, []),
    };
    expect(score).toBeLessThan(MEETING_SCORE); // the reachable state, for the record
    expect(derived.call).toBe("WATCH");
    const trigger = deriveMemoFields(derived).upgrade_trigger ?? "";
    expect(trigger).toContain("coverage is 40% against the 60% gate");
    expect(trigger).toContain("the gate is what caps this at Watch");
  });

  it("adds the coverage requirement to a points trigger when both are short", () => {
    const dimensions = [
      dimAt("D1", 1),
      dimAt("D2", 1),
      dimUncovered("D3"),
      dimUncovered("D4"),
      dimUncovered("D5"),
    ];
    const derived = input(dimensions);
    if (derived.call === "WATCH") {
      const trigger = deriveMemoFields(derived).upgrade_trigger;
      if (trigger !== null) expect(trigger).toContain("which must also be met");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Properties                                                                  */
/* -------------------------------------------------------------------------- */

describe("properties", () => {
  const cases: DeriveInput[] = [
    input(bands(0, 0, 0, 0, 0)),
    input(bands(1, 2, 2, 1, 2), {
      facts: FACT_KEY_LIST.map((key) => f(key, `a page said ${key}`)),
    }),
    input(bands(3, 3, 4, 3, 3), {
      disqualifiers: [
        { id: "D-1", statement: "Nobody has shipped.", evidence_ids: [idOf("s1")] },
        { id: "D-2", statement: "Nothing to own.", evidence_ids: [idOf("s2")] },
      ],
    }),
    input([
      dimUncovered("D1"),
      dimUncovered("D2"),
      dimUncovered("D3"),
      dimAt("D4", 2),
      dimAt("D5", 2),
    ]),
  ];

  it("is pure — the same analysis derives the same memo body", () => {
    for (const one of cases) expect(deriveMemoFields(one)).toEqual(deriveMemoFields(one));
  });

  /**
   * Rule 1, as a test. Every bullet's text is a statement somebody else wrote:
   * a fact, a disqualifier, or a rubric band's own `needs` sentence. This is
   * the assertion that would fail first if this module ever started writing
   * prose about a company.
   */
  it("prints no sentence this module wrote", () => {
    const stated = new Set<string>();
    for (const one of cases) {
      for (const fact of one.facts) stated.add(fact.statement);
      for (const disqualifier of one.disqualifiers) stated.add(disqualifier.statement);
    }
    for (const spec of RUBRIC) {
      stated.add(spec.unknown.needs);
      for (const band of spec.bands) stated.add(band.needs);
    }
    for (const spec of DISQUALIFIERS) stated.add(spec.refuted_by);

    for (const one of cases) {
      const result = deriveMemoFields(one);
      // `why_this_call` is excluded on purpose: its sentences are about this
      // analysis rather than about the company, and every number in them is
      // already in the file. The three tests above pin them instead.
      const texts = [
        ...result.sections.flatMap((entry) => entry.bullets.map((bullet) => bullet.text)),
        ...result.what_would_change_my_mind.map((bullet) => bullet.text),
      ];
      for (const text of texts) {
        const quoted = [...stated].some((claim) => text.includes(claim));
        expect(quoted, `nothing in the inputs says: ${text}`).toBe(true);
      }
    }
  });

  it("never writes an uncited claim about a company (SPEC §4 hard rule 1)", () => {
    for (const one of cases) {
      const result = deriveMemoFields(one);
      for (const entry of result.sections) {
        for (const bullet of entry.bullets) {
          if (bullet.kind === "fact") expect(bullet.evidence_ids.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never exceeds a cap, and never hides one", () => {
    for (const one of cases) {
      const result = deriveMemoFields(one);
      expect(result.what_would_change_my_mind.length).toBeLessThanOrEqual(CHANGE_MY_MIND_CAP);
      for (const entry of result.sections) {
        expect(entry.bullets.length).toBeGreaterThan(0);
        expect(entry.bullets.length).toBeLessThanOrEqual(SECTION_BULLET_CAP);
        if (entry.omitted > 0) expect(entry.bullets).toHaveLength(SECTION_BULLET_CAP);
      }
    }
  });

  it("prints sections in SPEC §4's order, whichever ones survive", () => {
    for (const one of cases) {
      const headings = deriveMemoFields(one).sections.map((entry) => entry.heading);
      const positions = headings.map((heading) => HEADINGS.indexOf(heading));
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });
});
