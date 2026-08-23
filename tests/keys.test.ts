import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACT_KEY_LIST,
  FACT_KEYS,
  FactKeyEnum,
  isFactKey,
  renderKeys,
} from "../src/analyse/keys.js";

/**
 * The vocabulary is unvalidated (no eval harness in v1) so these tests cannot
 * check that it is the *right* list. They check the two things that are
 * checkable: that it is a well-formed closed set, and that nothing in it states
 * a conclusion — because a key or a hint that ranks is the model scoring the
 * company one field earlier than ADR-0002 allows.
 */

const modelFixture = (name: string): { key?: string }[] =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "model", name), "utf8"));

describe("FACT_KEYS", () => {
  it("is a set — no key appears twice", () => {
    expect(new Set(FACT_KEY_LIST).size).toBe(FACT_KEY_LIST.length);
  });

  it("uses one shape: lowercase group, dot, lowercase name", () => {
    for (const key of FACT_KEY_LIST) expect(key).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
  });

  it("gives every key a hint that says what an observation under it looks like", () => {
    for (const entry of FACT_KEYS) {
      expect(entry.hint.length).toBeGreaterThan(20);
      expect(entry.hint).toMatch(/\.$/);
    }
  });

  // CLAUDE.md invariant 7: the thesis lives in `src/analyse/score.ts`. A hint
  // that names a dimension, a weight or a band has moved part of it here, and
  // the copy nobody updates is always the second one.
  it("restates no part of the rubric — no dimension ids, no points, no thresholds", () => {
    for (const entry of FACT_KEYS) {
      const text = `${entry.key} ${entry.hint}`;
      expect(text).not.toMatch(/\bD-?[1-5]\b/);
      expect(text).not.toMatch(/\b\d+\s*(pts|points)\b/i);
      expect(text).not.toMatch(/\bband\b|\bscore\b|\bdisqualif/i);
    }
  });

  // Rule 2. These are the adjectives a model reaches for when it is grading
  // rather than reading, and the prompt already forbids them in a statement.
  it("names observations, not verdicts", () => {
    const ranking = /\b(strong|weak|impressive|promising|thin|good|poor|credible|real)\b/i;
    for (const entry of FACT_KEYS) expect(`${entry.key} ${entry.hint}`).not.toMatch(ranking);
  });

  it("covers every key the committed good-day fixtures use", () => {
    const used = [...modelFixture("facts-valid.json"), ...modelFixture("facts-unknown.json")]
      .map((fact) => fact.key)
      .filter((key): key is string => key !== undefined);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(isFactKey(key)).toBe(true);
  });
});

describe("FactKeyEnum", () => {
  it("accepts every listed key", () => {
    for (const key of FACT_KEY_LIST) expect(FactKeyEnum.safeParse(key).success).toBe(true);
  });

  it("rejects a key the model invented", () => {
    expect(FactKeyEnum.safeParse("market.size_usd").success).toBe(false);
    expect(FactKeyEnum.safeParse("founder.is_technical").success).toBe(false);
  });
});

describe("renderKeys", () => {
  it("renders one line per key, key first and backticked", () => {
    const lines = renderKeys().split("\n");
    expect(lines).toHaveLength(FACT_KEYS.length);
    lines.forEach((line, index) => {
      expect(line.startsWith(`- \`${FACT_KEYS[index]?.key}\` — `)).toBe(true);
    });
  });

  it("holds no placeholder syntax of its own", () => {
    // It is interpolated into a prompt and `loadPrompt` substitutes in one
    // pass, so braces here would be left as text — visible, but confusing.
    expect(renderKeys()).not.toContain("{{");
  });
});
