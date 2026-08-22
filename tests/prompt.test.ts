import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPrompt,
  PROMPTS,
  type Prompt,
  PromptError,
  placeholdersIn,
  promptPath,
} from "../src/llm/prompt.js";

/* -------------------------------------------------------------------------- */
/* Fixture prompts, so the loader's checks can be given something wrong        */
/* -------------------------------------------------------------------------- */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const header = (id: string, version: number, extra = ""): string =>
  `---\nid: ${id}\nversion: ${version}\n${extra}---\n`;

/** Writes one prompt file to a scratch directory and loads it from there. */
function written(id: string, version: number, text: string): Prompt {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  dirs.push(dir);
  writeFileSync(promptPath({ id, version }, dir), text, "utf8");
  return loadPrompt({ id, version }, dir);
}

describe("placeholdersIn", () => {
  it("returns names in first-appearance order, deduplicated", () => {
    expect(placeholdersIn("{{b}} then {{a}} then {{b}}")).toEqual(["b", "a"]);
  });

  it("ignores single braces and empty braces", () => {
    expect(placeholdersIn("{a} {{ }} {{}}")).toEqual([]);
  });

  it("tolerates padding inside the braces", () => {
    expect(placeholdersIn("{{ company }}")).toEqual(["company"]);
  });
});

describe("loadPrompt", () => {
  it("names the file it could not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"));
    dirs.push(dir);
    expect(() => loadPrompt({ id: "absent", version: 3 }, dir)).toThrow(PromptError);
    expect(() => loadPrompt({ id: "absent", version: 3 }, dir)).toThrow(/absent\.v3\.md/);
  });

  it("rejects a file whose front matter disagrees with its filename", () => {
    // Rule 2: the ordinary way this happens is a v2 copied from a v1.
    expect(() => written("mismatch", 2, `${header("mismatch", 1)}\nbody\n`)).toThrow(/version '1'/);
  });

  it("rejects a file with no front matter", () => {
    expect(() => written("bare", 1, "just a body\n")).toThrow(/no front matter/);
  });

  it("rejects front matter with no body", () => {
    expect(() => written("empty", 1, header("empty", 1))).toThrow(/no body/);
  });

  it("rejects declared inputs that do not match the body's placeholders", () => {
    expect(() =>
      written("drift", 1, `${header("drift", 1, "inputs: [company, evidence]\n")}\n{{company}}\n`),
    ).toThrow(/declares inputs \[company, evidence\] but its body uses \[company\]/);
  });

  it("rejects an inputs list that is not a one-line bracketed list", () => {
    expect(() =>
      written("yaml", 1, `${header("yaml", 1, "inputs:\n  - company\n")}\nbody\n`),
    ).toThrow(/one line as a bracketed list/);
  });

  it("accepts a file with no inputs declared at all", () => {
    const prompt = written("undeclared", 1, `${header("undeclared", 1)}\nHello {{name}}.\n`);
    expect(prompt.inputs).toBeNull();
    expect(prompt.placeholders).toEqual(["name"]);
  });

  it("strips the front matter, including fields it does not read", () => {
    const prompt = written(
      "body",
      1,
      `${header("body", 1, "role: extract\n")}\n# Title\n\nText.\n`,
    );
    expect(prompt.body).toBe("# Title\n\nText.\n");
  });

  it("hands callModel the version as the string it keys on", () => {
    expect(written("ref", 4, `${header("ref", 4)}\nbody\n`).ref).toEqual({
      id: "ref",
      version: "4",
    });
  });
});

describe("render", () => {
  const load = (body: string): Prompt => written("render", 1, `${header("render", 1)}\n${body}\n`);

  it("substitutes every placeholder", () => {
    expect(load("A: {{a}}, B: {{b}}, A again: {{a}}").render({ a: "1", b: "2" })).toBe(
      "A: 1, B: 2, A again: 1\n",
    );
  });

  it("refuses to render with a placeholder unsupplied", () => {
    // Rule 3: the failure mode is an extraction call with no evidence in it.
    expect(() => load("{{company}} {{evidence}}").render({ company: "Acme" })).toThrow(
      /nothing supplied for \[evidence\]/,
    );
  });

  it("refuses a value the prompt does not use", () => {
    expect(() => load("{{company}}").render({ company: "Acme", evidenc: "..." })).toThrow(
      /supplied \[evidenc\], which it does not use/,
    );
  });

  it("does not re-scan substituted values", () => {
    // Rule 4: evidence text is fetched from the internet, and a page that
    // writes `{{company}}` must not be able to reach into the prompt.
    const rendered = load("{{evidence}}|{{company}}").render({
      evidence: "the page said {{company}}",
      company: "Acme",
    });
    expect(rendered).toBe("the page said {{company}}|Acme\n");
  });

  it("substitutes an empty string without complaint", () => {
    // A bundle with nothing usable in it is still a bundle (gather.ts rule 3).
    expect(load("[{{evidence}}]").render({ evidence: "" })).toBe("[]\n");
  });
});

/* -------------------------------------------------------------------------- */
/* The committed prompts                                                       */
/* -------------------------------------------------------------------------- */

describe("prompts/ as committed", () => {
  it.each(Object.entries(PROMPTS))("%s loads and declares its inputs", (_name, id) => {
    const prompt = loadPrompt(id);
    expect(prompt.inputs).not.toBeNull();
    expect(prompt.body.length).toBeGreaterThan(200);
  });

  it("extract.v1 asks for the three things TICKET-0020 renders", () => {
    expect([...loadPrompt(PROMPTS.extract).placeholders].sort()).toEqual([
      "company",
      "evidence",
      "keys",
    ]);
  });

  it("extract.v1 restates no part of the rubric", () => {
    // CLAUDE.md invariant 7 and TICKET-0019's named failure mode: a prompt that
    // leaks the rubric turns the model back into the scorer through the back
    // door. Every term below is scoring vocabulary from SPEC §1–2 and lives in
    // `src/analyse/score.ts`. Note what is *not* banned: the prompt has to be
    // able to forbid scoring, so it says "scoring" and that is the point.
    const body = loadPrompt(PROMPTS.extract).body.toLowerCase();
    for (const term of [
      "thesis",
      "rubric",
      "wedge",
      "defensib",
      "moat",
      "traction",
      "founder–market",
      "founder-market",
      "ai-native",
      "why now",
      "incumbent",
      "disqualif",
      "take a meeting",
      "bottom-up",
    ]) {
      expect(body, `extract.v1.md must not mention "${term}"`).not.toContain(term);
    }
  });

  it("extract.v1 states the closed-world citation rule", () => {
    const body = loadPrompt(PROMPTS.extract).body;
    expect(body).toContain("evidence_ids");
    expect(body).toMatch(/must be one of the ids listed above/);
    expect(body).toMatch(/discarded unread/);
  });
});
