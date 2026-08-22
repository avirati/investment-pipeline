import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pRetry, { AbortError } from "p-retry";
import { z } from "zod";
import type { Evidence } from "../contracts/index.js";
import { makeEvidence } from "./store.js";

/**
 * The one place this pipeline talks to the network (TICKET-0008). CLAUDE.md:
 * *"Fetching goes through `src/evidence/fetch.ts` so everything is cached and
 * recorded. Never call `fetch` directly from a stage."* One choke point is also
 * the only way ARCHITECTURE §5's failure policy can be applied consistently, so
 * four rules hold here:
 *
 * 1. **A fetch failure is a result, not an exception.** `httpGet` resolves for
 *    a 404, a dead host and an exhausted retry budget alike. A dead site is
 *    *recorded* evidence of a dead site (`fetch_failed`), not an absence — that
 *    is what lets a memo say "we could not reach them" with a citation.
 *
 * 2. **A cache hit keeps the original `retrieved_at`.** Evidence ids are
 *    `sha256(url + retrieved_at)`, so re-running over a warm cache produces the
 *    *same* evidence ids rather than a second copy of the same page under a new
 *    address. The corollary is `HTTP_CACHE_MAX_AGE_MS`: an entry old enough
 *    that its timestamp would misdescribe the run is re-fetched instead.
 *
 * 3. **Retries are bounded and polite.** 429 and 5xx are retried with backoff,
 *    `Retry-After` is honoured up to a cap, and everything else is taken at its
 *    word on the first response.
 *
 * 4. **The transport and the clock are injectable.** The suite must pass
 *    offline on a fresh clone (CLAUDE.md), so every test here drives a stub
 *    transport, a fixed clock, and a `sleep` that records instead of waiting.
 */

/** Raw bodies are bulky and re-fetchable, so this directory is gitignored. */
export const HTTP_CACHE_DIR = join(".cache", "http");

/**
 * How long a cached body may stand in for a fresh one. It exists because of
 * rule 2 above: a hit replays the stored `retrieved_at` into the evidence
 * record, so an entry older than this would have the run citing a page "as of"
 * a date the run did not happen on. A day keeps a working session and a
 * re-run-after-a-crash on cache while keeping the timestamp honest. It is a
 * judgement call, not a measurement.
 */
export const HTTP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Descriptive, per the ticket: an operator on the other end who sees this in a
 * log should be able to tell what hit them and why. It names no contact URL
 * because this repo has no public home; if it ever runs against something other
 * than public read-only APIs, put one here.
 */
export const USER_AGENT = "investment-pipeline/0.1 (seed-stage VC triage; low-volume, read-only)";

/** Statuses worth trying again. Everything else is taken at its word. */
export const RETRYABLE_STATUS = (status: number): boolean =>
  status === 429 || status === 408 || status >= 500;

/**
 * Cached only when the answer is stable enough to be worth replaying: a 404 is
 * a fact about the site, a 503 is a fact about this minute. 429 is excluded for
 * the same reason — reaching one as a final answer means the retries ran out.
 */
const isCacheable = (status: number): boolean => status >= 200 && status < 500 && status !== 429;

export interface RetryPolicy {
  /** Retries *after* the first attempt. Default 3, so at most 4 requests. */
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  factor: number;
  /** A `Retry-After` longer than this ends the attempt instead of sleeping. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  retries: 3,
  minTimeout: 500,
  maxTimeout: 8_000,
  factor: 2,
  maxRetryAfterMs: 30_000,
};

/** Anything shaped like `globalThis.fetch`. Injected so tests need no network. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  transport?: Transport;
  /** Point this at a temp directory in tests; `""` disables the cache. */
  cacheDir?: string;
  maxAgeMs?: number;
  retry?: Partial<RetryPolicy>;
  headers?: Record<string, string>;
  /** Per-attempt, not per-call: three attempts may take three times this. */
  timeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface HttpBase {
  /** The url as requested, and the one the evidence record is addressed by. */
  url: string;
  /** HTTP status, or 0 when the request never got one (DNS, timeout, abort). */
  status: number;
  retrieved_at: string;
  from_cache: boolean;
  /** Requests actually made. 0 on a cache hit. */
  attempts: number;
  /** Where the response came from after redirects, when that differs. */
  final_url?: string;
}

export interface HttpSuccess extends HttpBase {
  ok: true;
  headers: Record<string, string>;
  body: string;
}

export interface HttpFailure extends HttpBase {
  ok: false;
  /** One line, written verbatim into the `fetch_failed` record's text. */
  reason: string;
}

export type HttpResult = HttpSuccess | HttpFailure;

const HTTP_CACHE_SCHEMA_VERSION = 1;

/**
 * A version mismatch fails the parse, which reads as a miss and re-fetches, so
 * changing this shape needs no cache-key change and no manual clear.
 */
const CacheEntry = z.object({
  schema_version: z.literal(HTTP_CACHE_SCHEMA_VERSION),
  url: z.string(),
  final_url: z.string().optional(),
  status: z.number().int().min(0),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  retrieved_at: z.iso.datetime(),
});
type CacheEntry = z.infer<typeof CacheEntry>;

/**
 * The precondition `httpGet` enforces, exported so the URL resolution step
 * (TICKET-0010) can filter with the same predicate rather than a lookalike.
 * A candidate url is *data* — from an HN post — so it is checked and dropped
 * upstream, not thrown on down here.
 */
export function isFetchableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** `sha256(method + url)`. Full digest: these are filenames, not citations. */
export function cacheKey(url: string, method = "GET"): string {
  return createHash("sha256").update(`${method} ${url}`).digest("hex");
}

/**
 * Seconds or an HTTP-date, per RFC 9110. `now` is passed in so the date form is
 * testable. Undefined when the header is absent or unparseable — a malformed
 * `Retry-After` falls back to the ordinary backoff rather than failing the call.
 */
export function retryAfterMs(value: string | null | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** Carries the response through p-retry so an exhausted budget still has a status. */
class RetryableStatus extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number | undefined,
    readonly finalUrl: string | undefined,
  ) {
    super(`HTTP ${status}`);
    this.name = "RetryableStatus";
  }
}

function readCache(dir: string, url: string, maxAgeMs: number, now: Date): CacheEntry | undefined {
  if (!dir) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${cacheKey(url)}.json`), "utf8");
  } catch {
    return undefined;
  }
  let parsed: CacheEntry;
  try {
    // A torn or stale-shaped entry is a miss, never an error: unlike an
    // evidence record this file is a local speedup, and re-fetching restores it.
    parsed = CacheEntry.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (parsed.url !== url) return undefined;
  const age = now.getTime() - Date.parse(parsed.retrieved_at);
  if (!(age >= 0) || age > maxAgeMs) return undefined;
  return parsed;
}

function writeCache(dir: string, entry: CacheEntry): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${cacheKey(entry.url)}.json`), `${JSON.stringify(entry)}\n`);
  } catch {
    // An unwritable cache slows the next run down; it does not fail this one.
  }
}

function toResult(entry: CacheEntry, from_cache: boolean, attempts: number): HttpResult {
  const base: HttpBase = {
    url: entry.url,
    status: entry.status,
    retrieved_at: entry.retrieved_at,
    from_cache,
    attempts,
    ...(entry.final_url ? { final_url: entry.final_url } : {}),
  };
  if (entry.status >= 200 && entry.status < 300) {
    return { ...base, ok: true, headers: entry.headers, body: entry.body };
  }
  return { ...base, ok: false, reason: `HTTP ${entry.status}` };
}

/**
 * GET a url through the cache and the retry policy. Resolves for every outcome
 * a network can produce; the only throw is a caller handing it something that
 * is not an http(s) url, which is a bug in the caller (see `isFetchableUrl`).
 */
export async function httpGet(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  if (!isFetchableUrl(url)) {
    throw new TypeError(`not an http(s) url: '${url}'. Filter with isFetchableUrl first.`);
  }

  const {
    transport = ((u, init) => globalThis.fetch(u, init)) as Transport,
    cacheDir = HTTP_CACHE_DIR,
    maxAgeMs = HTTP_CACHE_MAX_AGE_MS,
    headers = {},
    timeoutMs = 15_000,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };

  const cached = readCache(cacheDir, url, maxAgeMs, now());
  if (cached) return toResult(cached, true, 0);

  const startedAt = now().toISOString();
  let attempts = 0;

  const request = async (): Promise<Response> => {
    attempts += 1;
    const response = await transport(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (RETRYABLE_STATUS(response.status)) {
      throw new RetryableStatus(
        response.status,
        retryAfterMs(response.headers.get("retry-after"), now()),
        response.url || undefined,
      );
    }
    return response;
  };

  const withinCap = (error: Error): boolean =>
    !(error instanceof RetryableStatus) ||
    error.retryAfter === undefined ||
    error.retryAfter <= retry.maxRetryAfterMs;

  let response: Response;
  try {
    response = await pRetry(request, {
      retries: retry.retries,
      minTimeout: retry.minTimeout,
      maxTimeout: retry.maxTimeout,
      factor: retry.factor,
      // Honour the server's own number before p-retry adds its backoff, and
      // only when we intend to retry — a cap-busting Retry-After must not
      // sleep on its way out the door.
      onFailedAttempt: async ({ error }) => {
        if (
          error instanceof RetryableStatus &&
          error.retryAfter !== undefined &&
          withinCap(error)
        ) {
          await sleep(error.retryAfter);
        }
      },
      shouldRetry: ({ error }) => withinCap(error),
    });
  } catch (error) {
    const at = now().toISOString();
    if (error instanceof RetryableStatus) {
      return {
        url,
        status: error.status,
        retrieved_at: at,
        from_cache: false,
        attempts,
        ...(error.finalUrl && error.finalUrl !== url ? { final_url: error.finalUrl } : {}),
        ok: false,
        reason: `HTTP ${error.status} after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`,
      };
    }
    const cause = error instanceof AbortError ? error.originalError : (error as Error);
    return {
      url,
      status: 0,
      retrieved_at: at,
      from_cache: false,
      attempts,
      ok: false,
      reason: `${cause?.name ?? "Error"}: ${cause?.message ?? String(error)} after ${attempts} ${
        attempts === 1 ? "attempt" : "attempts"
      }`,
    };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return {
      url,
      status: response.status,
      retrieved_at: now().toISOString(),
      from_cache: false,
      attempts,
      ok: false,
      reason: `body could not be read: ${(error as Error).message}`,
    };
  }

  const entry: CacheEntry = {
    schema_version: HTTP_CACHE_SCHEMA_VERSION,
    url,
    ...(response.url && response.url !== url ? { final_url: response.url } : {}),
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body,
    retrieved_at: startedAt,
  };
  if (isCacheable(entry.status)) writeCache(cacheDir, entry);
  return toResult(entry, false, attempts);
}

/**
 * ARCHITECTURE §5: a fetch that fails becomes an `Evidence` record of type
 * `fetch_failed`, so coverage drops with a citation behind it rather than a
 * candidate silently losing a signal. The reason is the record's text because
 * the text is what a reader — and later the model — actually sees.
 */
export function fetchFailedEvidence(result: HttpFailure): Evidence {
  return makeEvidence({
    url: result.url,
    type: "fetch_failed",
    retrieved_at: result.retrieved_at,
    status: result.status,
    title: null,
    text: result.reason,
    meta: {
      attempts: result.attempts,
      from_cache: result.from_cache,
      ...(result.final_url ? { final_url: result.final_url } : {}),
    },
  });
}
