import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunDir,
  deriveRunId,
  FALLBACK_SLUG,
  MAX_SEED_SLUG_LENGTH,
  RunError,
  resolveRunId,
  runPaths,
  slugify,
  validateRunId,
} from "../src/run.js";

const NOW = new Date("2026-08-22T09:00:00.000Z");

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("slugify", () => {
  it("turns a seed into a filename-safe kebab slug", () => {
    expect(slugify("LLM observability")).toBe("llm-observability");
    expect(slugify("AI agents for SMBs")).toBe("ai-agents-for-smbs");
  });

  it("collapses punctuation and trims separators rather than keeping them", () => {
    expect(slugify("  ///Dev tools:: for *LLMs*!  ")).toBe("dev-tools-for-llms");
  });

  it("cuts at a word boundary, so a truncated id still reads as words", () => {
    const slug = slugify("observability and evaluation tooling for large language model agents");
    expect(slug.length).toBeLessThanOrEqual(MAX_SEED_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    // The cut lands between words: no half-word at the end.
    expect(slug.split("-").every((word) => word.length > 0)).toBe(true);
    expect("observability and evaluation tooling for large language model agents").toContain(
      slug.split("-").join(" "),
    );
  });

  it("cuts mid-word only when there is no boundary to cut at", () => {
    const slug = slugify("a".repeat(MAX_SEED_SLUG_LENGTH + 20));
    expect(slug).toHaveLength(MAX_SEED_SLUG_LENGTH);
  });

  // ASCII-only is a deliberate limit, not an oversight: the escape hatch is
  // `--run`, and a directory name nobody can type is worse than a generic one.
  it("returns empty for a seed with nothing ASCII in it", () => {
    expect(slugify("観測可能性")).toBe("");
    expect(slugify("!!!")).toBe("");
  });
});

describe("deriveRunId", () => {
  it("is the UTC day and the seed, the form --help has always advertised", () => {
    expect(deriveRunId("LLM observability", NOW)).toBe("2026-08-22-llm-observability");
  });

  it("uses UTC, not the local day, so one seed on one day is one id everywhere", () => {
    // 23:30 UTC is already the next day in Sydney and still today in London.
    expect(deriveRunId("LLM observability", new Date("2026-08-22T23:30:00.000Z"))).toBe(
      "2026-08-22-llm-observability",
    );
  });

  it("falls back rather than producing a bare date for an unslugifiable seed", () => {
    expect(deriveRunId("観測可能性", NOW)).toBe(`2026-08-22-${FALLBACK_SLUG}`);
  });

  it("always produces something validateRunId accepts", () => {
    for (const seed of ["LLM observability", "Foo/Bar", "  ", "AI—agents", "v2.0 tooling"]) {
      expect(validateRunId(deriveRunId(seed, NOW))).toBe(deriveRunId(seed, NOW));
    }
  });
});

describe("validateRunId", () => {
  it("accepts a derived id and a hand-written one", () => {
    expect(validateRunId("2026-08-22-llm-observability")).toBe("2026-08-22-llm-observability");
    expect(validateRunId("  sample-run  ")).toBe("sample-run");
  });

  // Rejected rather than sanitised: a --run that names one directory and writes
  // to another would not tell the operator it had done so.
  it.each(["../escape", "a/b", "run..1", "", "   ", "trailing-", "double--hyphen"])(
    "rejects %j",
    (id) => {
      expect(() => validateRunId(id)).toThrow(RunError);
    },
  );

  it("rejects uppercase — one id must not mean two directories on Linux", () => {
    expect(() => validateRunId("Sample-Run")).toThrow(RunError);
  });
});

describe("resolveRunId", () => {
  it("prefers --run over the derived id", () => {
    expect(resolveRunId({ explicit: "sample-run", seed: "LLM observability", now: NOW })).toBe(
      "sample-run",
    );
  });

  it("derives from the seed when --run is absent", () => {
    expect(resolveRunId({ seed: "LLM observability", now: NOW })).toBe(
      "2026-08-22-llm-observability",
    );
  });
});

describe("runPaths", () => {
  it("puts every run artifact under runs/<id>/ and memos outside it", () => {
    const paths = runPaths("2026-08-22-llm-observability", "/tmp/x");
    expect(paths.dir).toBe("/tmp/x/runs/2026-08-22-llm-observability");
    expect(paths.manifest).toBe("/tmp/x/runs/2026-08-22-llm-observability/manifest.json");
    expect(paths.queryPlan).toBe("/tmp/x/runs/2026-08-22-llm-observability/query_plan.json");
    expect(paths.candidates).toBe("/tmp/x/runs/2026-08-22-llm-observability/candidates.jsonl");
    expect(paths.evidenceDir).toBe("/tmp/x/runs/2026-08-22-llm-observability/evidence");
    expect(paths.analysesDir).toBe("/tmp/x/runs/2026-08-22-llm-observability/analyses");
    // ARCHITECTURE §6: rendered memos are output, not a run artifact.
    expect(paths.memoDir).toBe("/tmp/x/memos/2026-08-22-llm-observability");
  });
});

describe("createRunDir", () => {
  it("creates the run directory, and runs/ with it on a fresh clone", () => {
    const root = tempRoot();
    const paths = createRunDir("2026-08-22-llm-observability", { root });
    expect(paths.dir).toBe(join(root, "runs", "2026-08-22-llm-observability"));
    // Writable, so the guard did not just report success.
    writeFileSync(join(paths.dir, "probe.txt"), "ok");
  });

  // ADR-0001's concurrency guard. Two `source` runs on one id would interleave
  // their candidates and the manifest would describe neither.
  it("refuses an existing run directory rather than overwriting it", () => {
    const root = tempRoot();
    createRunDir("sample-run", { root });
    expect(() => createRunDir("sample-run", { root })).toThrow(RunError);
    expect(() => createRunDir("sample-run", { root })).toThrow(/--replay/);
  });

  it("reuses it on a replay, which is a second look at a decided run", () => {
    const root = tempRoot();
    const first = createRunDir("sample-run", { root });
    const again = createRunDir("sample-run", { root, allowExisting: true });
    expect(again.dir).toBe(first.dir);
  });
});
