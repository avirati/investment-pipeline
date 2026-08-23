import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";
import {
  type EnvSource,
  type LlmConfig,
  type LlmRole,
  requireLlmConfig,
  requireLlmNames,
} from "../config.js";
import { type LlmCache, type LlmCallKey, type LlmUsage, llmCache, llmCacheKey } from "./cache.js";

/**
 * The provider seam (TICKET-0018, ADR-0006). Two properties live here and
 * nowhere else: **swapping providers is an env change**, and **replay costs
 * nothing**. Both matter to a reviewer who has a key for a different provider
 * than the author, or no key at all.
 *
 * Four rules:
 *
 * 1. **A narrow slice of LangChain.** The model wrapper and
 *    `withStructuredOutput`, and nothing else — no chains, agents, memory or
 *    retrievers. ADR-0006 is deliberate about this and it is the reason the
 *    dependency is acceptable at all: caching, prompting and orchestration are
 *    ours, because those are the parts that must stay inspectable for the
 *    citation and replay guarantees to hold. Versions are pinned exact; the
 *    ADR names LangChain churn as the known risk.
 *
 * 2. **The SDK is loaded when it is called, not when it is imported.** The
 *    adapters are behind `await import`, so `./pipeline memo`, a replay, and
 *    the whole test suite never load a provider SDK they will not call. It also
 *    keeps this module importable with an empty environment, which `config.ts`
 *    requires of everything upstream of an actual call.
 *
 * 3. **A cache hit is re-parsed, not trusted.** `callModel` validates a stored
 *    answer against the caller's schema on the way out. If that fails, the
 *    schema changed without its version changing — CLAUDE.md invariant 6 — and
 *    it throws saying so rather than silently spending tokens to paper over it.
 *
 * 4. **`--replay` never calls an API.** A miss under replay is a loud failure
 *    naming the file it wanted, because quietly calling the network is the one
 *    thing the operator asked this flag not to do.
 *
 * Not here: retry-on-invalid-structure (ARCHITECTURE §5 puts one retry with the
 * parse error appended at TICKET-0020) and prompt rendering (TICKET-0019).
 */

/** What a provider reported. `null` when it reported nothing — never a zero. */
export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * One call: rendered prompt in, parsed value out. The seam the tests stub, and
 * the only shape `callModel` knows about — `createModel` is the one place a
 * LangChain type appears in a value position.
 */
export interface LlmModel {
  readonly provider: string;
  readonly model: string;
  invoke<T extends Record<string, unknown>>(
    input: string,
    schema: z.ZodType<T>,
    options?: { name?: string },
  ): Promise<{ value: T; usage: TokenUsage }>;
}

/**
 * `withStructuredOutput` names the structure it asks for; the name reaches the
 * provider as a tool or schema name, so it is a word about the shape, not the
 * task. Overridden per call where a better word exists.
 */
const DEFAULT_OUTPUT_NAME = "answer";

/**
 * Adding a provider is a case here and a line in `LLM_PROVIDERS`
 * (`src/config.ts`). Note what is *not* set: no temperature. Providers disagree
 * about which values their newer models accept, and pinning one here would make
 * the choice of model a source of runtime failures. Reproducibility comes from
 * the response cache, not from a sampler setting.
 */
async function chatModel(config: LlmConfig): Promise<BaseChatModel> {
  switch (config.provider) {
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({ model: config.model, apiKey: config.api_key });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({ model: config.model, apiKey: config.api_key });
    }
  }
}

/**
 * Read structurally rather than through `AIMessage`: that type's fields are
 * inferred from a message-structure generic, and `usage_metadata` resolves to
 * `never` on the un-parameterised `BaseMessage` a runnable hands back. This is
 * the "abstractions leak" line in ADR-0006, and the leak is one narrow type.
 */
interface UsageBearing {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
}

function tokenUsage(raw: BaseMessage): TokenUsage {
  const usage = (raw as unknown as UsageBearing).usage_metadata;
  return {
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
  };
}

/**
 * Resolve the role's provider, model and key, then build the adapter. Throws
 * `ConfigError` naming the variable when the environment is incomplete — call
 * it immediately before a call, never at module load (`src/config.ts` rule 1).
 */
export async function createModel(role: LlmRole, env: EnvSource = process.env): Promise<LlmModel> {
  const config = requireLlmConfig(role, env);
  const chat = await chatModel(config);

  return {
    provider: config.provider,
    model: config.model,
    invoke: async (input, schema, options) => {
      const structured = chat.withStructuredOutput(schema, {
        includeRaw: true,
        name: options?.name ?? DEFAULT_OUTPUT_NAME,
      });
      const reply = await structured.invoke(input);
      // Parsed twice: LangChain validates against the schema it sent the
      // provider, and this re-parse is what makes the return typed as `T`
      // rather than a cast over `Record<string, any>`.
      return { value: schema.parse(reply.parsed), usage: tokenUsage(reply.raw) };
    },
  };
}

/**
 * A handle that can address the cache and cannot make a call.
 *
 * `--replay` is answered entirely by `callModel`'s cache read, and the cache
 * key holds the provider's and the model's *names* — nothing else about the
 * adapter is consulted. So a replay resolves names only (`requireLlmNames`) and
 * a fresh clone with a committed cache can re-run a stage without an API key.
 *
 * `invoke` throwing is not a failure mode a run can reach: reaching it means a
 * caller built a replay model and then called without `replay: true`, which is
 * a wiring bug and should read as one rather than as a provider error.
 */
export function replayModel(role: LlmRole, env: EnvSource = process.env): LlmModel {
  const names = requireLlmNames(role, env);
  return {
    provider: names.provider,
    model: names.model,
    invoke: () => {
      throw new Error(
        `replay model for '${role}' was asked to call ${names.provider}/${names.model} — ` +
          `a replay never reaches a provider. Pass replay: true, or build the model with createModel.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Cost. Tokens are reported by the provider; money is not.
// ---------------------------------------------------------------------------

/** USD per million tokens, as published by the provider. */
export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * **Ships empty, on purpose.** A run manifest is committed to this repo, so a
 * cost line in it is a number a reader will believe. List prices move, and a
 * wrong one is worse than an absent one — `cost_usd: null` reads as "not
 * known", which is the truth until somebody fills this in from a price page on
 * a date and says so here. Token counts are recorded either way, and they are
 * the part the provider actually reported.
 */
export const PRICES: PriceTable = {};

/** `null` unless both a price and both token counts are known. */
export function costUsd(
  model: string,
  usage: TokenUsage,
  prices: PriceTable = PRICES,
): number | null {
  const price = prices[model];
  if (price === undefined) return null;
  if (usage.input_tokens === null || usage.output_tokens === null) return null;
  const usd =
    (usage.input_tokens * price.input_per_mtok + usage.output_tokens * price.output_per_mtok) /
    1_000_000;
  // Six decimals: a call costing less than a hundredth of a cent still shows.
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// The cached call.
// ---------------------------------------------------------------------------

/** Why a call could not be answered. The CLI maps these to an exit code. */
export type LlmCallFailure =
  /** `--replay` with nothing cached for this call. Rule 4. */
  | "replay_miss"
  /** A cached answer no longer fits its schema, and the version did not move. */
  | "stale_entry";

export class LlmCallError extends Error {
  constructor(
    readonly kind: LlmCallFailure,
    message: string,
  ) {
    super(message);
    this.name = "LlmCallError";
  }
}

/** The prompt file this call renders, as `prompts/<id>.v<version>.md`. */
export interface PromptRef {
  id: string;
  version: string;
}

export interface CallOptions<T extends Record<string, unknown>> {
  model: LlmModel;
  prompt: PromptRef;
  schema: z.ZodType<T>;
  /** The `schema_version` of `schema`. In the cache key; bump it when it moves. */
  schema_version: string;
  /** The fully rendered prompt — what the model is asked, after interpolation. */
  input: string;
  cache?: LlmCache;
  /** `--replay`: answer from the cache or fail. Never calls the provider. */
  replay?: boolean;
  prices?: PriceTable;
  name?: string;
  now?: () => Date;
}

export interface CallResult<T> {
  value: T;
  usage: LlmUsage;
  from_cache: boolean;
  /** The cache digest, so a manifest entry can point at the file. */
  key: string;
}

/**
 * One structured call, through the committed cache. The only function a stage
 * should use — `createModel` builds the adapter, this decides whether to spend
 * anything.
 */
export async function callModel<T extends Record<string, unknown>>(
  options: CallOptions<T>,
): Promise<CallResult<T>> {
  const {
    model,
    prompt,
    schema,
    schema_version,
    input,
    cache = llmCache(),
    replay = false,
    prices = PRICES,
    name,
    now = () => new Date(),
  } = options;

  const key: LlmCallKey = {
    provider: model.provider,
    model: model.model,
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    schema_version,
    input,
  };
  const digest = llmCacheKey(key);
  const hit = cache.read(key);

  if (hit.ok) {
    const parsed = schema.safeParse(hit.entry.output);
    if (parsed.success) {
      return { value: parsed.data, usage: hit.entry.usage, from_cache: true, key: digest };
    }
    // Rule 3. The key covers the schema's *version*, so an answer that no
    // longer fits means the schema moved and the version did not.
    throw new LlmCallError(
      "stale_entry",
      `cached answer for ${prompt.id} v${prompt.version} no longer fits its schema ` +
        `(version '${schema_version}'): ${parsed.error.issues[0]?.message ?? "parse failed"}. ` +
        `Bump the schema version — a changed schema must never reuse a key. ` +
        `The entry is ${cache.path(key)}.`,
    );
  }

  if (replay) {
    throw new LlmCallError(
      "replay_miss",
      `--replay: no cached answer for ${prompt.id} v${prompt.version} (${hit.miss}: ${hit.detail}). ` +
        `Re-run without --replay to make the call, or commit the cache entry.`,
    );
  }

  const reply = await model.invoke(input, schema, name === undefined ? undefined : { name });
  const usage: LlmUsage = {
    input_tokens: reply.usage.input_tokens,
    output_tokens: reply.usage.output_tokens,
    cost_usd: costUsd(model.model, reply.usage, prices),
  };
  cache.write(key, { output: reply.value, usage, created_at: now().toISOString() });

  return { value: reply.value, usage, from_cache: false, key: digest };
}
