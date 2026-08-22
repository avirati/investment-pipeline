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

const candidate = (over: Record<string, unknown> = {}) => ({
  schema_version: CANDIDATE_SCHEMA_VERSION,
  slug: "acme-traces",
  name: "Acme Traces",
  url: "https://acmetraces.dev",
  one_liner: "OpenTelemetry-native tracing for LLM calls.",
  provenance: { source: "hn", query: "LLM observability", at: AT, ref: "41234567" },
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
