import { z } from "zod";
import { type AnalyseOutcome, runAnalyse } from "./analyse/index.js";
import type { EnvSource, GithubAuth } from "./config.js";
import type { HttpOptions } from "./evidence/fetch.js";
import type { LlmCache } from "./llm/cache.js";
import type { LlmModel } from "./llm/provider.js";
import { type Manifest, writeStage } from "./manifest.js";
import { type MemoOutcome, runMemo } from "./memo/index.js";
import type { RunPaths } from "./run.js";
import { runSource, type SourceOptions, type SourceOutcome } from "./source/index.js";

/**
 * `./pipeline run` — the three stages in one process (TICKET-0027).
 *
 * SPEC §5's first acceptance criterion is `./setup.sh`, then **one command**,
 * then memos. This module is that command, and it is deliberately thin: it
 * chains the three stage entrypoints, threads the run id and `--replay`
 * through them, and writes one manifest record saying they were one
 * invocation. It contains no sourcing, no scoring and no rendering, because
 * `run` is `source` plus `analyse` plus `memo` and not a fourth program.
 *
 * Four rules:
 *
 * 1. **The stages are called through their public entrypoints**, the same ones
 *    `./pipeline source|analyse|memo` call. Nothing here reaches into a stage's
 *    internals (CLAUDE.md invariant 5), so a run and three separate commands
 *    produce byte-identical artifacts. That is what makes the three-command
 *    path a real debugging tool rather than a documented fiction.
 * 2. **The run id comes from stage 1 and is never re-derived.** Stage 1 mints
 *    it from the seed and the UTC day; stages 2 and 3 are handed what stage 1
 *    returned. A run that crossed midnight between stage 1 and stage 2 would
 *    otherwise write its analyses into a directory that does not exist.
 * 3. **A stage's failure is the run's.** Unlike a *candidate's* failure, which
 *    stage 2 absorbs (ARCHITECTURE §5), there is no useful continuation from a
 *    stage 1 that found nothing or a stage 3 whose citations did not resolve.
 *    The error propagates with its own exit code, and the stages that did
 *    finish have already written their artifacts and their manifest records.
 * 4. **Progress goes to stderr, summaries to stdout.** A run is several
 *    minutes and mostly silent otherwise; `./pipeline run ... > report.txt`
 *    should still capture the three summaries and still show a person what is
 *    happening while it happens.
 */

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export type PipelineStage = "source" | "analyse" | "memo";

export const PIPELINE_STAGES: readonly PipelineStage[] = ["source", "analyse", "memo"];

/**
 * What a long run says while it runs. A discriminated union rather than
 * pre-formatted strings: the CLI owns how a run looks, and a test that asserts
 * on events rather than on text does not break when a column moves.
 */
export type PipelineEvent =
  | { kind: "stage_started"; stage: PipelineStage; index: number; of: number }
  | { kind: "stage_finished"; stage: PipelineStage; index: number; of: number; duration_ms: number }
  /** One candidate finished in stage 2 — the only stage that takes minutes. */
  | { kind: "candidate"; slug: string; status: string; done: number; of: number };

export type PipelineReporter = (event: PipelineEvent) => void;

/* -------------------------------------------------------------------------- */
/* The manifest record                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `manifest.stages.run`. Everything here is *about the invocation* rather than
 * about a stage — each stage already writes its own record, and duplicating
 * their numbers would give a reviewer two places to read one fact and no way to
 * tell which is stale. What only this layer knows is that the three happened
 * together, in what order, and how long the whole thing took.
 */
export const RunStage = z.object({
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  duration_ms: z.number().int().min(0),
  flags: z.object({ replay: z.boolean() }),
  /** One row per stage that finished, in the order they ran. */
  stages: z.array(
    z.object({
      stage: z.enum(["source", "analyse", "memo"]),
      duration_ms: z.number().int().min(0),
    }),
  ),
  counts: z.object({
    candidates: z.number().int().min(0),
    analyses: z.number().int().min(0),
    /**
     * The two shapes a candidate goes wrong in, and they are not the same
     * thing. `partial` is thin or unanswered evidence — an analysis was still
     * written, at a lower coverage, and a memo is rendered from it. `failed` is
     * no analysis at all. A run tolerates both (SPEC §5), and a run of fifteen
     * partials is a very different run from one of fifteen failures.
     */
    partial: z.number().int().min(0),
    failed: z.number().int().min(0),
    memos: z.number().int().min(0),
  }),
  /** Null while `PRICES` is empty — unpriced, never free (inconsistency 54). */
  cost_usd: z.number().min(0).nullable(),
});
export type RunStage = z.infer<typeof RunStage>;

/* -------------------------------------------------------------------------- */
/* Options and outcome                                                         */
/* -------------------------------------------------------------------------- */

export interface PipelineOptions
  extends Omit<SourceOptions, "root" | "http" | "now" | "env" | "replay"> {
  /** Repo root. Tests point this at a temp directory. */
  root?: string;
  /** `--replay`: stage 1 reuses its plan, stage 2 reads bundles and the LLM cache. */
  replay?: boolean;
  /** Model calls in flight in stage 2. */
  concurrency?: number;
  /** Where `memo.md.eta` lives. Defaults to the repo's `templates/`. */
  templateDir?: string;
  /**
   * Injected in tests, and shared by both stages that fetch — one transport,
   * one HTTP cache, so a test can assert that a replay made no request at all
   * rather than that stage 2 made none.
   */
  http?: HttpOptions;
  auth?: GithubAuth;
  model?: LlmModel;
  cache?: LlmCache;
  now?: () => Date;
  env?: EnvSource;
  /** Rule 4. Omit for a silent run — the tests do. */
  report?: PipelineReporter;
}

export interface PipelineOutcome {
  run_id: string;
  paths: RunPaths;
  source: SourceOutcome;
  analyse: AnalyseOutcome;
  memo: MemoOutcome;
  stage: RunStage;
  manifest: Manifest;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/** All three stages, one run id, one manifest. */
export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
  const {
    root = ".",
    replay = false,
    now = () => new Date(),
    env = process.env,
    report,
    concurrency: _concurrency,
    templateDir: _templateDir,
    http: _http,
    auth: _auth,
    model: _model,
    cache: _cache,
    ...seedOptions
  } = options;

  const startedAt = now();
  const durations: RunStage["stages"] = [];
  const of = PIPELINE_STAGES.length;

  /** Announce, run, time, announce. The only place a stage boundary is timed. */
  const stage = async <T>(name: PipelineStage, body: () => Promise<T> | T): Promise<T> => {
    const index = PIPELINE_STAGES.indexOf(name) + 1;
    report?.({ kind: "stage_started", stage: name, index, of });
    const at = now().getTime();
    const result = await body();
    const duration_ms = Math.max(0, now().getTime() - at);
    durations.push({ stage: name, duration_ms });
    report?.({ kind: "stage_finished", stage: name, index, of, duration_ms });
    return result;
  };

  const source = await stage("source", () =>
    runSource({
      ...seedOptions,
      root,
      replay,
      now,
      env,
      ...(options.http === undefined ? {} : { http: options.http }),
    }),
  );

  // Rule 2: stage 1's id, not a second derivation of it.
  const runId = source.run_id;
  let done = 0;

  const analyse = await stage("analyse", () =>
    runAnalyse({
      runId,
      root,
      replay,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.http === undefined ? {} : { http: options.http }),
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      now,
      env,
      onCandidate: (row) => {
        done += 1;
        report?.({
          kind: "candidate",
          slug: row.slug,
          status: row.status,
          done,
          of: source.candidates.length,
        });
      },
    }),
  );

  const memo = await stage("memo", () =>
    runMemo({
      runId,
      root,
      ...(options.templateDir === undefined ? {} : { templateDir: options.templateDir }),
      now,
    }),
  );

  const finishedAt = now();
  const record = RunStage.parse({
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    flags: { replay },
    stages: durations,
    counts: {
      candidates: source.stage.counts.candidates,
      analyses: analyse.stage.counts.analyses,
      partial: analyse.stage.counts.partial,
      failed: analyse.stage.counts.failed,
      memos: memo.stage.counts.memos,
    },
    cost_usd: analyse.stage.llm.cost_usd,
  });

  // Same rule as stage 2's record, and for the same reason: a replay of a
  // committed run must not overwrite that run's timings with its own 54ms
  // (STATE inconsistency 96). `stages.run_replay` sits beside `stages.run`.
  const manifest = writeStage(
    memo.paths.manifest,
    memo.manifest,
    replay ? "run_replay" : "run",
    record,
  );

  return {
    run_id: runId,
    paths: memo.paths,
    source,
    analyse,
    memo,
    stage: record,
    manifest,
  };
}
