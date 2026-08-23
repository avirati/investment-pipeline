import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Analysis,
  Analysis as AnalysisSchema,
  type Evidence,
  Evidence as EvidenceSchema,
} from "../src/contracts/index.js";
import { EXIT } from "../src/exit-codes.js";
import { newManifest, readManifest, writeManifest, writeStage } from "../src/manifest.js";
import { MemoError, readAnalyses, runMemo, writeMemo } from "../src/memo/index.js";
import { citedIds } from "../src/memo/render.js";
import { MemoValidationError } from "../src/memo/validate.js";
import { runPaths } from "../src/run.js";

/**
 * TICKET-0026 — stage 3, wired. The failure path first, as in TICKET-0025:
 * the two things this stage promises that nobody would notice breaking are
 * *nothing is written when a citation does not resolve* and *re-running changes
 * nothing*, and both are silent when they go wrong.
 *
 * The inputs are TICKET-0024's two committed goldens, assembled into a run
 * directory on a temp root: `analyses/<slug>.json` from `analysis.*.json`, and
 * `evidence/<id>.json` written straight to disk, because the golden ids are
 * hand-authored and would not survive `store.write`'s content-addressing check
 * (`tests/memo-validate.test.ts` does the same).
 */

const GOLDEN = join(import.meta.dirname, "golden");
type Name = "golden" | "thin";

const AT = new Date("2026-08-23T09:00:00.000Z");
const NOW = () => AT;
const RUN_ID = "2026-08-23-llm-observability";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: Name): { analysis: Analysis; evidence: Evidence[] } {
  return {
    analysis: AnalysisSchema.parse(
      JSON.parse(readFileSync(join(GOLDEN, `analysis.${name}.json`), "utf8")),
    ),
    evidence: EvidenceSchema.array().parse(
      JSON.parse(readFileSync(join(GOLDEN, `evidence.${name}.json`), "utf8")),
    ),
  };
}

interface RunOptions {
  /** Which goldens to file under `analyses/`. Both by default. */
  names?: Name[];
  /** Evidence ids to leave out of the store — how an unresolved citation is staged. */
  withhold?: string[];
  /** Whether stage 1 and 2 left a manifest. They always do; a test can say no. */
  manifest?: boolean;
}

/** A run directory a stage-2 run could have left behind. Returns the repo root. */
function scenario(options: RunOptions = {}): string {
  const { names = ["golden", "thin"], withhold = [], manifest = true } = options;
  const root = mkdtempSync(join(tmpdir(), "memo-run-"));
  roots.push(root);
  const paths = runPaths(RUN_ID, root);

  mkdirSync(paths.analysesDir, { recursive: true });
  mkdirSync(join(paths.dir, "evidence"), { recursive: true });

  for (const name of names) {
    const { analysis, evidence } = fixture(name);
    writeFileSync(
      join(paths.analysesDir, `${analysis.candidate.slug}.json`),
      `${JSON.stringify(analysis, null, 2)}\n`,
    );
    for (const record of evidence) {
      if (withhold.includes(record.id)) continue;
      writeFileSync(
        join(paths.dir, "evidence", `${record.id}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );
    }
  }

  if (manifest) {
    writeManifest(
      paths.manifest,
      newManifest({
        run_id: RUN_ID,
        created_at: AT.toISOString(),
        seed: { form: "topic", value: "llm observability" },
        git: { sha: null, dirty: null },
        llm: { provider: null, models: {} },
      }),
    );
  }
  return root;
}

const memoFiles = (root: string): string[] => {
  try {
    return readdirSync(runPaths(RUN_ID, root).memoDir).sort();
  } catch {
    return [];
  }
};

/* -------------------------------------------------------------------------- */
/* The failure path, first                                                     */
/* -------------------------------------------------------------------------- */

describe("a memo citing a record that is not on disk", () => {
  /** The first id the golden memo prints, withheld from the store behind it. */
  const missing = (): string => citedIds(fixture("golden").analysis)[0] as string;

  it("aborts the run and names the id", () => {
    const root = scenario({ names: ["golden"], withhold: [missing()] });
    try {
      runMemo({ runId: RUN_ID, root, now: NOW });
      expect.unreachable("a memo with an unresolvable citation must not pass");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoValidationError);
      const failure = error as MemoValidationError;
      expect(failure.exit).toBe(EXIT.INVARIANT);
      expect(failure.memos).toEqual(["acme-traces.md"]);
      expect(failure.message).toContain(missing());
    }
  });

  it("writes nothing at all — not even the memos that passed (rule 1)", () => {
    const root = scenario({ withhold: [missing()] });
    expect(() => runMemo({ runId: RUN_ID, root, now: NOW })).toThrow(MemoValidationError);
    expect(memoFiles(root)).toEqual([]);
  });

  it("leaves no stage-3 record in the manifest", () => {
    const root = scenario({ names: ["golden"], withhold: [missing()] });
    expect(() => runMemo({ runId: RUN_ID, root, now: NOW })).toThrow(MemoValidationError);
    expect(readManifest(runPaths(RUN_ID, root).manifest)?.stages.memo).toBeUndefined();
  });

  it("does not overwrite the memo a previous, good pass wrote", () => {
    const root = scenario({ names: ["golden"] });
    const first = runMemo({ runId: RUN_ID, root, now: NOW });
    const before = readFileSync(first.memos[0]?.path as string, "utf8");

    rmSync(join(runPaths(RUN_ID, root).dir, "evidence", `${missing()}.json`));
    expect(() => runMemo({ runId: RUN_ID, root, now: NOW })).toThrow(MemoValidationError);
    expect(readFileSync(first.memos[0]?.path as string, "utf8")).toBe(before);
  });
});

describe("a run that cannot be rendered", () => {
  it("refuses a run directory stage 1 never made", () => {
    const root = mkdtempSync(join(tmpdir(), "memo-run-"));
    roots.push(root);
    try {
      runMemo({ runId: RUN_ID, root, now: NOW });
      expect.unreachable("a missing run directory must not render");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoError);
      expect((error as MemoError).failure).toBe("no_run");
      expect((error as MemoError).message).toContain("is not a run directory");
    }
  });

  it("refuses a run directory with no manifest in it", () => {
    const root = scenario({ names: ["golden"], manifest: false });
    try {
      runMemo({ runId: RUN_ID, root, now: NOW });
      expect.unreachable("a run directory with no manifest is not a run");
    } catch (error) {
      expect((error as MemoError).failure).toBe("no_run");
    }
  });

  it("names the analyse command when stage 2 never ran", () => {
    const root = scenario({ names: [] });
    rmSync(runPaths(RUN_ID, root).analysesDir, { recursive: true });
    try {
      runMemo({ runId: RUN_ID, root, now: NOW });
      expect.unreachable("a run with no analyses directory must not render");
    } catch (error) {
      expect((error as MemoError).failure).toBe("no_run");
      expect((error as MemoError).message).toContain(`./pipeline analyse --run ${RUN_ID}`);
    }
  });

  it("reports an empty analyses directory as a data gap, not a bug", () => {
    const root = scenario({ names: [] });
    try {
      runMemo({ runId: RUN_ID, root, now: NOW });
      expect.unreachable("a run with no analyses must not render");
    } catch (error) {
      expect((error as MemoError).failure).toBe("no_analyses");
      expect((error as MemoError).message).toContain("0 file(s)");
    }
  });

  it("stops when every analysis on disk is unreadable, and counts them", () => {
    const root = scenario({ names: ["golden"] });
    writeFileSync(join(runPaths(RUN_ID, root).analysesDir, "acme-traces.json"), "{not json");
    try {
      runMemo({ runId: RUN_ID, root, now: NOW });
      expect.unreachable("a run whose analyses do not parse must not render");
    } catch (error) {
      expect((error as MemoError).failure).toBe("no_analyses");
      expect((error as MemoError).message).toContain("1 unreadable");
    }
  });
});

describe("one unreadable analysis", () => {
  it("costs its own memo and no others (rule 2)", () => {
    const root = scenario();
    writeFileSync(join(runPaths(RUN_ID, root).analysesDir, "broken.json"), '{"schema_version":4}');

    const outcome = runMemo({ runId: RUN_ID, root, now: NOW });
    expect(outcome.memos.map((memo) => memo.slug)).toEqual(["acme-traces", "vaporware"]);
    expect(outcome.unreadable.map((entry) => entry.file)).toEqual(["broken.json"]);
    expect(outcome.stage.input).toEqual({ files: 3, analyses: 2, unreadable: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* The happy path                                                              */
/* -------------------------------------------------------------------------- */

describe("rendering a run", () => {
  it("writes one memo per analysis, under memos/<run_id>/", () => {
    const root = scenario();
    const outcome = runMemo({ runId: RUN_ID, root, now: NOW });

    expect(memoFiles(root)).toEqual(["acme-traces.md", "vaporware.md"]);
    expect(outcome.paths.memoDir).toBe(join(root, "memos", RUN_ID));
    for (const memo of outcome.memos) {
      expect(readFileSync(memo.path, "utf8")).toBe(memo.memo.markdown);
      expect(memo.validation.ok).toBe(true);
      expect(memo.written).toBe(true);
    }
  });

  it("renders byte-for-byte what the committed snapshot holds (TESTING §7)", () => {
    const root = scenario({ names: ["golden"] });
    runMemo({ runId: RUN_ID, root, now: NOW });
    expect(readFileSync(join(root, "memos", RUN_ID, "acme-traces.md"), "utf8")).toBe(
      readFileSync(join(GOLDEN, "memo.golden.md"), "utf8"),
    );
  });

  it("resolves every citation it printed", () => {
    const root = scenario();
    const outcome = runMemo({ runId: RUN_ID, root, now: NOW });
    for (const memo of outcome.memos) {
      expect(memo.validation.resolved).toBe(memo.validation.citations.length);
      expect(memo.validation.citations.length).toBeGreaterThan(0);
    }
    expect(outcome.stage.counts.citations).toBe(
      outcome.memos.reduce((total, memo) => total + memo.validation.citations.length, 0),
    );
  });

  it("appends its record to the manifest without erasing stage 1's", () => {
    const root = scenario();
    const paths = runPaths(RUN_ID, root);
    const base = readManifest(paths.manifest);
    if (base === null) throw new Error("the scenario writes a manifest");
    writeStage(paths.manifest, base, "source", { counts: { candidates: 2 } });

    const outcome = runMemo({ runId: RUN_ID, root, now: NOW });
    const manifest = readManifest(paths.manifest);
    expect(manifest?.stages.source).toEqual({ counts: { candidates: 2 } });
    expect(manifest?.stages.memo).toEqual(outcome.stage);
    expect(outcome.stage.template).toBe("memo.md.eta");
    expect(outcome.stage.counts).toEqual({
      analyses: 2,
      memos: 2,
      written: 2,
      unchanged: 0,
      citations: outcome.stage.counts.citations,
    });
  });

  it("carries the call and the score into the manifest, in filename order", () => {
    const root = scenario();
    const { stage } = runMemo({ runId: RUN_ID, root, now: NOW });
    expect(stage.memos.map((memo) => [memo.slug, memo.call, memo.score])).toEqual([
      ["acme-traces", "WATCH", 69],
      ["vaporware", "PASS", 27],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotence — rule 3                                                        */
/* -------------------------------------------------------------------------- */

describe("re-running", () => {
  it("produces byte-identical memos and says nothing changed", () => {
    const root = scenario();
    const first = runMemo({ runId: RUN_ID, root, now: NOW });
    const before = first.memos.map((memo) => readFileSync(memo.path, "utf8"));

    const second = runMemo({ runId: RUN_ID, root, now: NOW });
    expect(second.memos.map((memo) => readFileSync(memo.path, "utf8"))).toEqual(before);
    expect(second.memos.every((memo) => memo.written)).toBe(false);
    expect(second.stage.counts).toMatchObject({ written: 0, unchanged: 2 });
  });

  it("rewrites a memo somebody edited, and says it did", () => {
    const root = scenario({ names: ["golden"] });
    const first = runMemo({ runId: RUN_ID, root, now: NOW });
    const path = first.memos[0]?.path as string;
    writeFileSync(path, "# not a memo\n");

    const second = runMemo({ runId: RUN_ID, root, now: NOW });
    expect(second.memos[0]?.written).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(first.memos[0]?.memo.markdown);
  });
});

/* -------------------------------------------------------------------------- */
/* The offline guarantee — SPEC §5, CLAUDE.md invariant 3                      */
/* -------------------------------------------------------------------------- */

describe("stage 3 offline", () => {
  it("renders a whole run with fetch replaced by a throw", () => {
    const root = scenario();
    const original = globalThis.fetch;
    let calls = 0;
    // Not a stub that records: a stub that *cannot succeed*. An assertion that
    // stage 3 made no request is worth having only if the path could not have
    // made one (`replayHttp` in stage 2 takes the same position).
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("stage 3 made a network request");
    }) as typeof fetch;
    try {
      const outcome = runMemo({ runId: RUN_ID, root, now: NOW });
      expect(outcome.memos).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });

  it("needs no environment: no key, no provider, no .env", () => {
    const root = scenario();
    const saved = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (/^(LLM_|MODEL_|ANTHROPIC_|OPENAI_|GITHUB_)/.test(name)) delete process.env[name];
    }
    try {
      expect(runMemo({ runId: RUN_ID, root, now: NOW }).memos).toHaveLength(2);
    } finally {
      process.env = saved;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The pieces                                                                  */
/* -------------------------------------------------------------------------- */

describe("readAnalyses", () => {
  it("reads json only, sorted, and reports why a file did not parse", () => {
    const root = scenario();
    const dir = runPaths(RUN_ID, root).analysesDir;
    writeFileSync(join(dir, "notes.txt"), "ignored");
    writeFileSync(join(dir, "aardvark.json"), '{"schema_version":4,"candidate":{}}');

    const read = readAnalyses(dir);
    expect(read.files).toBe(3);
    expect(read.analyses.map((analysis) => analysis.candidate.slug)).toEqual([
      "acme-traces",
      "vaporware",
    ]);
    expect(read.unreadable[0]?.file).toBe("aardvark.json");
    expect(read.unreadable[0]?.reason).toContain("candidate");
  });
});

describe("writeMemo", () => {
  it("reports bytes and whether the file moved", () => {
    const root = mkdtempSync(join(tmpdir(), "memo-write-"));
    roots.push(root);

    const first = writeMemo(root, "acme", "# Acme\n");
    expect(first).toEqual({ path: join(root, "acme.md"), bytes: 7, written: true });
    expect(writeMemo(root, "acme", "# Acme\n").written).toBe(false);
    expect(writeMemo(root, "acme", "# Acme Traces\n").written).toBe(true);
  });
});

describe("a re-render that changed nothing", () => {
  /**
   * `setup.sh` step 6 runs `./pipeline memo --run <the committed sample>` on
   * every fresh clone. Before this, that produced two moved timestamps and a
   * dirty working tree — a reviewer's first `git status` after setup showing a
   * committed artifact modified. Same rule stage 2 keeps for a replay (STATE
   * inconsistency 96): do not overwrite a record of work you did not do.
   */
  it("leaves the manifest's memo record alone", () => {
    const root = scenario({ names: ["golden"] });
    const paths = runPaths(RUN_ID, root);
    runMemo({ runId: RUN_ID, root, now: NOW });
    const first = readManifest(paths.manifest)?.stages.memo;
    const before = readFileSync(paths.manifest, "utf8");

    const again = runMemo({
      runId: RUN_ID,
      root,
      now: () => new Date("2026-08-24T09:00:00.000Z"),
    });

    expect(again.stage.counts.written).toBe(0);
    expect(again.stage.counts.unchanged).toBe(again.stage.counts.memos);
    // The outcome still reports this invocation honestly; the file does not move.
    expect(again.stage.started_at).toBe("2026-08-24T09:00:00.000Z");
    expect(readManifest(paths.manifest)?.stages.memo).toEqual(first);
    expect(readFileSync(paths.manifest, "utf8")).toBe(before);
  });

  it("still writes the record when a memo actually changed", () => {
    const root = scenario({ names: ["golden"] });
    const paths = runPaths(RUN_ID, root);
    runMemo({ runId: RUN_ID, root, now: NOW });
    const first = readManifest(paths.manifest)?.stages.memo;

    // Something else edited a memo. The next pass rewrites it, so the record
    // of the render is this invocation's.
    const memo = readdirSync(paths.memoDir).find((name) => name.endsWith(".md")) as string;
    writeFileSync(join(paths.memoDir, memo), "stale\n");

    const again = runMemo({
      runId: RUN_ID,
      root,
      now: () => new Date("2026-08-24T09:00:00.000Z"),
    });

    expect(again.stage.counts.written).toBe(1);
    expect(readManifest(paths.manifest)?.stages.memo).not.toEqual(first);
  });
});
