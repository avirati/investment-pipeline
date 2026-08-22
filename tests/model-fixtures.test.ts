import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FACT_DEFECTS } from "../scripts/fixtures.js";
import { Fact, parseOrDrop } from "../src/contracts/index.js";

/**
 * The malformed model outputs are only useful if they are malformed in the way
 * their table claims. A fixture whose defect the parser silently tolerates is
 * worse than no fixture: TICKET-0020 would write a passing test against it.
 */

const read = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", "model", name), "utf8");

describe("model/facts-valid.json", () => {
  it("parses whole — no fact dropped", () => {
    const { kept, dropped } = parseOrDrop(Fact, JSON.parse(read("facts-valid.json")));
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(5);
  });

  it("cites an evidence id of the shape the store mints", () => {
    for (const fact of parseOrDrop(Fact, JSON.parse(read("facts-valid.json"))).kept) {
      for (const id of fact.evidence_ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("model/facts-malformed.json", () => {
  const items = JSON.parse(read("facts-malformed.json")) as unknown[];
  const { kept, dropped } = parseOrDrop(Fact, items);

  it("holds one defect per item, in table order", () => {
    expect(items).toHaveLength(FACT_DEFECTS.length);
    expect(FACT_DEFECTS.map((defect) => defect.index)).toEqual(items.map((_, index) => index));
  });

  it.each(FACT_DEFECTS.map((defect) => [defect.index, defect.defect, defect.expected] as const))(
    "item %i — %s — is %s",
    (index, _defect, expected) => {
      const wasDropped = dropped.some((entry) => entry.index === index);
      expect(wasDropped).toBe(expected === "dropped");
    },
  );

  it("drops seven and keeps the one that is well-formed and still wrong", () => {
    expect(dropped).toHaveLength(7);
    expect(kept).toHaveLength(1);
    // Parsing cannot catch an id that resolves to nothing. The memo validator
    // must, and this fact is the reason TICKET-0025 exists.
    expect(kept[0]?.evidence_ids).toEqual(["0000000000000000"]);
  });

  it("says why each drop happened, naming the field", () => {
    const reasons = new Map(dropped.map((entry) => [entry.index, entry.reason]));
    expect(reasons.get(0)).toContain("evidence_ids");
    expect(reasons.get(1)).toContain("evidence_ids");
    expect(reasons.get(3)).toContain("value");
    expect(reasons.get(4)).toContain("confidence");
    expect(reasons.get(5)).toContain("schema_version");
    expect(reasons.get(6)).toContain("statement");
    expect(reasons.get(7)).toContain("key");
  });
});

describe("model/facts-unknown.json", () => {
  it("parses whole: unknown is a cited fact, never an absence", () => {
    const { kept, dropped } = parseOrDrop(Fact, JSON.parse(read("facts-unknown.json")));
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(3);
    for (const fact of kept) {
      // CLAUDE.md invariant 4: missing data lowers coverage, never becomes a
      // zero or a guess. A null value with a citation is how that is spelled.
      expect(fact.value).toBeNull();
      expect(fact.evidence_ids.length).toBeGreaterThan(0);
      expect(fact.confidence).toBe("low");
    }
  });
});

describe("model/not-json.txt", () => {
  it("is not json, so the caller has to have a path for that", () => {
    expect(() => JSON.parse(read("not-json.txt"))).toThrow();
  });
});
