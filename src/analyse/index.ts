import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type EnvSource, type GithubAuth, githubAuth } from "../config.js";
import {
  ANALYSIS_SCHEMA_VERSION,
  type Analysis,
  Analysis as AnalysisSchema,
  type AnalysisStatus,
  Candidate,
} from "../contracts/index.js";
import type { HttpOptions, Transport } from "../evidence/fetch.js";
import { evidenceStore } from "../evidence/store.js";
import { type LlmCache, type LlmUsage, llmCache } from "../llm/cache.js";
import { loadPrompt, PROMPTS, type PromptId } from "../llm/prompt.js";
import { createModel, type LlmModel, replayModel } from "../llm/provider.js";
import {
  type Manifest,
  newManifest,
  readManifest,
  writeManifest,
  writeStage,
} from "../manifest.js";
import { RUNS_ROOT, type RunPaths, runPaths } from "../run.js";
import { mapWithConcurrency, type RequestPool } from "./budget.js";
import { type ExtractResult, extractFacts } from "./extract.js";
import { type Bundle, gatherRun } from "./gather.js";
import { scoreCandidate } from "./score.js";

/**
 * Stage 2, wired (TICKET-0022). `./pipeline analyse --run <id>` is this
 * function plus argument parsing.
 *
 * ```
 * candidates.jsonl ─► gatherRun ─┬─► extractFacts ─► scoreCandidate ─► analyses/<slug>.json
 *                                └─► (one shared request budget)
 * ```
 *
 * The two phases are deliberately not one pipeline. `gatherRun` computes the
 * per-candidate allowance from the candidate *count* before it touches any of
 * them — that is what makes the allowance uniform rather than
 * first-come-first-served (inconsistency 60) — so gathering is a barrier and
 * extraction fans out behind it at its own, smaller width.
 *
 * Three rules this layer owns, none of which belong to the modules it joins:
 *
 * 1. **A candidate's failure is never the run's** (ARCHITECTURE §5). Every
 *    per-candidate throw is caught here and becomes a `failed` row in the
 *    manifest. The two exceptions are the operator's rather than the
 *    candidate's — a cold cache under `--replay` and a stale cache entry both
 *    mean the run should stop and be re-issued, and `LlmCallError` passes
 *    straight through.
 * 2. **`--replay` spends nothing, in either currency.** The LLM cache answers
 *    the model calls (`callModel` rule 4) and the HTTP cache answers the
 *    fetches, with its staleness rule suspended and its transport replaced by
 *    one that refuses. A replay makes zero requests because it structurally
 *    cannot make one, not because it is expected not to need one.
 * 3. **The analysis is written before the manifest.** A run interrupted between
 *    two candidates leaves the analyses it finished, and the manifest it writes
 *    at the end describes the ones it got to.
 */

/* -------------------------------------------------------------------------- */
/* Failures the operator caused                                                */
/* -------------------------------------------------------------------------- */

export type AnalyseFailure =
  /** `--run` names something that is not a finished stage-1 run. Exit 1. */
  | "no_run"
  /** The run is there and has nothing to analyse. A data gap. Exit 2. */
  | "no_candidates";

export class AnalyseError extends Error {
  readonly failure: AnalyseFailure;
  constructor(failure: AnalyseFailure, message: string) {
    super(message);
    this.name = "AnalyseError";
    this.failure = failure;
  }
}

/**
 * What a replay does instead of a request. Never reaches a caller: `httpGet`
 * resolves for every outcome, so this becomes a `fetch_failed` record naming
 * the replay, which is the honest thing for a memo to cite — *we did not look*,
 * rather than *we looked and found nothing*.
 */
export class ReplayNetworkError extends Error {
  constructor(url: string) {
    super(`--replay: ${url} is not in the http cache, and a replay makes no requests`);
    this.name = "ReplayNetworkError";
  }
}

/**
 * `--replay`, as http options.
 *
 * The transport is replaced rather than merely counted, including in tests: an
 * assertion that a replay made no requests is worth having only if the code
 * path could not have made one. The cache's age limit goes with it — a run
 * being re-read a week later is exactly the case `HTTP_CACHE_MAX_AGE_MS` exists
 * to expire, and expiring it here would turn a replay into a re-fetch.
 */
export function replayHttp(http: HttpOptions = {}): HttpOptions {
  const refuse: Transport = (url) => {
    throw new ReplayNetworkError(url);
  };
  return { ...http, maxAgeMs: Number.POSITIVE_INFINITY, retry: { retries: 0 }, transport: refuse };
}

/* -------------------------------------------------------------------------- */
/* The manifest's stage-2 record                                               */
/* -------------------------------------------------------------------------- */

/** Per candidate, in the manifest. The `failed` row is the one with no file. */
export const CandidateStatus = z.enum(["ok", "partial", "failed"]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const AnalyseStage = z.object({
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  duration_ms: z.number().int().min(0),
  flags: z.object({
    replay: z.boolean(),
    concurrency: z.number().int().min(1),
    gather_concurrency: z.number().int().min(1),
  }),
  /** Lines in `candidates.jsonl`, and the ones that were not candidates. */
  input: z.object({
    lines: z.number().int().min(0),
    candidates: z.number().int().min(0),
    unparseable: z.number().int().min(0),
  }),
  budget: z.object({
    candidates: z.number().int().min(1),
    github_mode: z.enum(["authenticated", "unauthenticated"]),
    github_calls: z.number().int().min(0),
    site_pages: z.number().int().min(0),
    over_planning_ceiling: z.boolean(),
    planned: z.record(z.string(), z.number().int().min(0)),
    spent: z.record(
      z.string(),
      z.object({ spent: z.number().int().min(0), limit: z.number().int().nullable() }),
    ),
  }),
  /**
   * What was actually used, not what was configured — `Manifest.llm` already
   * records the second. `cost_usd` is null while `PRICES` is empty
   * (inconsistency 54); a null here reads as "unpriced", never as free.
   */
  llm: z.object({
    provider: z.string(),
    model: z.string(),
    prompt: z.object({ id: z.string(), version: z.string() }),
    attempts: z.number().int().min(0),
    calls: z.number().int().min(0),
    from_cache: z.number().int().min(0),
    input_tokens: z.number().int().min(0).nullable(),
    output_tokens: z.number().int().min(0).nullable(),
    cost_usd: z.number().min(0).nullable(),
  }),
  /**
   * Facts kept and facts refused, run-wide. Inconsistency 77: a run where the
   * model produced twelve facts a candidate and eleven were dropped reads,
   * without this, exactly like a run with thin evidence.
   */
  facts: z.object({
    kept: z.number().int().min(0),
    dropped: z.number().int().min(0),
    dropped_by_kind: z.record(z.string(), z.number().int().min(0)),
  }),
  candidates: z.array(
    z.object({
      slug: z.string(),
      status: CandidateStatus,
      /** Why it is not `ok`. Null when it is. */
      reason: z.string().nullable(),
      /** Null on a `failed` row — there is no analysis to quote. */
      score: z.number().int().nullable(),
      coverage: z.number().nullable(),
      call: z.string().nullable(),
      facts: z.number().int().min(0),
      dropped: z.number().int().min(0),
      evidence_records: z.number().int().min(0),
      gather_failures: z.number().int().min(0),
      duration_ms: z.number().int().min(0),
    }),
  ),
  counts: z.object({
    candidates: z.number().int().min(0),
    ok: z.number().int().min(0),
    partial: z.number().int().min(0),
    failed: z.number().int().min(0),
    analyses: z.number().int().min(0),
  }),
});
export type AnalyseStage = z.infer<typeof AnalyseStage>;

/* -------------------------------------------------------------------------- */
/* Options and outcome                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Three at a time. Lower than `GATHER_CONCURRENCY` on purpose: a gather is four
 * small reads of somebody's web server, and an extraction is one large call to
 * a provider that bills per token and rate-limits per minute. The number is a
 * politeness setting, not a measurement — no live run has happened yet — and it
 * is an option so a run that knows better does not have to edit this file.
 */
export const EXTRACT_CONCURRENCY = 3;

export interface AnalyseOptions {
  runId: string;
  /** Repo root. Tests point this at a temp directory. */
  root?: string;
  /** `--replay`: answer from both caches, make no requests, spend nothing. */
  replay?: boolean;
  /** Model calls in flight. Defaults to `EXTRACT_CONCURRENCY`. */
  concurrency?: number;
  /** Fetches in flight. Defaults to `GATHER_CONCURRENCY`. */
  gatherConcurrency?: number;
  http?: HttpOptions;
  auth?: GithubAuth;
  /** Injected in tests. Otherwise built from the environment for the role. */
  model?: LlmModel;
  cache?: LlmCache;
  prompt?: PromptId;
  promptDir?: string;
  /** Overrides the meter's hard walls. See `gatherRun`. */
  limits?: Record<RequestPool, number | null>;
  now?: () => Date;
  env?: EnvSource;
}

export interface AnalysedCandidate {
  slug: string;
  status: CandidateStatus;
  reason: string | null;
  /** Null when the candidate failed outright — nothing was written for it. */
  analysis: Analysis | null;
  path: string | null;
}

export interface AnalyseOutcome {
  run_id: string;
  paths: RunPaths;
  analysed: AnalysedCandidate[];
  stage: AnalyseStage;
  manifest: Manifest;
}

/* -------------------------------------------------------------------------- */
/* Reading stage 1's output                                                    */
/* -------------------------------------------------------------------------- */

export interface CandidateFile {
  candidates: Candidate[];
  lines: number;
  unparseable: number;
}

/**
 * `candidates.jsonl` as candidates.
 *
 * A line that is not a candidate is counted and skipped rather than failing the
 * run: the file is stage 1's output and a partly-readable one still has
 * companies in it. A file where *nothing* parses is a different thing, and the
 * caller turns that into `no_candidates`.
 */
export function readCandidates(path: string): CandidateFile {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const candidates: Candidate[] = [];
  let unparseable = 0;
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      unparseable += 1;
      continue;
    }
    const parsed = Candidate.safeParse(raw);
    if (parsed.success) candidates.push(parsed.data);
    else unparseable += 1;
  }
  return { candidates, lines: lines.length, unparseable };
}

/* -------------------------------------------------------------------------- */
/* One candidate                                                               */
/* -------------------------------------------------------------------------- */

const countKinds = (entries: readonly { kind: string }[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
};

/** The status a memo prints, and the sentence beside it. */
function statusOf(extract: ExtractResult): { status: AnalysisStatus; reason: string | null } {
  if (extract.status === "ok") return { status: "ok", reason: null };
  return {
    status: "partial",
    reason:
      extract.error ??
      (extract.status === "no_evidence"
        ? "no readable evidence was gathered for this candidate"
        : "the model did not answer"),
  };
}

/**
 * Bundle plus facts into the artifact stage 3 renders. The scoring call is the
 * only place a score comes into existence (CLAUDE.md invariant 1); everything
 * here is arithmetic and bookkeeping around it.
 */
export function analysisFor(bundle: Bundle, extract: ExtractResult): Analysis {
  const scored = scoreCandidate({
    facts: extract.facts,
    signals: bundle.signals,
    evidence: bundle.evidence,
  });
  const { status, reason } = statusOf(extract);

  return AnalysisSchema.parse({
    schema_version: ANALYSIS_SCHEMA_VERSION,
    candidate: bundle.candidate,
    facts: extract.facts,
    ...scored,
    status,
    status_reason: reason,
    inputs: {
      evidence_records: bundle.evidence.length,
      evidence_usable: extract.shown_ids.length,
      gather_failures: bundle.failures.length,
      extraction: {
        status: extract.status,
        attempts: extract.attempts,
        facts: extract.facts.length,
        dropped: extract.dropped.length,
        dropped_by_kind: countKinds(extract.dropped),
        error: extract.error,
      },
    },
  });
}

/** `runs/<id>/analyses/<slug>.json`. Pretty-printed: a reviewer reads it. */
export function writeAnalysis(dir: string, analysis: Analysis): string {
  const path = join(dir, `${analysis.candidate.slug}.json`);
  writeFileSync(path, `${JSON.stringify(analysis, null, 2)}\n`);
  return path;
}

/* -------------------------------------------------------------------------- */
/* The stage                                                                   */
/* -------------------------------------------------------------------------- */

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Tokens sum to null, not to zero, when nothing reported them (inconsistency 54). */
function addUsage(total: number | null, part: number | null): number | null {
  if (part === null) return total;
  return (total ?? 0) + part;
}

/** Stage 2, end to end. Writes one analysis per candidate and the `analyse` record. */
export async function runAnalyse(options: AnalyseOptions): Promise<AnalyseOutcome> {
  const {
    runId,
    root = ".",
    replay = false,
    concurrency = EXTRACT_CONCURRENCY,
    now = () => new Date(),
    env = process.env,
  } = options;

  const startedAt = now();
  const paths = runPaths(runId, root);

  if (!existsSync(paths.dir) || !existsSync(paths.manifest)) {
    throw new AnalyseError(
      "no_run",
      `${paths.dir} is not a run directory — run './pipeline source --seed ...' first`,
    );
  }
  if (!existsSync(paths.candidates)) {
    throw new AnalyseError(
      "no_run",
      `${paths.candidates} does not exist — stage 1 did not finish for run '${runId}'`,
    );
  }

  const input = readCandidates(paths.candidates);
  if (input.candidates.length === 0) {
    throw new AnalyseError(
      "no_candidates",
      `${paths.candidates} holds no usable candidate (${input.lines} line(s), ` +
        `${input.unparseable} unreadable)`,
    );
  }

  mkdirSync(paths.analysesDir, { recursive: true });

  const auth = options.auth ?? githubAuth(env);
  const promptId = options.prompt ?? PROMPTS.extract;
  // Loaded before the first call so a broken prompt file fails the run rather
  // than every candidate in it, one at a time.
  const prompt = loadPrompt(promptId, options.promptDir);
  const model =
    options.model ?? (replay ? replayModel("extract", env) : await createModel("extract", env));
  const cache = options.cache ?? llmCache();
  const http = replay ? replayHttp(options.http) : (options.http ?? {});

  const gathered = await gatherRun(input.candidates, {
    store: evidenceStore(runId, join(root, RUNS_ROOT)),
    auth,
    http,
    ...(options.gatherConcurrency === undefined ? {} : { concurrency: options.gatherConcurrency }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  const analysed = await mapWithConcurrency(gathered.bundles, concurrency, async (bundle) => {
    const at = now().getTime();
    try {
      const extract = await extractFacts(bundle, {
        model,
        cache,
        replay,
        prompt: promptId,
        ...(options.promptDir === undefined ? {} : { promptDir: options.promptDir }),
        now,
      });
      const analysis = analysisFor(bundle, extract);
      const path = writeAnalysis(paths.analysesDir, analysis);
      return {
        bundle,
        extract,
        analysis,
        path,
        status: (analysis.status === "ok" ? "ok" : "partial") as CandidateStatus,
        reason: analysis.status_reason,
        duration_ms: Math.max(0, now().getTime() - at),
      };
    } catch (error) {
      // Rule 1. A cold cache under `--replay` is the operator's and is already
      // out of here — anything else is this candidate's, and one candidate does
      // not cost the run (ARCHITECTURE §5).
      if (error instanceof Error && error.name === "LlmCallError") throw error;
      return {
        bundle,
        extract: null,
        analysis: null,
        path: null,
        status: "failed" as CandidateStatus,
        reason: messageOf(error),
        duration_ms: Math.max(0, now().getTime() - at),
      };
    }
  });

  const finishedAt = now();

  let attempts = 0;
  let calls = 0;
  let fromCache = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cost: number | null = null;
  let kept = 0;
  const dropped: { kind: string }[] = [];

  for (const entry of analysed) {
    if (entry.extract === null) continue;
    attempts += entry.extract.attempts;
    kept += entry.extract.facts.length;
    dropped.push(...entry.extract.dropped);
    for (const call of entry.extract.calls) {
      calls += 1;
      if (call.from_cache) fromCache += 1;
      const usage: LlmUsage = call.usage;
      inputTokens = addUsage(inputTokens, usage.input_tokens);
      outputTokens = addUsage(outputTokens, usage.output_tokens);
      cost = addUsage(cost, usage.cost_usd);
    }
  }

  const counts = (status: CandidateStatus): number =>
    analysed.filter((entry) => entry.status === status).length;

  const stage = AnalyseStage.parse({
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    flags: {
      replay,
      concurrency,
      gather_concurrency: options.gatherConcurrency ?? 4,
    },
    input: {
      lines: input.lines,
      candidates: input.candidates.length,
      unparseable: input.unparseable,
    },
    budget: {
      candidates: gathered.plan.candidates,
      github_mode: gathered.plan.mode,
      github_calls: gathered.plan.github.length,
      site_pages: gathered.plan.sitePages,
      over_planning_ceiling: gathered.plan.over_planning_ceiling,
      planned: gathered.plan.planned,
      spent: gathered.requests,
    },
    llm: {
      provider: model.provider,
      model: model.model,
      prompt: { id: prompt.ref.id, version: prompt.ref.version },
      attempts,
      calls,
      from_cache: fromCache,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    },
    facts: { kept, dropped: dropped.length, dropped_by_kind: countKinds(dropped) },
    candidates: analysed.map((entry) => ({
      slug: entry.bundle.slug,
      status: entry.status,
      reason: entry.reason,
      score: entry.analysis?.score ?? null,
      coverage: entry.analysis?.coverage ?? null,
      call: entry.analysis?.call ?? null,
      facts: entry.extract?.facts.length ?? 0,
      dropped: entry.extract?.dropped.length ?? 0,
      evidence_records: entry.bundle.evidence.length,
      gather_failures: entry.bundle.failures.length,
      duration_ms: entry.duration_ms,
    })),
    counts: {
      candidates: analysed.length,
      ok: counts("ok"),
      partial: counts("partial"),
      failed: counts("failed"),
      analyses: analysed.filter((entry) => entry.analysis !== null).length,
    },
  });

  // The prompt this run read, recorded where a reviewer looks for it. Written
  // before the stage record because `writeStage` merges onto what is on disk.
  const base =
    readManifest(paths.manifest) ??
    newManifest({
      run_id: runId,
      created_at: startedAt.toISOString(),
      seed: { form: "topic", value: runId },
    });
  writeManifest(paths.manifest, {
    ...base,
    prompt_versions: { ...base.prompt_versions, [prompt.ref.id]: prompt.ref.version },
  });
  const manifest = writeStage(paths.manifest, base, "analyse", stage);

  return {
    run_id: runId,
    paths,
    analysed: analysed.map((entry) => ({
      slug: entry.bundle.slug,
      status: entry.status,
      reason: entry.reason,
      analysis: entry.analysis,
      path: entry.path,
    })),
    stage,
    manifest,
  };
}
