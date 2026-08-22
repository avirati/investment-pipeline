import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitInfo,
  llmInfo,
  MANIFEST_SCHEMA_VERSION,
  Manifest,
  newManifest,
  readManifest,
  writeManifest,
  writeStage,
} from "../src/manifest.js";

const AT = "2026-08-22T09:00:00.000Z";
const dirs: string[] = [];

function tempFile(name = "manifest.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  dirs.push(dir);
  return join(dir, name);
}

function manifest() {
  return newManifest({
    run_id: "2026-08-22-llm-observability",
    created_at: AT,
    seed: { form: "topic", value: "LLM observability" },
    git: { sha: "abc123", dirty: false },
    llm: { provider: null, models: { extract: null, analyse: null } },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("newManifest", () => {
  it("is contract-valid and starts with no stages", () => {
    const m = manifest();
    expect(Manifest.safeParse(m).success).toBe(true);
    expect(m.stages).toEqual({});
    expect(m.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
  });
});

describe("gitInfo", () => {
  // The ticket's acceptance: the manifest ties an output to the code that made
  // it. Asserted as a shape, not a value — the sha changes every commit.
  it("reports the sha of the repository it runs in", () => {
    const info = gitInfo();
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof info.dirty).toBe("boolean");
  });

  it("says null rather than failing outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    dirs.push(dir);
    expect(gitInfo(dir)).toEqual({ sha: null, dirty: null });
  });
});

describe("llmInfo", () => {
  it("records what is configured without validating it", () => {
    expect(llmInfo({ LLM_PROVIDER: "openai", MODEL_ANALYSE: "gpt-5" })).toEqual({
      provider: "openai",
      models: { extract: null, analyse: "gpt-5" },
    });
  });

  // Stage 1 can complete without an LLM at all, so an empty env is not an error.
  it("is all nulls on an empty environment", () => {
    expect(llmInfo({})).toEqual({ provider: null, models: { extract: null, analyse: null } });
  });

  it("never carries a key", () => {
    const info = llmInfo({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-secret" });
    expect(JSON.stringify(info)).not.toContain("sk-secret");
  });
});

describe("writeManifest and readManifest", () => {
  it("round-trips through disk", () => {
    const path = tempFile();
    writeManifest(path, manifest());
    expect(readManifest(path)).toEqual(manifest());
  });

  it("returns null when there is no manifest yet", () => {
    expect(readManifest(tempFile())).toBeNull();
  });

  it("throws on a file that is not a manifest, rather than reading past it", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ schema_version: 99 }));
    expect(() => readManifest(path)).toThrow();
  });
});

describe("writeStage", () => {
  it("adds a stage record", () => {
    const path = tempFile();
    const written = writeStage(path, manifest(), "source", { candidates: 12 });
    expect(written.stages.source).toEqual({ candidates: 12 });
    expect(JSON.parse(readFileSync(path, "utf8")).stages.source.candidates).toBe(12);
  });

  // Rule 1: stage 2 running twice must not erase how stage 1 found its candidates.
  it("keeps the stages already on disk", () => {
    const path = tempFile();
    writeStage(path, manifest(), "source", { candidates: 12 });
    const after = writeStage(path, manifest(), "analyse", { scored: 12 });
    expect(after.stages.source).toEqual({ candidates: 12 });
    expect(after.stages.analyse).toEqual({ scored: 12 });
  });

  it("replaces its own stage on a re-run rather than duplicating it", () => {
    const path = tempFile();
    writeStage(path, manifest(), "source", { candidates: 12 });
    const after = writeStage(path, manifest(), "source", { candidates: 3 });
    expect(after.stages.source).toEqual({ candidates: 3 });
  });
});
