import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LLM_CACHE_SCHEMA_VERSION,
  type LlmCache,
  type LlmCallKey,
  llmCache,
  llmCacheKey,
} from "../src/llm/cache.js";

const KEY: LlmCallKey = {
  provider: "openai",
  model: "gpt-5-mini",
  prompt_id: "clarify-query",
  prompt_version: "1",
  schema_version: "2",
  input: "seed: eBPF observability\nprobe: 3 usable of 6",
};

const RECORD = {
  output: '["ebpf tracing","kernel profiler"]',
  usage: { input_tokens: 812, output_tokens: 24, cost_usd: null },
  created_at: "2026-08-22T10:00:00.000Z",
};

const dirs: string[] = [];

function cache(): LlmCache {
  const dir = mkdtempSync(join(tmpdir(), "llm-cache-"));
  dirs.push(dir);
  return llmCache(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("llmCacheKey", () => {
  it("is a full sha256 digest and is stable for the same call", () => {
    expect(llmCacheKey(KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(llmCacheKey(KEY)).toBe(llmCacheKey({ ...KEY }));
  });

  // CLAUDE.md invariant 6: a bump must never let a stale response survive.
  it("changes when any field of the call changes", () => {
    const base = llmCacheKey(KEY);
    const changed: Partial<LlmCallKey>[] = [
      { provider: "anthropic" },
      { model: "gpt-5" },
      { prompt_id: "extract" },
      { prompt_version: "2" },
      { schema_version: "3" },
      { input: `${KEY.input} ` },
    ];
    for (const override of changed) {
      expect(llmCacheKey({ ...KEY, ...override })).not.toBe(base);
    }
  });

  it("cannot be collided by moving a separator between two fields", () => {
    const left = llmCacheKey({ ...KEY, provider: "open", model: "ai|gpt" });
    const right = llmCacheKey({ ...KEY, provider: "open|ai", model: "gpt" });
    expect(left).not.toBe(right);
  });
});

describe("llmCache write", () => {
  it("writes an entry the digest addresses, and reads it back", () => {
    const store = cache();
    const written = store.write(KEY, RECORD);

    expect(written.written).toBe(true);
    expect(written.path).toBe(store.path(KEY));
    expect(written.path.endsWith(`${llmCacheKey(KEY)}.json`)).toBe(true);

    const read = store.read(KEY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entry.output).toBe(RECORD.output);
    expect(read.entry.usage).toEqual(RECORD.usage);
    expect(read.entry.call.prompt_version).toBe("1");
  });

  it("is human-readable JSON carrying the input it was keyed on", () => {
    const store = cache();
    const raw = readFileSync(store.write(KEY, RECORD).path, "utf8");

    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "output"');
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe(LLM_CACHE_SCHEMA_VERSION);
    expect(parsed.input).toBe(KEY.input);
    expect(parsed.key).toBe(llmCacheKey(KEY));
  });

  // Rule 3: models are not deterministic, so a committed run must keep
  // replaying to the answer it was recorded with.
  it("keeps the first answer when the same call is written twice", () => {
    const store = cache();
    store.write(KEY, RECORD);
    const second = store.write(KEY, { ...RECORD, output: '["something else"]' });

    expect(second.written).toBe(false);
    const read = store.read(KEY);
    expect(read.ok && read.entry.output).toBe(RECORD.output);
  });

  it("creates nothing until the first write", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "llm-cache-")), "nested");
    dirs.push(dir);
    const store = llmCache(dir);

    expect(store.read(KEY)).toMatchObject({ ok: false, miss: "not_found" });
    expect(store.write(KEY, RECORD).written).toBe(true);
    expect(store.read(KEY).ok).toBe(true);
  });
});

describe("llmCache read", () => {
  it("misses with not_found when the call has never been made", () => {
    const read = cache().read(KEY);
    expect(read).toMatchObject({ ok: false, miss: "not_found" });
    if (!read.ok) expect(read.detail).toContain(llmCacheKey(KEY));
  });

  it("misses on a prompt version bump rather than replaying the old answer", () => {
    const store = cache();
    store.write(KEY, RECORD);
    expect(store.read({ ...KEY, prompt_version: "2" })).toMatchObject({
      ok: false,
      miss: "not_found",
    });
  });

  it("misses with invalid on a torn file", () => {
    const store = cache();
    writeFileSync(store.path(KEY), "{not json");
    expect(store.read(KEY)).toMatchObject({ ok: false, miss: "invalid" });
  });

  it("misses with invalid on a file of the wrong shape", () => {
    const store = cache();
    writeFileSync(store.path(KEY), JSON.stringify({ schema_version: 1, output: "hi" }));
    expect(store.read(KEY)).toMatchObject({ ok: false, miss: "invalid" });
  });

  // Rule 2: reached by a hand-edited file or a digest collision. Answering
  // would mean replying to one question with another question's answer.
  it("misses with mismatch when the entry describes a different call", () => {
    const store = cache();
    const path = store.write(KEY, RECORD).path;
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.call.model = "gpt-4o";
    entry.input = "a different prompt";
    writeFileSync(path, JSON.stringify(entry));

    const read = store.read(KEY);
    expect(read).toMatchObject({ ok: false, miss: "mismatch" });
    if (!read.ok) expect(read.detail).toContain("model, input");
  });
});
