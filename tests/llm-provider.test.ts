import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../src/config.js";
import { type LlmCache, llmCache } from "../src/llm/cache.js";
import {
  callModel,
  costUsd,
  createModel,
  LlmCallError,
  type LlmModel,
  type PriceTable,
  replayModel,
  type TokenUsage,
} from "../src/llm/provider.js";

const Answer = z.object({ queries: z.array(z.string()) });
type Answer = z.infer<typeof Answer>;

const PROMPT = { id: "clarify-query", version: "1" };
const INPUT = "seed: eBPF observability";
const AT = () => new Date("2026-08-22T10:00:00.000Z");

const dirs: string[] = [];

function cache(): LlmCache {
  const dir = mkdtempSync(join(tmpdir(), "llm-provider-"));
  dirs.push(dir);
  return llmCache(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A model that records what it was asked and answers without a network. */
function stubModel(
  answer: Record<string, unknown> = { queries: ["ebpf tracing"] },
  usage: TokenUsage = { input_tokens: 800, output_tokens: 20 },
): LlmModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: "openai",
    model: "gpt-5-mini",
    calls,
    invoke: async (input) => {
      calls.push(input);
      return { value: answer as never, usage };
    },
  };
}

function call(model: LlmModel, store: LlmCache, overrides: Record<string, unknown> = {}) {
  return callModel<Answer>({
    model,
    prompt: PROMPT,
    schema: Answer,
    schema_version: "1",
    input: INPUT,
    cache: store,
    now: AT,
    ...overrides,
  });
}

describe("createModel", () => {
  // config.ts rule 1: nothing validates at import, and a failure names the
  // variable. The SDK is never reached, so this test needs no key.
  it("fails with a ConfigError naming what is missing, before loading an SDK", async () => {
    await expect(createModel("extract", {})).rejects.toBeInstanceOf(ConfigError);
    await expect(createModel("extract", {})).rejects.toThrow(/LLM_PROVIDER/);
  });

  it("reports the model variable for the role it was asked for", async () => {
    const env = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", MODEL_ANALYSE: "gpt-5" };
    await expect(createModel("extract", env)).rejects.toThrow(/MODEL_EXTRACT/);
  });
});

describe("replayModel", () => {
  const NAMES = { LLM_PROVIDER: "openai", MODEL_EXTRACT: "gpt-5-mini" };

  it("names the call without an API key, so a replay needs no secret", () => {
    const model = replayModel("extract", NAMES);
    expect(model.provider).toBe("openai");
    expect(model.model).toBe("gpt-5-mini");
  });

  it("answers a cached call, and the key is the one the real model would have used", async () => {
    const store = cache();
    await call(stubModel(), store);

    const result = await call(replayModel("extract", NAMES), store, { replay: true });
    expect(result.from_cache).toBe(true);
  });

  it("still fails when the environment cannot name the model", () => {
    expect(() => replayModel("extract", {})).toThrow(ConfigError);
  });

  // Not a run's failure mode: reaching it means a caller built a replay model
  // and then called without `replay: true`.
  it("refuses to be invoked, and says which mistake was made", async () => {
    const model = replayModel("extract", NAMES);
    await expect(call(model, cache())).rejects.toThrow(/never reaches a provider/);
  });
});

describe("costUsd", () => {
  const prices: PriceTable = { "gpt-5-mini": { input_per_mtok: 0.25, output_per_mtok: 2 } };

  it("prices a call from tokens and the table", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    expect(costUsd("gpt-5-mini", usage, prices)).toBe(1.25);
  });

  it("is null for a model with no published price rather than a guessed zero", () => {
    expect(costUsd("some-new-model", { input_tokens: 10, output_tokens: 10 }, prices)).toBeNull();
    expect(costUsd("gpt-5-mini", { input_tokens: null, output_tokens: 10 }, prices)).toBeNull();
  });

  it("ships with an empty price table, so cost is unknown until one is filled in", () => {
    expect(costUsd("gpt-5-mini", { input_tokens: 10, output_tokens: 10 })).toBeNull();
  });
});

describe("callModel", () => {
  it("calls the model on a cold cache and writes the answer", async () => {
    const store = cache();
    const model = stubModel();
    const result = await call(model, store);

    expect(model.calls).toEqual([INPUT]);
    expect(result.from_cache).toBe(false);
    expect(result.value).toEqual({ queries: ["ebpf tracing"] });
    expect(result.usage).toEqual({ input_tokens: 800, output_tokens: 20, cost_usd: null });

    const entry = JSON.parse(readFileSync(join(store.dir, `${result.key}.json`), "utf8"));
    expect(entry.output).toEqual({ queries: ["ebpf tracing"] });
    expect(entry.created_at).toBe("2026-08-22T10:00:00.000Z");
  });

  it("answers a second identical call from the cache without calling the model", async () => {
    const store = cache();
    const first = stubModel();
    await call(first, store);

    const second = stubModel({ queries: ["something else"] });
    const result = await call(second, store);

    expect(second.calls).toEqual([]);
    expect(result.from_cache).toBe(true);
    expect(result.value).toEqual({ queries: ["ebpf tracing"] });
    expect(result.usage.input_tokens).toBe(800);
  });

  // CLAUDE.md invariant 6, the whole point of versioning prompts.
  it("misses the cache when the prompt version is bumped", async () => {
    const store = cache();
    await call(stubModel(), store);

    const model = stubModel({ queries: ["v2 answer"] });
    const result = await call(model, store, { prompt: { id: PROMPT.id, version: "2" } });

    expect(model.calls).toEqual([INPUT]);
    expect(result.from_cache).toBe(false);
    expect(result.value).toEqual({ queries: ["v2 answer"] });
  });

  it("misses the cache when the schema version is bumped", async () => {
    const store = cache();
    await call(stubModel(), store);

    const model = stubModel();
    await call(model, store, { schema_version: "2" });
    expect(model.calls).toEqual([INPUT]);
  });

  it("prices the call when a price table is supplied", async () => {
    const prices: PriceTable = { "gpt-5-mini": { input_per_mtok: 0.25, output_per_mtok: 2 } };
    const result = await call(stubModel(), cache(), { prices });
    expect(result.usage.cost_usd).toBe(0.00024);
  });

  describe("--replay", () => {
    it("answers from the cache and makes no call", async () => {
      const store = cache();
      await call(stubModel(), store);

      const model = stubModel();
      const result = await call(model, store, { replay: true });

      expect(model.calls).toEqual([]);
      expect(result.from_cache).toBe(true);
    });

    it("fails loudly on a cold cache rather than calling the provider", async () => {
      const model = stubModel();
      const error = await call(model, cache(), { replay: true }).catch((e: unknown) => e);

      expect(model.calls).toEqual([]);
      expect(error).toBeInstanceOf(LlmCallError);
      expect((error as LlmCallError).kind).toBe("replay_miss");
      expect((error as Error).message).toMatch(/clarify-query v1/);
      expect((error as Error).message).toMatch(/without --replay/);
    });
  });

  // Rule 3: the key covers the schema's version, so an answer that no longer
  // fits means the schema moved and its version did not.
  it("fails on a cached answer that no longer fits the schema", async () => {
    const store = cache();
    await call(stubModel(), store);

    const Stricter = z.object({ queries: z.array(z.string()).min(2) });
    const error = await callModel({
      model: stubModel(),
      prompt: PROMPT,
      schema: Stricter,
      schema_version: "1",
      input: INPUT,
      cache: store,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).kind).toBe("stale_entry");
    expect((error as Error).message).toMatch(/Bump the schema version/);
  });
});
