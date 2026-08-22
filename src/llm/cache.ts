import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The LLM response cache (TICKET-0018, ADR-0006, ARCHITECTURE §4). Half of the
 * replay guarantee: `--replay` re-runs a pipeline over committed responses and
 * spends nothing, so a template or rubric change costs no tokens to see.
 *
 * Unlike `.cache/http/`, **this directory is committed** (see `.gitignore`).
 * That is what makes a run reproducible from a fresh clone with no key, and it
 * is why four rules hold here:
 *
 * 1. **The key is the whole call.** `sha256` over provider, model, prompt id,
 *    prompt version, output schema version and the rendered input. CLAUDE.md
 *    invariant 6 — a prompt or schema bump must never let a stale response
 *    survive silently — is this function and nothing else. ARCHITECTURE §4
 *    abbreviates the tuple to `provider|model|prompt_version|input`; the two
 *    extra fields are widening, and adding them can only split keys apart.
 *
 * 2. **A hit is verified, not assumed.** The entry stores the fields it was
 *    keyed on *and* the full input, and `read` compares them. A digest that
 *    matches a file describing a different call is a `mismatch` miss, never a
 *    reply. A cache that trusts its own filenames is a way to answer one
 *    question with another question's answer.
 *
 * 3. **The first answer wins.** Models are not deterministic, so re-writing an
 *    entry would quietly change what a committed run replays to. A repeat write
 *    is a no-op; refreshing one is `rm .cache/llm/<hash>.json`, visible in a
 *    diff like every other change to a committed file.
 *
 * 4. **A cache miss is data.** `read` reports *why* it missed, because under
 *    `--replay` the caller has to fail loudly with a reason rather than quietly
 *    calling an API the operator asked it not to call.
 *
 * The one readability cost: input and output are JSON strings, so a long prompt
 * appears with escaped newlines. Kept, because the alternative — splitting text
 * into arrays of lines — makes every reader of the file reassemble it.
 */

/** Committed, per ADR-0006 and `.gitignore`. Point tests at a temp directory. */
export const LLM_CACHE_DIR = join(".cache", "llm");

/** A bump invalidates every entry by failing the parse, which reads as a miss. */
export const LLM_CACHE_SCHEMA_VERSION = 1;

/**
 * Everything that can change an answer. `input` is the fully rendered prompt —
 * after interpolation — because that is what the model is actually asked.
 */
export interface LlmCallKey {
  provider: string;
  model: string;
  /** The prompt file's id, e.g. `clarify-query`. */
  prompt_id: string;
  /** That file's version, e.g. `1`. Never the file's mtime or hash. */
  prompt_version: string;
  /** The `schema_version` of the structure the call is asked to return. */
  schema_version: string;
  input: string;
}

/** The key fields minus the input, which is stored separately and in full. */
const CallFields = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt_id: z.string().min(1),
  prompt_version: z.string().min(1),
  schema_version: z.string().min(1),
});

/**
 * What a call cost. Nullable throughout: a provider that does not report usage
 * gives `null` rather than a zero that would read as a free call (SPEC §3's
 * rule about unknowns, applied to the manifest's cost line).
 */
export const LlmUsage = z.object({
  input_tokens: z.number().int().min(0).nullable(),
  output_tokens: z.number().int().min(0).nullable(),
  /** `null` when no price is known for the model — never a guessed number. */
  cost_usd: z.number().min(0).nullable(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

export const LlmCacheEntry = z.object({
  schema_version: z.literal(LLM_CACHE_SCHEMA_VERSION),
  /** The digest this file is addressed by, so a moved file is detectable. */
  key: z.string().regex(/^[0-9a-f]{64}$/),
  call: CallFields,
  input: z.string(),
  /** The model's answer verbatim. Structured output arrives here as JSON text. */
  output: z.string(),
  usage: LlmUsage,
  created_at: z.iso.datetime(),
});
export type LlmCacheEntry = z.infer<typeof LlmCacheEntry>;

/**
 * `sha256` over the call, as a canonical JSON array.
 *
 * The array form is what makes the boundaries unambiguous — JSON escapes the
 * separator out of every value, so no pair of differently-split field values
 * can produce the same digest input. Concatenating with a `|` would not: a
 * model named `a|b` and a provider ending in `a` collide.
 */
export function llmCacheKey(key: LlmCallKey): string {
  const canonical = JSON.stringify([
    LLM_CACHE_SCHEMA_VERSION,
    key.provider,
    key.model,
    key.prompt_id,
    key.prompt_version,
    key.schema_version,
    key.input,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Why a lookup did not answer. Reported, never guessed around. */
export type LlmCacheMiss =
  /** No file at that digest. The ordinary miss: this call has not been made. */
  | "not_found"
  /** The file exists and could not be opened. An environment problem. */
  | "unreadable"
  /** The file exists and is not a cache entry of this shape. */
  | "invalid"
  /** The file is an entry for a *different* call. Rule 2 above. */
  | "mismatch";

export type LlmCacheRead =
  | { ok: true; entry: LlmCacheEntry }
  | { ok: false; miss: LlmCacheMiss; detail: string };

export interface LlmCacheWrite {
  path: string;
  /** False when an entry was already there — the first answer wins (rule 3). */
  written: boolean;
}

export interface LlmCacheRecord {
  output: string;
  usage: LlmUsage;
  created_at: string;
}

export interface LlmCache {
  readonly dir: string;
  path(key: LlmCallKey): string;
  read(key: LlmCallKey): LlmCacheRead;
  write(key: LlmCallKey, record: LlmCacheRecord): LlmCacheWrite;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function callFields(key: LlmCallKey): z.infer<typeof CallFields> {
  return {
    provider: key.provider,
    model: key.model,
    prompt_id: key.prompt_id,
    prompt_version: key.prompt_version,
    schema_version: key.schema_version,
  };
}

/** Open the cache. Nothing is created until the first `write`. */
export function llmCache(dir = LLM_CACHE_DIR): LlmCache {
  const file = (key: LlmCallKey): string => join(dir, `${llmCacheKey(key)}.json`);

  const read = (key: LlmCallKey): LlmCacheRead => {
    const path = file(key);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { ok: false, miss: "not_found", detail: `no entry at ${path}` };
      return { ok: false, miss: "unreadable", detail: `${path}: ${code ?? String(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, miss: "invalid", detail: `${path}: ${(error as Error).message}` };
    }

    const result = LlmCacheEntry.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, miss: "invalid", detail: `${path}: ${issues}` };
    }

    // Rule 2. Reached only by a digest collision or a hand-edited file, and in
    // both cases answering would be worse than missing.
    const entry = result.data;
    const expected = callFields(key);
    const differs = (Object.keys(expected) as (keyof typeof expected)[]).filter(
      (field) => entry.call[field] !== expected[field],
    );
    if (differs.length > 0 || entry.input !== key.input) {
      const fields = [...differs, ...(entry.input === key.input ? [] : ["input"])].join(", ");
      return { ok: false, miss: "mismatch", detail: `${path}: holds a different call (${fields})` };
    }

    return { ok: true, entry };
  };

  const write = (key: LlmCallKey, record: LlmCacheRecord): LlmCacheWrite => {
    const entry = LlmCacheEntry.parse({
      schema_version: LLM_CACHE_SCHEMA_VERSION,
      key: llmCacheKey(key),
      call: callFields(key),
      input: key.input,
      output: record.output,
      usage: record.usage,
      created_at: record.created_at,
    });

    const path = file(key);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, { flag: "wx" });
      return { path, written: true };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return { path, written: false };
    }
  };

  return { dir, path: file, read, write };
}
