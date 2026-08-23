import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Analysis,
  Analysis as AnalysisSchema,
  type Evidence,
  Evidence as EvidenceSchema,
  Memo,
} from "../src/contracts/index.js";
import { citedIds, memoView, renderMemo, sourcesOf } from "../src/memo/render.js";

/**
 * TICKET-0024's stage-3 half, and TESTING §7's snapshot.
 *
 * Two committed goldens, both produced by running the real `scoreCandidate` and
 * `deriveMemoFields` over hand-written facts — so they are analyses this
 * pipeline could actually emit rather than shapes somebody typed:
 *
 * - **`golden`** — a Watch with all three fact sections, a low-confidence
 *   statement, a partial status and an upgrade trigger.
 * - **`thin`** — a Pass forced by two disqualifiers, with a Risks section,
 *   two uncovered dimensions, and a dead site among its evidence.
 *
 * The snapshot files are checked in. A template change shows up as a diff in
 * two markdown files, which is the point: memo changes are reviewed by reading
 * the memo.
 */

const GOLDEN = join(import.meta.dirname, "golden");

function golden(name: "golden" | "thin"): { analysis: Analysis; evidence: Evidence[] } {
  const analysis = AnalysisSchema.parse(
    JSON.parse(readFileSync(join(GOLDEN, `analysis.${name}.json`), "utf8")),
  );
  const evidence = EvidenceSchema.array().parse(
    JSON.parse(readFileSync(join(GOLDEN, `evidence.${name}.json`), "utf8")),
  );
  return { analysis, evidence };
}

const memoFor = (name: "golden" | "thin") => {
  const { analysis, evidence } = golden(name);
  return renderMemo(analysis, evidence);
};

const snapshot = (name: "golden" | "thin"): string =>
  readFileSync(join(GOLDEN, `memo.${name}.md`), "utf8");

/* -------------------------------------------------------------------------- */
/* TESTING §7 — the snapshot                                                   */
/* -------------------------------------------------------------------------- */

describe("the golden memos", () => {
  it.each(["golden", "thin"] as const)("renders %s exactly as committed", (name) => {
    expect(memoFor(name).markdown).toBe(snapshot(name));
  });

  it("parses as a memo, with every cited id listed", () => {
    for (const name of ["golden", "thin"] as const) {
      const memo = memoFor(name);
      expect(Memo.safeParse(memo).success).toBe(true);
      expect(memo.citations).toEqual(citedIds(golden(name).analysis));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The acceptance items                                                        */
/* -------------------------------------------------------------------------- */

describe("SPEC §4's shape", () => {
  // "A partner must reach the call in under 60 seconds": the call, the score
  // and the coverage are all on line one, and line two is the company.
  it("puts the call, the score and the coverage in the first line", () => {
    const [first, , third] = memoFor("golden").markdown.split("\n");
    expect(first).toBe("# Acme Traces — WATCH · score 69/100 · coverage 100%");
    expect(third).toContain("https://acmetraces.dev");
  });

  it("renders no 'could not verify' section when nothing is unknown", () => {
    const { analysis } = golden("golden");
    expect(analysis.unknowns).toEqual([]);
    expect(memoFor("golden").markdown).not.toContain("could not verify");
  });

  it("renders one when something is", () => {
    const { analysis } = golden("thin");
    expect(analysis.unknowns.length).toBe(2);
    const markdown = memoFor("thin").markdown;
    expect(markdown).toContain("## What we could not verify");
    for (const unknown of analysis.unknowns) expect(markdown).toContain(unknown);
  });

  it("prints only the sections the analysis carries, in its order", () => {
    const headings = memoFor("thin")
      .markdown.split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3));
    // Team and Market are absent because the analysis has nothing under them —
    // an empty section is deleted, never faked (SPEC §4).
    expect(headings).toEqual([
      "Why this call",
      "Product",
      "Risks",
      "What would change my mind",
      "What we could not verify",
      "Sources",
    ]);
  });

  it("states a Watch's upgrade trigger, and says nothing about one on a Pass", () => {
    expect(memoFor("golden").markdown).toContain("**To upgrade this Watch:**");
    expect(memoFor("thin").markdown).not.toContain("To upgrade");
  });

  it("prints stage 2's own sentence about a degraded reading, verbatim", () => {
    const { analysis } = golden("thin");
    expect(memoFor("thin").markdown).toContain(analysis.status_reason as string);
  });
});

/* -------------------------------------------------------------------------- */
/* Citations                                                                   */
/* -------------------------------------------------------------------------- */

describe("citations", () => {
  it("labels every cited id, in first-cited order, and lists each once", () => {
    const { analysis, evidence } = golden("golden");
    const sources = sourcesOf(analysis, evidence);
    expect(sources.map((source) => source.label)).toEqual(["E1", "E2", "E3"]);
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
  });

  /**
   * SPEC §4 hard rule 1, at the render layer: a claim about the company must
   * carry an id, and the id must be one the sources table explains. The schema
   * refuses an uncited `fact` bullet; this checks the label actually reaches
   * the markdown, which is the half a template can silently drop.
   */
  it("prints a label beside every factual bullet", () => {
    for (const name of ["golden", "thin"] as const) {
      const { analysis } = golden(name);
      const markdown = memoFor(name).markdown;
      for (const section of analysis.sections) {
        for (const bullet of section.bullets) {
          if (bullet.kind !== "fact") continue;
          const line = markdown
            .split("\n")
            .find((candidate) => candidate.startsWith(`- ${bullet.text}`));
          expect(line, `no bullet line for: ${bullet.text}`).toBeDefined();
          expect(line).toMatch(/\[E\d+\](\[E\d+\])*$/);
        }
      }
    }
  });

  it("puts every label in the sources table, with the full id beside it", () => {
    for (const name of ["golden", "thin"] as const) {
      const memo = memoFor(name);
      const { analysis, evidence } = golden(name);
      for (const source of sourcesOf(analysis, evidence)) {
        expect(memo.markdown).toContain(`| ${source.label} (\`${source.id}\`) | ${source.url} |`);
      }
    }
  });

  /**
   * The table is the *cited* set, not the gathered set. The thin fixture's dead
   * site is in the run's evidence store and in `inputs.gather_failures`, and no
   * bullet cites it — so it has no row, and the memo says what was missing
   * under "what we could not verify" instead. A source row nobody cites would
   * read as a source somebody used.
   */
  it("gives no source row to a record nothing cites", () => {
    const { analysis, evidence } = golden("thin");
    const dead = evidence.find((record) => record.type === "fetch_failed");
    expect(dead).toBeDefined();
    const cited = sourcesOf(analysis, evidence).map((source) => source.id);
    // Nothing cites it in this fixture; the table is the cited set, not the
    // gathered set, and the record is still in the run's evidence store.
    expect(cited).not.toContain(dead?.id);
    expect(analysis.inputs.gather_failures).toBe(1);
  });

  /**
   * Rule 1 in the module header. An id with no record behind it is a bug the
   * memo validator (TICKET-0025) fails the run over — and it can only do that
   * if the renderer leaves the id visible instead of quietly dropping the row.
   */
  it("writes an unresolvable id as unknown rather than dropping it", () => {
    const { analysis } = golden("golden");
    const sources = sourcesOf(analysis, []);
    expect(sources).toHaveLength(citedIds(analysis).length);
    for (const source of sources) {
      expect(source.url).toBe("unknown");
      expect(source.retrieved).toBe("unknown");
      expect(source.type).toBe("unknown");
    }
    const memo = renderMemo(analysis, []);
    expect(memo.citations).toEqual(citedIds(analysis));
    expect(memo.markdown).toContain("| unknown | unknown | unknown |");
  });

  it("prints the raw id if a label is ever missing, rather than nothing", () => {
    const { analysis, evidence } = golden("golden");
    expect(memoView(analysis, evidence).label(["not-a-cited-id"])).toBe("[not-a-cited-id]");
  });
});

/* -------------------------------------------------------------------------- */
/* Invariant 3                                                                 */
/* -------------------------------------------------------------------------- */

describe("stage 3 spends nothing", () => {
  /**
   * The ticket's third acceptance item. `renderMemo` takes no transport and no
   * model, so the assertion available is that the global one is never reached:
   * `fetch` is replaced with a stub that fails the test if it is called.
   */
  it("makes no network call — asserted with a stub, not assumed", () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("stage 3 made a network call");
    }) as typeof globalThis.fetch;
    try {
      expect(memoFor("golden").markdown.length).toBeGreaterThan(0);
      expect(memoFor("thin").markdown.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
  });

  it("is pure — the same analysis renders the same memo, byte for byte", () => {
    for (const name of ["golden", "thin"] as const) {
      expect(memoFor(name)).toEqual(memoFor(name));
    }
  });

  it("names the template file when it is missing", () => {
    const { analysis, evidence } = golden("golden");
    expect(() => renderMemo(analysis, evidence, { template: "no-such.eta" })).toThrow(
      /no-such\.eta/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The committed run                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The three analyses from the live run render too. This is deliberately
 * structural rather than a snapshot — TICKET-0028 will re-run and replace them,
 * and a memo test that pins a company's prose would then fail for the wrong
 * reason.
 */
describe("the committed sample run", () => {
  const runDir = join(import.meta.dirname, "..", "runs", "2026-08-23-ai-agent-infrastructure");

  it("renders every committed analysis with a call in its first line", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    if (!existsSync(join(runDir, "analyses"))) return;

    const evidence = readdirSync(join(runDir, "evidence"))
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        EvidenceSchema.parse(JSON.parse(readFileSync(join(runDir, "evidence", file), "utf8"))),
      );

    const files = readdirSync(join(runDir, "analyses")).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const analysis = AnalysisSchema.parse(
        JSON.parse(readFileSync(join(runDir, "analyses", file), "utf8")),
      );
      const memo = renderMemo(analysis, evidence);
      const first = memo.markdown.split("\n")[0] ?? "";
      expect(first).toContain(analysis.candidate.name);
      expect(first).toContain(analysis.call);
      expect(first).toContain(`score ${analysis.score}/100`);
      // Every id the memo cites resolves in the run's own evidence store —
      // the guarantee TICKET-0025 will enforce as a hard failure.
      const known = new Set(evidence.map((record) => record.id));
      for (const id of memo.citations) expect(known.has(id)).toBe(true);
    }
  });
});
