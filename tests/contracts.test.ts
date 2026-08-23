import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SCHEMA_VERSION,
  Analysis,
  CANDIDATE_SCHEMA_VERSION,
  Candidate,
  EVIDENCE_SCHEMA_VERSION,
  Evidence,
  FACT_SCHEMA_VERSION,
  Fact,
  MEMO_SCHEMA_VERSION,
  Memo,
  parseOrDrop,
  QUERY_PLAN_SCHEMA_VERSION,
  QueryPlan,
} from "../src/contracts/index.js";

const AT = "2026-08-22T09:00:00.000Z";
const EVIDENCE_ID = "a3f91c2e0b7d4415";

const fact = (over: Record<string, unknown> = {}) => ({
  schema_version: FACT_SCHEMA_VERSION,
  key: "founder.prior_exit",
  statement: "Jane Roe sold her previous company to Datadog in 2023.",
  value: true,
  evidence_ids: [EVIDENCE_ID],
  confidence: "high",
  ...over,
});

const provenance = (over: Record<string, unknown> = {}) => ({
  source: "hn",
  query: "LLM observability",
  at: AT,
  ref: "41234567",
  title: "Show HN: Acme Traces – OpenTelemetry-native tracing for LLM calls",
  posted_url: "https://acmetraces.dev",
  posted_at: "2026-08-10T11:22:33.000Z",
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  schema_version: CANDIDATE_SCHEMA_VERSION,
  slug: "acme-traces",
  name: "Acme Traces",
  url: "https://acmetraces.dev",
  one_liner: "OpenTelemetry-native tracing for LLM calls.",
  provenance: [provenance()],
  ...over,
});

const analysis = (over: Record<string, unknown> = {}) => ({
  schema_version: ANALYSIS_SCHEMA_VERSION,
  candidate: candidate(),
  facts: [fact()],
  dimensions: [
    {
      id: "D1",
      name: "Founder–market fit & technical depth",
      score: 20,
      max: 25,
      band: "20–25",
      evidence_ids: [EVIDENCE_ID],
      covered: true,
    },
  ],
  score: 74,
  coverage: 0.8,
  disqualifiers: [],
  call: "TAKE_A_MEETING",
  unknowns: [],
  why_this_call: [
    {
      kind: "summary",
      text: "Take a meeting — 74/100 clears the 72 threshold, at 80% coverage.",
      evidence_ids: [],
    },
  ],
  sections: [
    {
      heading: "Team",
      bullets: [{ kind: "fact", text: "Ada is the CEO.", evidence_ids: [EVIDENCE_ID] }],
      omitted: 0,
    },
  ],
  what_would_change_my_mind: [
    { kind: "check", text: "If a named design partner exists, D3 moves up.", evidence_ids: [] },
  ],
  upgrade_trigger: null,
  status: "ok",
  status_reason: null,
  inputs: {
    evidence_records: 4,
    evidence_usable: 4,
    gather_failures: 0,
    extraction: {
      status: "ok",
      attempts: 1,
      facts: 1,
      dropped: 0,
      dropped_by_kind: {},
      error: null,
    },
  },
  ...over,
});

describe("Fact — the citation contract (ADR-0003)", () => {
  it("parses a fact that carries evidence ids", () => {
    expect(Fact.safeParse(fact()).success).toBe(true);
  });

  // The two tests below are the mechanism, not a nicety: dropping uncited facts
  // *is* this parse failing. If either passes, the closed-world guarantee is off.
  it("rejects a fact with no evidence_ids field", () => {
    const { evidence_ids: _omitted, ...withoutIds } = fact();
    expect(Fact.safeParse(withoutIds).success).toBe(false);
  });

  it("rejects a fact with an empty evidence_ids array", () => {
    expect(Fact.safeParse(fact({ evidence_ids: [] })).success).toBe(false);
  });
});

describe("Candidate — provenance is a group (TICKET-0010, TICKET-0012)", () => {
  it("parses a candidate found by one post", () => {
    expect(Candidate.safeParse(candidate()).success).toBe(true);
  });

  // The v1 defect: dedup collapses two posts about one company into one
  // candidate, and a singular provenance could record only one of them.
  it("carries every post that pointed at the company, primary first", () => {
    const both = candidate({
      provenance: [provenance(), provenance({ ref: "40999999" })],
    });
    expect(Candidate.safeParse(both).success).toBe(true);
  });

  it("rejects an empty provenance — a candidate nothing pointed at is a bug", () => {
    expect(Candidate.safeParse(candidate({ provenance: [] })).success).toBe(false);
  });

  // A v1 artifact must not be readable as v2: the version bump is what stops a
  // stale candidates.jsonl from being reinterpreted (CLAUDE.md invariant 6).
  it("rejects the v1 singular object", () => {
    const v1 = candidate({
      schema_version: 1,
      provenance: provenance(),
    });
    expect(Candidate.safeParse(v1).success).toBe(false);
  });
});

describe("Analysis", () => {
  it("parses a complete analysis", () => {
    expect(Analysis.safeParse(analysis()).success).toBe(true);
  });

  it("rejects a call outside the enum", () => {
    expect(Analysis.safeParse(analysis({ call: "MAYBE" })).success).toBe(false);
    expect(Analysis.safeParse(analysis({ call: "take_a_meeting" })).success).toBe(false);
  });

  it("rejects a disqualifier with no evidence behind it (SPEC §1.1)", () => {
    const inferred = { id: "D-2", statement: "Looks like a wrapper.", evidence_ids: [] };
    expect(Analysis.safeParse(analysis({ disqualifiers: [inferred] })).success).toBe(false);
  });

  it("rejects a coverage outside 0–1, so a percentage cannot be passed by mistake", () => {
    expect(Analysis.safeParse(analysis({ coverage: 80 })).success).toBe(false);
  });

  // The v2 fields. A candidate the model never answered about and one there was
  // nothing to find about both arrive with zero facts; only these tell them
  // apart, and stage 3 may not guess (CLAUDE.md invariant 3).
  it("distinguishes a silent model from an empty world", () => {
    const silent = analysis({
      status: "partial",
      status_reason: "the model returned no readable answer in two attempts",
      inputs: {
        evidence_records: 4,
        evidence_usable: 4,
        gather_failures: 0,
        extraction: {
          status: "partial",
          attempts: 2,
          facts: 0,
          dropped: 0,
          dropped_by_kind: {},
          error: "the model returned no readable answer in two attempts",
        },
      },
    });
    const empty = analysis({
      status: "partial",
      status_reason: "no readable evidence: 2 record(s) gathered, none with text",
      inputs: {
        evidence_records: 2,
        evidence_usable: 0,
        gather_failures: 2,
        extraction: {
          status: "no_evidence",
          attempts: 0,
          facts: 0,
          dropped: 0,
          dropped_by_kind: {},
          error: "no readable evidence: 2 record(s) gathered, none with text",
        },
      },
    });

    expect(Analysis.safeParse(silent).success).toBe(true);
    expect(Analysis.safeParse(empty).success).toBe(true);
    expect(Analysis.parse(silent).inputs.extraction.status).not.toBe(
      Analysis.parse(empty).inputs.extraction.status,
    );
  });

  it("rejects a status outside the enum, and a blank reason", () => {
    expect(Analysis.safeParse(analysis({ status: "failed" })).success).toBe(false);
    expect(Analysis.safeParse(analysis({ status_reason: "" })).success).toBe(false);
  });

  // Convention 2: a gap is written as null, never omitted.
  it("requires the produced-by record rather than defaulting it", () => {
    const { inputs: _inputs, ...without } = analysis();
    expect(Analysis.safeParse(without).success).toBe(false);
  });

  /**
   * v3's three derived fields (TICKET-0024). The two tests below are SPEC §4's
   * hard rule 1 and its "empty section is deleted" rule as *schema* — the memo
   * validator will check the ids resolve, but an uncited claim or a heading
   * with nothing under it cannot reach disk in the first place.
   */
  it("rejects a fact bullet with no citation, and accepts an uncited gap", () => {
    const uncited = analysis({
      sections: [
        {
          heading: "Team",
          bullets: [{ kind: "fact", text: "Ada is the CEO.", evidence_ids: [] }],
          omitted: 0,
        },
      ],
    });
    const gap = analysis({
      sections: [
        {
          heading: "Risks",
          bullets: [{ kind: "gap", text: "D1 is unknown.", evidence_ids: [] }],
          omitted: 0,
        },
      ],
    });
    expect(Analysis.safeParse(uncited).success).toBe(false);
    expect(Analysis.safeParse(gap).success).toBe(true);
  });

  it("rejects an empty section and a heading SPEC §4 does not have", () => {
    expect(
      Analysis.safeParse(analysis({ sections: [{ heading: "Team", bullets: [], omitted: 0 }] }))
        .success,
    ).toBe(false);
    expect(
      Analysis.safeParse(
        analysis({
          sections: [
            {
              heading: "Traction",
              bullets: [{ kind: "fact", text: "900 stars.", evidence_ids: [EVIDENCE_ID] }],
              omitted: 0,
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  // SPEC §3's trigger is nullable on purpose: a Watch with no reachable
  // combination of bands says so rather than inventing one.
  it("takes a null upgrade trigger and refuses a blank one", () => {
    expect(Analysis.safeParse(analysis({ upgrade_trigger: null })).success).toBe(true);
    expect(Analysis.safeParse(analysis({ upgrade_trigger: "" })).success).toBe(false);
  });
});

describe("Evidence", () => {
  const evidence = (over: Record<string, unknown> = {}) => ({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: EVIDENCE_ID,
    url: "https://acmetraces.dev",
    type: "company_site",
    retrieved_at: AT,
    status: 200,
    title: "Acme Traces",
    text: "OpenTelemetry-native tracing for LLM calls.",
    meta: {},
    ...over,
  });

  it("parses a retrieved record", () => {
    expect(Evidence.safeParse(evidence()).success).toBe(true);
  });

  it("accepts fetch_failed — a failed fetch is a record, not an absence", () => {
    const failed = evidence({ type: "fetch_failed", status: 0, title: null, text: "ENOTFOUND" });
    expect(Evidence.safeParse(failed).success).toBe(true);
  });

  it("rejects an id that is not a truncated sha256", () => {
    expect(Evidence.safeParse(evidence({ id: "not-a-hash" })).success).toBe(false);
  });

  it("requires an absent title to be written as null, not omitted", () => {
    const { title: _omitted, ...withoutTitle } = evidence();
    expect(Evidence.safeParse(withoutTitle).success).toBe(false);
  });
});

describe("QueryPlan", () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    schema_version: QUERY_PLAN_SCHEMA_VERSION,
    original_seed: "LLM observability",
    probe: { hits: 24, usable: 11 },
    clarified: false,
    options_offered: [],
    chosen: "LLM observability",
    chosen_by: "probe",
    ...over,
  });

  // Schema version 2. A plan that skipped the probe records that it skipped it;
  // `{ hits: 0, usable: 0 }` would claim a search happened and found nothing.
  it("accepts a null probe — no probe ran is not a probe that found nothing", () => {
    const skipped = plan({ probe: null, chosen_by: "no_expand" });
    expect(QueryPlan.safeParse(skipped).success).toBe(true);
  });

  it("still requires the probe field to be present when it is null", () => {
    const { probe: _omitted, ...withoutProbe } = plan();
    expect(QueryPlan.safeParse(withoutProbe).success).toBe(false);
  });

  it("rejects a chosen_by outside ADR-0008's table", () => {
    expect(QueryPlan.safeParse(plan({ chosen_by: "vibes" })).success).toBe(false);
  });
});

describe("schema_version", () => {
  const cases = [
    ["Analysis", Analysis, analysis()],
    ["Candidate", Candidate, candidate()],
    ["Fact", Fact, fact()],
    [
      "QueryPlan",
      QueryPlan,
      {
        schema_version: QUERY_PLAN_SCHEMA_VERSION,
        original_seed: "LLM observability",
        probe: { hits: 24, usable: 11 },
        clarified: false,
        options_offered: [],
        chosen: "LLM observability",
        chosen_by: "probe",
      },
    ],
    ["Memo", Memo, { schema_version: MEMO_SCHEMA_VERSION, markdown: "# Acme", citations: [] }],
  ] as const;

  it.each(cases)("%s parses with its version", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  // A version bump must invalidate caches loudly (CLAUDE.md invariant 6), so an
  // artifact from another schema version has to fail rather than parse as this one.
  it.each(cases)("%s rejects a foreign version", (_name, schema, value) => {
    expect(schema.safeParse({ ...value, schema_version: 99 }).success).toBe(false);
  });

  it.each(cases)("%s rejects an artifact with no version at all", (_name, schema, value) => {
    const { schema_version: _omitted, ...withoutVersion } = value;
    expect(schema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("parseOrDrop", () => {
  it("keeps the valid items and drops the rest with a reason", () => {
    const { kept, dropped } = parseOrDrop(Fact, [
      fact(),
      fact({ evidence_ids: [] }),
      fact({ key: "team.size", value: 4 }),
    ]);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.index).toBe(1);
    expect(dropped[0]?.reason).toContain("evidence_ids");
  });

  it("returns empty arrays for empty input rather than throwing", () => {
    expect(parseOrDrop(Fact, [])).toEqual({ kept: [], dropped: [] });
  });
});
