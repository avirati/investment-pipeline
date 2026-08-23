import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Analysis,
  Analysis as AnalysisSchema,
  type Evidence,
  Evidence as EvidenceSchema,
  type Memo,
  Memo as MemoSchema,
} from "../src/contracts/index.js";
import { type EvidenceStore, evidenceStore } from "../src/evidence/store.js";
import { EXIT } from "../src/exit-codes.js";
import { renderMemo } from "../src/memo/render.js";
import {
  assertMemosValid,
  MemoValidationError,
  parseBodyCitations,
  parseHeaderScore,
  parseSourceRows,
  validateMemo,
} from "../src/memo/validate.js";

/**
 * TICKET-0025 and TESTING §2. **The failure path is the point** — a validator
 * that only passes valid memos is a validator nobody has tested.
 *
 * The fixtures are TICKET-0024's two committed goldens, rendered by the real
 * renderer, so what is validated here is a memo this pipeline actually emits
 * rather than a string shaped like one. The evidence store is a real store on a
 * temp directory: the golden ids are hand-authored and would not survive
 * `store.write`'s content-addressing check, so the records are written to disk
 * directly. Reading them back is what is under test either way.
 */

const GOLDEN = join(import.meta.dirname, "golden");
type Name = "golden" | "thin";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: Name): { analysis: Analysis; evidence: Evidence[] } {
  const analysis = AnalysisSchema.parse(
    JSON.parse(readFileSync(join(GOLDEN, `analysis.${name}.json`), "utf8")),
  );
  const evidence = EvidenceSchema.array().parse(
    JSON.parse(readFileSync(join(GOLDEN, `evidence.${name}.json`), "utf8")),
  );
  return { analysis, evidence };
}

/** A store on a temp directory holding exactly the records handed to it. */
function storeWith(records: readonly Evidence[]): EvidenceStore {
  const root = mkdtempSync(join(tmpdir(), "memo-validate-"));
  roots.push(root);
  const store = evidenceStore("run-1", root);
  mkdirSync(store.dir, { recursive: true });
  for (const record of records) {
    writeFileSync(join(store.dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  return store;
}

/** The whole set-up for one golden: rendered memo, its analysis, a full store. */
function scenario(name: Name): { memo: Memo; analysis: Analysis; store: EvidenceStore } {
  const { analysis, evidence } = fixture(name);
  return { memo: renderMemo(analysis, evidence), analysis, store: storeWith(evidence) };
}

/** The same memo with its markdown edited — how every failure below is staged. */
function edited(memo: Memo, edit: (markdown: string) => string): Memo {
  return MemoSchema.parse({ ...memo, markdown: edit(memo.markdown) });
}

/* -------------------------------------------------------------------------- */
/* TESTING §2 — the failure path, first                                        */
/* -------------------------------------------------------------------------- */

describe("an id with no record behind it", () => {
  it("fails the memo, naming the memo and the id", () => {
    const { memo, analysis, store } = scenario("golden");
    const invented = "deadbeefdeadbeef";
    const tampered = edited(memo, (markdown) =>
      markdown.replace(/`[0-9a-f]{16}`/, `\`${invented}\``),
    );

    const result = validateMemo(tampered, analysis, store);
    expect(result.ok).toBe(false);
    const problem = result.problems.find((entry) => entry.kind === "unresolved_citation");
    expect(problem?.subject).toBe(invented);
    expect(problem?.miss).toBe("not_found");
    expect(problem?.message).toContain("acme-traces.md");
    expect(problem?.message).toContain(invented);
  });

  it("aborts the run with a non-zero exit", () => {
    const { memo, analysis, store } = scenario("golden");
    const tampered = edited(memo, (markdown) =>
      markdown.replace(/`[0-9a-f]{16}`/, "`deadbeefdeadbeef`"),
    );
    const results = [validateMemo(tampered, analysis, store)];

    expect(() => assertMemosValid(results)).toThrow(MemoValidationError);
    try {
      assertMemosValid(results);
      expect.unreachable("a memo citing a record that does not exist must abort the run");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoValidationError);
      const failure = error as MemoValidationError;
      expect(failure.exit).toBe(EXIT.INVARIANT);
      expect(failure.exit).not.toBe(EXIT.OK);
      expect(failure.memos).toEqual(["acme-traces.md"]);
      expect(failure.message).toContain("deadbeefdeadbeef");
    }
  });

  /**
   * The ticket's second bullet. Three causes, three messages: an id nobody
   * wrote is a citation bug, a file that will not open is an environment
   * problem, and a file that is not a record is a store something else wrote
   * to. All three fail; conflating them would send an operator to the wrong
   * place.
   */
  it("distinguishes not-found from unreadable from not-a-record", () => {
    const { memo, analysis } = scenario("golden");
    const { evidence } = fixture("golden");
    const [first, ...rest] = evidence;
    const id = (first as Evidence).id;

    const missing = validateMemo(memo, analysis, storeWith(rest));
    const notFound = missing.problems.find((entry) => entry.subject === id);
    expect(notFound?.miss).toBe("not_found");
    expect(notFound?.message).toContain("no record with that id was written by this run");

    // A directory where the record should be: the file "exists" and cannot be
    // opened, which is the environment failing rather than the citation.
    const unreadableStore = storeWith(rest);
    mkdirSync(join(unreadableStore.dir, `${id}.json`), { recursive: true });
    const unreadable = validateMemo(memo, analysis, unreadableStore);
    expect(unreadable.problems.find((entry) => entry.subject === id)?.miss).toBe("unreadable");
    expect(unreadable.problems.find((entry) => entry.subject === id)?.message).toContain(
      "could not be opened",
    );

    const invalidStore = storeWith(rest);
    writeFileSync(join(invalidStore.dir, `${id}.json`), '{"schema_version": 1}\n');
    const invalid = validateMemo(memo, analysis, invalidStore);
    expect(invalid.problems.find((entry) => entry.subject === id)?.miss).toBe("invalid");
    expect(invalid.problems.find((entry) => entry.subject === id)?.message).toContain(
      "not an evidence record",
    );
  });

  /** A malformed id is reported, not skipped by the regex. */
  it("fails an id that is not an id at all", () => {
    const { memo, analysis, store } = scenario("golden");
    const tampered = edited(memo, (markdown) => markdown.replace(/`[0-9a-f]{16}`/, "`../secrets`"));
    const result = validateMemo(tampered, analysis, store);
    const problem = result.problems.find((entry) => entry.subject === "../secrets");
    expect(problem?.miss).toBe("not_found");
    expect(problem?.message).toContain("16-character hex id");
  });
});

/* -------------------------------------------------------------------------- */
/* The table and the body have to agree                                        */
/* -------------------------------------------------------------------------- */

describe("the sources table", () => {
  it("fails when a bullet cites a label the table has no row for", () => {
    const { memo, analysis, store } = scenario("golden");
    const tampered = edited(memo, (markdown) =>
      markdown.replace("## Sources", "- An observation from nowhere.[E9]\n\n## Sources"),
    );
    const result = validateMemo(tampered, analysis, store);
    const problem = result.problems.find((entry) => entry.kind === "missing_source_row");
    expect(problem?.subject).toBe("E9");
    expect(problem?.message).toContain("no row for it");
  });

  it("fails when the table lists a row no bullet cites", () => {
    const { memo, analysis, store } = scenario("golden");
    const { evidence } = fixture("golden");
    const extra = evidence[0] as Evidence;
    const tampered = edited(
      memo,
      (markdown) =>
        `${markdown}| E9 (\`${extra.id}\`) | ${extra.url} | ${extra.retrieved_at} | ${extra.type} |\n`,
    );
    const result = validateMemo(tampered, analysis, store);
    const problem = result.problems.find((entry) => entry.kind === "orphan_source_row");
    expect(problem?.subject).toBe(extra.id);
    expect(problem?.message).toContain("no bullet cites it");
  });

  /**
   * A record in the run's evidence store that nothing cites is not a problem —
   * the table is the cited set, not the gathered set (render.ts). The thin
   * golden's dead site is exactly that case.
   */
  it("does not mind a record on disk that the memo never cites", () => {
    const { memo, analysis, store } = scenario("thin");
    const { evidence } = fixture("thin");
    const dead = evidence.find((record) => record.type === "fetch_failed");
    expect(dead).toBeDefined();
    const result = validateMemo(memo, analysis, store);
    expect(result.ok).toBe(true);
    expect(result.citations.map((citation) => citation.id)).not.toContain(dead?.id);
  });

  it("fails when the memo's own citation list disagrees with what it printed", () => {
    const { memo, analysis, store } = scenario("golden");
    const lying = MemoSchema.parse({ ...memo, citations: memo.citations.slice(0, 1) });
    const result = validateMemo(lying, analysis, store);
    expect(result.problems.map((entry) => entry.kind)).toContain("citation_list_mismatch");
  });
});

/* -------------------------------------------------------------------------- */
/* SPEC §4 hard rule 3 — the header's arithmetic                               */
/* -------------------------------------------------------------------------- */

describe("the header's score", () => {
  it("fails when it disagrees with the summed dimensions", () => {
    const { memo, analysis, store } = scenario("golden");
    const tampered = edited(memo, (markdown) =>
      markdown.replace(`score ${analysis.score}/100`, `score ${analysis.score + 5}/100`),
    );
    const result = validateMemo(tampered, analysis, store);
    const problem = result.problems.find((entry) => entry.kind === "score_mismatch");
    expect(problem?.message).toContain(`header prints score ${analysis.score + 5}`);
    expect(problem?.message).toContain(`sum to ${analysis.score}`);
  });

  /** The same class of bug one layer up: the analysis disagreeing with itself. */
  it("fails when the analysis disagrees with its own dimensions", () => {
    const { memo, store } = scenario("golden");
    const { analysis } = fixture("golden");
    const bent: Analysis = {
      ...analysis,
      dimensions: analysis.dimensions.map((dimension, index) =>
        index === 0 ? { ...dimension, score: dimension.score + 1 } : dimension,
      ),
    };
    const result = validateMemo(memo, bent, store);
    const kinds = result.problems.map((entry) => entry.kind);
    expect(kinds).toContain("score_mismatch");
    expect(result.problems.some((entry) => entry.message.includes("the analysis records"))).toBe(
      true,
    );
  });

  it("fails when the header cannot be read at all", () => {
    const { memo, analysis, store } = scenario("golden");
    const tampered = edited(
      memo,
      (markdown) => `# Acme Traces\n${markdown.split("\n").slice(1).join("\n")}`,
    );
    const result = validateMemo(tampered, analysis, store);
    expect(result.problems.map((entry) => entry.kind)).toContain("unreadable_header");
  });
});

/* -------------------------------------------------------------------------- */
/* The passing path                                                            */
/* -------------------------------------------------------------------------- */

describe("a valid memo", () => {
  it.each(["golden", "thin"] as const)("passes, with every citation resolved (%s)", (name) => {
    const { memo, analysis, store } = scenario(name);
    const result = validateMemo(memo, analysis, store);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(result.citations.length);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.map((citation) => citation.id)).toEqual(memo.citations);
    expect(() => assertMemosValid([result])).not.toThrow();
  });

  it("names the memo after the candidate unless told otherwise", () => {
    const { memo, analysis, store } = scenario("golden");
    expect(validateMemo(memo, analysis, store).memo).toBe("acme-traces.md");
    expect(validateMemo(memo, analysis, store, { name: "memos/x.md" }).memo).toBe("memos/x.md");
  });
});

/* -------------------------------------------------------------------------- */
/* Reading a memo back                                                         */
/* -------------------------------------------------------------------------- */

describe("parsing", () => {
  it("reads the sources table in printed order", () => {
    const { memo } = scenario("golden");
    const rows = parseSourceRows(memo.markdown);
    expect(rows.map((row) => row.label)).toEqual(["E1", "E2", "E3"]);
    expect(rows.map((row) => row.id)).toEqual(memo.citations);
  });

  it("does not count a table row as a bullet citing itself", () => {
    const markdown = "- A claim.[E1]\n\n| E1 (`a1b2c3d4e5f60001`) | u | t | hn_item |\n";
    expect(parseBodyCitations(markdown)).toEqual(["E1"]);
  });

  it("ignores brackets that are not citations", () => {
    const markdown = "- The site says [see docs](https://example.com/docs) and [sic].[E2]\n";
    expect(parseBodyCitations(markdown)).toEqual(["E2"]);
  });

  it("reads a raw id in a bullet, which is the renderer's unlabelled fallback", () => {
    expect(parseBodyCitations("- A claim.[a1b2c3d4e5f60001]\n")).toEqual(["a1b2c3d4e5f60001"]);
  });

  it("reads the header score, and says so when there is none", () => {
    const { memo } = scenario("golden");
    expect(parseHeaderScore(memo.markdown)).toBe(69);
    expect(parseHeaderScore("# Acme Traces\n\nscore 69/100\n")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Failing a whole run                                                         */
/* -------------------------------------------------------------------------- */

describe("assertMemosValid", () => {
  it("reports every failing memo at once, rather than one exit code at a time", () => {
    const golden = scenario("golden");
    const thin = scenario("thin");
    const results = [
      validateMemo(
        edited(golden.memo, (markdown) => markdown.replace(/`[0-9a-f]{16}`/, "`deadbeefdeadbeef`")),
        golden.analysis,
        golden.store,
      ),
      validateMemo(thin.memo, thin.analysis, thin.store),
      validateMemo(
        edited(thin.memo, (markdown) => markdown.replace(/`[0-9a-f]{16}`/, "`0000000000000000`")),
        thin.analysis,
        thin.store,
        { name: "second.md" },
      ),
    ];

    try {
      assertMemosValid(results);
      expect.unreachable("two of the three memos are invalid");
    } catch (error) {
      const failure = error as MemoValidationError;
      expect(failure.memos).toEqual(["acme-traces.md", "second.md"]);
      expect(failure.problems.length).toBeGreaterThanOrEqual(2);
      expect(failure.message).toContain("2 memo(s)");
    }
  });

  it("passes an empty set — a run with nothing to render is not a citation bug", () => {
    expect(() => assertMemosValid([])).not.toThrow();
  });
});
