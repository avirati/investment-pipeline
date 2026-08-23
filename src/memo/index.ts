import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type Analysis,
  Analysis as AnalysisSchema,
  type Evidence,
  type Memo,
} from "../contracts/index.js";
import { type EvidenceStore, evidenceStore } from "../evidence/store.js";
import { type Manifest, newManifest, readManifest, writeStage } from "../manifest.js";
import { RUNS_ROOT, type RunPaths, runPaths } from "../run.js";
import { citedIds, MEMO_TEMPLATE, renderMemo } from "./render.js";
import { assertMemosValid, type MemoValidation, validateMemo } from "./validate.js";

/**
 * Stage 3, wired (TICKET-0026). `./pipeline memo --run <id>` is this function
 * plus argument parsing.
 *
 * ```
 * analyses/<slug>.json ─► renderMemo ─► validateMemo ─┬─► memos/<run_id>/<slug>.md
 * evidence/<id>.json  ─┘                              └─► manifest.stages.memo
 * ```
 *
 * This is the command a reviewer runs with no API key, no `.env` and no
 * network, and the offline guarantee is structural rather than intended: the
 * only modules reachable from here are the renderer (a template and a string),
 * the validator (pure), and the evidence store (`readFileSync`). There is no
 * import path from this file to `src/evidence/fetch.ts` or to `src/llm/`, which
 * is what CLAUDE.md invariant 3 asks for and what `tests/memo-run.test.ts`
 * asserts by failing the suite if `fetch` is ever called.
 *
 * It is **synchronous**, unlike stages 1 and 2. Nothing here awaits anything —
 * there is no request to make and no model to wait for — and an `async` here
 * would advertise a suspension point that does not exist.
 *
 * Four rules this layer owns:
 *
 * 1. **Nothing is written until every memo has passed.** The whole set is
 *    rendered and validated in memory, `assertMemosValid` throws for the set,
 *    and only then does `memos/` get touched. A failed validation is a
 *    correctness bug (ARCHITECTURE §5) and the alternative — write, then fail —
 *    leaves a memo on disk that a reader has no reason to distrust. The cost is
 *    that the operator cannot open the bad memo; what they get instead is the
 *    analysis JSON that produced it and a message naming every id that did not
 *    resolve.
 * 2. **An unreadable analysis costs its own memo and no others.** A file in
 *    `analyses/` that is not an `Analysis` is counted and skipped, exactly as
 *    stage 2 treats a line in `candidates.jsonl` that is not a candidate. A run
 *    where *nothing* parses is a different thing and stops.
 * 3. **Re-running is a no-op.** Rendering is deterministic — no clock, no
 *    ordering by anything but the slug — so a second pass produces the same
 *    bytes, and a memo whose content is unchanged is left alone rather than
 *    rewritten. `written: false` in the manifest is that fact, recorded.
 * 4. **A cited record that is missing is still rendered.** The renderer writes
 *    it as `unknown` and the validator then fails the run. Dropping the row
 *    here would produce a memo that looks complete and cites nothing checkable
 *    (`src/memo/render.ts`, rule 1).
 */

/* -------------------------------------------------------------------------- */
/* Failures the operator caused                                                */
/* -------------------------------------------------------------------------- */

export type MemoFailure =
  /** `--run` names something that is not a finished stage-2 run. Exit 1. */
  | "no_run"
  /** The run is there and has no analysis to render. A data gap. Exit 2. */
  | "no_analyses";

export class MemoError extends Error {
  readonly failure: MemoFailure;
  constructor(failure: MemoFailure, message: string) {
    super(message);
    this.name = "MemoError";
    this.failure = failure;
  }
}

/* -------------------------------------------------------------------------- */
/* The manifest's stage-3 record                                               */
/* -------------------------------------------------------------------------- */

export const MemoStage = z.object({
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  duration_ms: z.number().int().min(0),
  /** Which template rendered these memos. A memo's layout is a template away. */
  template: z.string().min(1),
  /** Files in `analyses/`, and the ones that were not analyses. */
  input: z.object({
    files: z.number().int().min(0),
    analyses: z.number().int().min(0),
    unreadable: z.number().int().min(0),
  }),
  memos: z.array(
    z.object({
      slug: z.string(),
      path: z.string(),
      call: z.string(),
      score: z.number().int(),
      coverage: z.number(),
      /** Rows in the sources table, all of which resolved — see `counts`. */
      citations: z.number().int().min(0),
      bytes: z.number().int().min(0),
      /** False when the memo on disk already had these bytes. */
      written: z.boolean(),
    }),
  ),
  /**
   * No `resolved` count here, and the omission is deliberate: this record is
   * only ever written for a run whose every citation resolved, because a run
   * where one did not throws before it reaches this line (rule 1). A resolved
   * count would be a number that is always equal to `citations`, which reads
   * like a check and is not one.
   */
  counts: z.object({
    analyses: z.number().int().min(0),
    memos: z.number().int().min(0),
    written: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    citations: z.number().int().min(0),
  }),
});
export type MemoStage = z.infer<typeof MemoStage>;

/* -------------------------------------------------------------------------- */
/* Options and outcome                                                         */
/* -------------------------------------------------------------------------- */

export interface MemoOptions {
  runId: string;
  /** Repo root. Tests point this at a temp directory. */
  root?: string;
  /** Where `memo.md.eta` lives. Defaults to the repo's `templates/`. */
  templateDir?: string;
  /** Template file name, for a caller rendering a variant. */
  template?: string;
  now?: () => Date;
}

export interface RenderedMemo {
  slug: string;
  path: string;
  memo: Memo;
  analysis: Analysis;
  validation: MemoValidation;
  bytes: number;
  /** False when the file already held these bytes — see rule 3. */
  written: boolean;
}

export interface MemoOutcome {
  run_id: string;
  paths: RunPaths;
  memos: RenderedMemo[];
  /** Files in `analyses/` that are not analyses, with why. Never fatal alone. */
  unreadable: { file: string; reason: string }[];
  stage: MemoStage;
  manifest: Manifest;
}

/* -------------------------------------------------------------------------- */
/* Reading stage 2's output                                                    */
/* -------------------------------------------------------------------------- */

export interface AnalysisFile {
  analyses: Analysis[];
  files: number;
  unreadable: { file: string; reason: string }[];
}

/**
 * `analyses/*.json` as analyses, in filename order.
 *
 * Sorted rather than left in directory order, because directory order is the
 * filesystem's and a run that renders its memos in a different sequence on a
 * different machine writes a different manifest for the same inputs. The memos
 * themselves are one file per slug and do not care; the record of them does.
 */
export function readAnalyses(dir: string): AnalysisFile {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const analyses: Analysis[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      unreadable.push({ file, reason: (error as Error).message });
      continue;
    }
    const parsed = AnalysisSchema.safeParse(raw);
    if (parsed.success) analyses.push(parsed.data);
    else {
      unreadable.push({
        file,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
    }
  }
  return { analyses, files: files.length, unreadable };
}

/**
 * The records this analysis cites, read from the run's own store.
 *
 * Only the cited ids, not the whole `evidence/` directory: a gathered record no
 * memo cites has no row to appear in, and reading the directory would make a
 * run with two hundred records pay for the two the memo needed. An id that does
 * not resolve is left out and the renderer writes it as `unknown` — rule 4.
 */
export function evidenceFor(analysis: Analysis, store: EvidenceStore): Evidence[] {
  return citedIds(analysis)
    .map((id) => store.read(id))
    .flatMap((read) => (read.ok ? [read.evidence] : []));
}

/* -------------------------------------------------------------------------- */
/* Writing one memo                                                            */
/* -------------------------------------------------------------------------- */

export interface WrittenMemo {
  path: string;
  bytes: number;
  /** False when the file already held exactly these bytes. */
  written: boolean;
}

/**
 * `memos/<run_id>/<slug>.md`.
 *
 * Overwrites, unlike an analysis or an evidence record: a memo is a *rendered*
 * artifact, and re-rendering it after a template change is the whole point of
 * stage 3 being re-runnable (ARCHITECTURE §4). The read-before-write is not
 * caution about clobbering, it is how `written: false` becomes true — a claim
 * that re-running changed nothing is worth more when the code checked.
 */
export function writeMemo(dir: string, slug: string, markdown: string): WrittenMemo {
  const path = join(dir, `${slug}.md`);
  const bytes = Buffer.byteLength(markdown, "utf8");
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current === markdown) return { path, bytes, written: false };
  writeFileSync(path, markdown);
  return { path, bytes, written: true };
}

/* -------------------------------------------------------------------------- */
/* The stage                                                                   */
/* -------------------------------------------------------------------------- */

/** Stage 3, end to end. Writes one memo per analysis and the `memo` record. */
export function runMemo(options: MemoOptions): MemoOutcome {
  const { runId, root = ".", now = () => new Date() } = options;

  const startedAt = now();
  const paths = runPaths(runId, root);

  if (!existsSync(paths.dir) || !existsSync(paths.manifest)) {
    throw new MemoError(
      "no_run",
      `${paths.dir} is not a run directory — run './pipeline source --seed ...' first`,
    );
  }
  if (!existsSync(paths.analysesDir)) {
    throw new MemoError(
      "no_run",
      `${paths.analysesDir} does not exist — run './pipeline analyse --run ${runId}' first`,
    );
  }

  const input = readAnalyses(paths.analysesDir);
  if (input.analyses.length === 0) {
    throw new MemoError(
      "no_analyses",
      `${paths.analysesDir} holds no usable analysis (${input.files} file(s), ` +
        `${input.unreadable.length} unreadable)`,
    );
  }

  const store = evidenceStore(runId, join(root, RUNS_ROOT));
  const template = options.template ?? MEMO_TEMPLATE;

  // Rendered and validated for the whole set before anything is written —
  // rule 1. `assertMemosValid` takes every result so that a run with three bad
  // memos names three and exits once (TICKET-0025).
  const rendered = input.analyses.map((analysis) => {
    const memo = renderMemo(analysis, evidenceFor(analysis, store), {
      ...(options.templateDir === undefined ? {} : { templateDir: options.templateDir }),
      template,
    });
    return { analysis, memo, validation: validateMemo(memo, analysis, store) };
  });
  assertMemosValid(rendered.map((entry) => entry.validation));

  mkdirSync(paths.memoDir, { recursive: true });
  const memos: RenderedMemo[] = rendered.map((entry) => {
    const written = writeMemo(paths.memoDir, entry.analysis.candidate.slug, entry.memo.markdown);
    return {
      slug: entry.analysis.candidate.slug,
      path: written.path,
      memo: entry.memo,
      analysis: entry.analysis,
      validation: entry.validation,
      bytes: written.bytes,
      written: written.written,
    };
  });

  const finishedAt = now();
  const stage = MemoStage.parse({
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    template,
    input: {
      files: input.files,
      analyses: input.analyses.length,
      unreadable: input.unreadable.length,
    },
    memos: memos.map((entry) => ({
      slug: entry.slug,
      path: entry.path,
      call: entry.analysis.call,
      score: entry.analysis.score,
      coverage: entry.analysis.coverage,
      citations: entry.validation.citations.length,
      bytes: entry.bytes,
      written: entry.written,
    })),
    counts: {
      analyses: input.analyses.length,
      memos: memos.length,
      written: memos.filter((entry) => entry.written).length,
      unchanged: memos.filter((entry) => !entry.written).length,
      citations: memos.reduce((total, entry) => total + entry.validation.citations.length, 0),
    },
  });

  // Stage 1 wrote this manifest and stage 2 appended to it; the fallback is for
  // a run directory assembled by hand, which is what a committed sample run
  // (TICKET-0028) and every test here is.
  const base =
    readManifest(paths.manifest) ??
    newManifest({
      run_id: runId,
      created_at: startedAt.toISOString(),
      seed: { form: "topic", value: runId },
    });
  const manifest = writeStage(paths.manifest, base, "memo", stage);

  return { run_id: runId, paths, memos, unreadable: input.unreadable, stage, manifest };
}
