#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { type AnalyseOutcome, runAnalyse } from "./analyse/index.js";
import { ConfigError, loadDotEnv } from "./config.js";
import { EXIT } from "./exit-codes.js";
import { MemoError, type MemoOutcome, runMemo } from "./memo/index.js";
import { MemoValidationError } from "./memo/validate.js";
import { RunError, validateRunId } from "./run.js";
import { runSource, type SourceOutcome } from "./source/index.js";
import { PlanError } from "./source/plan.js";

const TITLE = "investment-pipeline — startup triage";

const SEED_FORMS = `
Seed forms:
  --seed "AI agents for SMBs"     topic query
  --seed ./urls.txt               one URL per line
`;

const EXAMPLES = `
Examples:
  ./pipeline run  --seed "LLM observability" --limit 15
  ./pipeline run  --seed "AI agents" --no-expand
  ./pipeline memo --run 2026-08-22-llm-observability
`;

const EXIT_CODES = `
Exit codes:
  0   success
  1   usage or configuration error
  2   data gap — the run completed but found too little to act on
  3   invariant violation — a contract or citation check failed (ADR-0003)
  70  not implemented yet — a stage this build does not have
`;

const FOOTER = `
Run './pipeline <command> --help' for command options.
`;

/** Commander turns an InvalidArgumentError into a usage error and exit 1. */
function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`expected a positive integer, got '${raw}'`);
  }
  return n;
}

/**
 * Flags shared by the two commands that source candidates. `run` and `source`
 * take the same sourcing options because `run` is `source` plus the two stages
 * after it, not a different program.
 */
function withSourcingOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--seed <input>", "topic query or URL list path — required")
    .option("--limit <n>", "max candidates to carry forward", positiveInt, 15)
    .option("--min-hits <n>", "probe yield below which clarification is offered", positiveInt, 8)
    .option("--query-plan <file>", "use a hand-written plan; skips planning")
    .option("--no-expand", "use the raw seed verbatim; skips planning")
    .option("--since <days>", "source window", positiveInt, 180);
}

/** Every command writes into a run directory, and every command can name it. */
function withRunOptions(cmd: Command, opts: { replay: boolean }): Command {
  cmd.option("--run <id>", "explicit run id (default: date-slug)");
  if (opts.replay) {
    cmd.option("--replay", "reuse cached LLM responses; spends nothing");
  }
  return cmd;
}

/**
 * Scaffolding. Each stage ticket replaces its own call with a real action, and
 * the last one to land takes `EXIT.UNIMPLEMENTED` with it.
 */
function notImplemented(command: string, ticket: string): never {
  process.stderr.write(`pipeline ${command}: not implemented yet (${ticket})\n`);
  process.exit(EXIT.UNIMPLEMENTED);
}

/**
 * The exit-code contract in the `--help` epilogue, applied.
 *
 * A usage error is the operator's invocation — an unusable `--run`, a
 * `--query-plan` that is not there, configuration the run needs and has not
 * got. A data gap is the world being thin, including the source itself being
 * down: `SourceError` covers all three of its kinds, and the message is what
 * distinguishes them because the run's own manifest records which one it was.
 * Anything else is a bug and is allowed to crash with its stack.
 */
function exitFor(error: unknown): number | null {
  if (error instanceof RunError || error instanceof PlanError) return EXIT.USAGE;
  if (error instanceof ConfigError) return EXIT.USAGE;
  if (error instanceof Error && error.name === "SourceError") return EXIT.DATA_GAP;
  // A replay with nothing cached, or a cache entry a moved schema left behind.
  // Both are the operator's invocation rather than the world being thin, and
  // both are fixed by re-issuing the command (`callModel`, rules 3 and 4).
  if (error instanceof Error && error.name === "LlmCallError") return EXIT.USAGE;
  if (error instanceof Error && error.name === "AnalyseError") {
    return (error as { failure?: string }).failure === "no_candidates" ? EXIT.DATA_GAP : EXIT.USAGE;
  }
  // Stage 3's two: a run that is not there or has nothing to render is the
  // operator's, and a memo citing a record that does not exist is ours. The
  // second carries its own code because it is the pipeline's only hard fail
  // (ADR-0003) — a 3 means file a bug, not widen the seed.
  if (error instanceof MemoError) {
    return error.failure === "no_analyses" ? EXIT.DATA_GAP : EXIT.USAGE;
  }
  if (error instanceof MemoValidationError) return error.exit;
  return null;
}

function fail(error: unknown): never {
  const code = exitFor(error);
  if (code === null) throw error;
  process.stderr.write(`pipeline: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(code);
}

/** What a person reads after a run. The manifest is what a reviewer reads. */
function sourceSummary(outcome: SourceOutcome): string {
  const { stage } = outcome;
  const lines = [`run ${outcome.run_id}`];
  if (stage.query) {
    const probe = stage.query.probe;
    const measured = probe ? ` (probe: ${probe.usable} usable of ${probe.hits})` : "";
    lines.push(
      `  query       ${JSON.stringify(stage.query.chosen)} — ${stage.query.chosen_by}${measured}`,
    );
  } else {
    lines.push(
      `  seed        ${outcome.manifest.seed.value} — url list, ` +
        `${stage.filter.usable_posts} usable, ${stage.filter.rejected_posts} rejected`,
    );
  }
  if (stage.search) {
    lines.push(
      `  search      ${stage.search.distinct_posts} posts · ${stage.search.arms.length} arms · ` +
        `${stage.search.pages_fetched} pages · ${stage.search.failures.length} failures`,
    );
  }
  if (stage.fallback) {
    lines.push(
      `  fallback    fired — window widened ${stage.fallback.from_days}d → ${stage.fallback.to_days}d, ` +
        `${stage.fallback.sites_before} → ${stage.fallback.sites_after} sites`,
    );
  }
  if (stage.search) {
    lines.push(
      `  filtered    ${stage.filter.usable_posts} usable, ${stage.filter.rejected_posts} rejected`,
    );
  }
  lines.push(
    `  companies   ${stage.dedup.sites} after dedup` +
      (stage.dedup.sites_with_multiple_posts > 0
        ? ` (${stage.dedup.sites_with_multiple_posts} found more than once)`
        : ""),
  );
  if (stage.resolve) {
    lines.push(
      `  resolved    ${stage.resolve.requests} requests · ${stage.resolve.redirected} redirected · ` +
        `${stage.resolve.unreachable} unreachable`,
    );
  }
  lines.push(`  candidates  ${stage.counts.candidates} → ${outcome.paths.candidates}`);
  lines.push(`  manifest    ${outcome.paths.manifest}`);
  lines.push(`  next        ./pipeline analyse --run ${outcome.run_id}`);
  return `${lines.join("\n")}\n`;
}

interface SourceFlags {
  seed: string;
  limit: number;
  minHits: number;
  since: number;
  expand: boolean;
  queryPlan?: string;
  run?: string;
  replay?: boolean;
}

async function sourceAction(flags: SourceFlags): Promise<void> {
  try {
    const outcome = await runSource({
      seed: flags.seed,
      limit: flags.limit,
      minHits: flags.minHits,
      sinceDays: flags.since,
      expand: flags.expand,
      ...(flags.queryPlan === undefined ? {} : { queryPlanFile: flags.queryPlan }),
      ...(flags.run === undefined ? {} : { runId: flags.run }),
      replay: flags.replay === true,
    });
    process.stdout.write(sourceSummary(outcome));
  } catch (error) {
    fail(error);
  }
}

/**
 * Stage 2's half of the same thing. It leads with what a partner asks first —
 * how many companies, and how they landed — and keeps the failures visible
 * rather than summarising them away: a run where four candidates went `partial`
 * is a run whose memos will be thin, and that should be legible before anybody
 * opens one.
 */
function analyseSummary(outcome: AnalyseOutcome): string {
  const { stage } = outcome;
  const pct = (share: number): string => `${Math.round(share * 100)}%`;
  const lines = [`run ${outcome.run_id}`];

  lines.push(
    `  candidates  ${stage.counts.candidates} read` +
      (stage.input.unparseable > 0 ? ` (${stage.input.unparseable} unreadable line(s))` : ""),
  );
  lines.push(
    `  evidence    ${stage.budget.spent.site?.spent ?? 0} site · ` +
      `${stage.budget.spent.github?.spent ?? 0} github · ${stage.budget.spent.hn?.spent ?? 0} hn requests`,
  );
  lines.push(
    `  facts       ${stage.facts.kept} kept, ${stage.facts.dropped} dropped` +
      (stage.facts.dropped > 0
        ? ` (${Object.entries(stage.facts.dropped_by_kind)
            .map(([kind, count]) => `${count} ${kind}`)
            .join(", ")})`
        : ""),
  );
  lines.push(
    `  model       ${stage.llm.model} · ${stage.llm.calls} call(s), ` +
      `${stage.llm.from_cache} from cache · ` +
      `${stage.llm.cost_usd === null ? "cost unknown" : `$${stage.llm.cost_usd.toFixed(4)}`}`,
  );
  for (const row of stage.candidates) {
    const head = `  ${row.slug.padEnd(20).slice(0, 20)}`;
    lines.push(
      row.score === null
        ? `${head} ${row.status} — ${row.reason ?? "no analysis written"}`
        : `${head} ${row.call} ${row.score}/100 · coverage ${pct(row.coverage ?? 0)}` +
            (row.status === "ok" ? "" : ` · ${row.status}: ${row.reason ?? ""}`),
    );
  }
  lines.push(
    `  status      ${stage.counts.ok} ok · ${stage.counts.partial} partial · ${stage.counts.failed} failed`,
  );
  lines.push(`  analyses    ${stage.counts.analyses} → ${outcome.paths.analysesDir}/`);
  lines.push(`  manifest    ${outcome.paths.manifest}`);
  lines.push(`  next        ./pipeline memo --run ${outcome.run_id}`);
  return `${lines.join("\n")}\n`;
}

async function analyseAction(flags: { run: string; replay?: boolean }): Promise<void> {
  try {
    const outcome = await runAnalyse({
      runId: validateRunId(flags.run),
      replay: flags.replay === true,
    });
    process.stdout.write(analyseSummary(outcome));
  } catch (error) {
    fail(error);
  }
}

/**
 * Stage 3's. It leads with the files, because the thing an operator does next
 * is open one, and it prints the path of every memo rather than the directory:
 * a run of fifteen produces fifteen lines a terminal can click.
 *
 * `unchanged` is not noise. Stage 3 is the command that gets re-run after a
 * template change, and a pass that reports fifteen unchanged memos is the one
 * that says the change did nothing.
 */
function memoSummary(outcome: MemoOutcome): string {
  const { stage } = outcome;
  const lines = [`run ${outcome.run_id}`];
  lines.push(
    `  analyses    ${stage.counts.analyses} read` +
      (stage.input.unreadable > 0 ? ` (${stage.input.unreadable} unreadable file(s))` : ""),
  );
  for (const memo of stage.memos) {
    lines.push(
      `  ${memo.slug.padEnd(20).slice(0, 20)} ${memo.call} ${memo.score}/100 · ` +
        `${memo.citations} citation(s) · ${memo.path}` +
        (memo.written ? "" : " (unchanged)"),
    );
  }
  lines.push(
    `  memos       ${stage.counts.written} written, ${stage.counts.unchanged} unchanged · ` +
      `${stage.counts.citations} citation(s), all resolved`,
  );
  lines.push(`  manifest    ${outcome.paths.manifest}`);
  lines.push(`  next        open ${outcome.paths.memoDir}/`);
  return `${lines.join("\n")}\n`;
}

function memoAction(flags: { run: string }): void {
  try {
    process.stdout.write(memoSummary(runMemo({ runId: validateRunId(flags.run) })));
  } catch (error) {
    fail(error);
  }
}

export function buildProgram(): Command {
  const program = new Command()
    .name("pipeline")
    .usage("<command> [options]")
    .helpOption("-h, --help", "show this")
    .helpCommand(false)
    .addHelpText("before", `\n${TITLE}\n`)
    .addHelpText("after", [SEED_FORMS, EXAMPLES, EXIT_CODES, FOOTER].join(""));

  withRunOptions(
    withSourcingOptions(
      program.command("run").description("Source, analyse and write memos in one pass"),
    ),
    { replay: true },
  ).action(() => notImplemented("run", "TICKET-0027"));

  withRunOptions(
    withSourcingOptions(
      program.command("source").description("Stage 1 only — plan the query and find candidates"),
    ),
    { replay: true },
  ).action(sourceAction);

  program
    .command("analyse")
    .description("Stage 2 only — gather evidence, extract facts, score")
    .requiredOption("--run <id>", "run id to analyse — required")
    .option("--replay", "answer from the caches; makes no request and spends nothing")
    .action(analyseAction);

  // No --replay on memo: stage 3 makes no LLM calls, so there is nothing to
  // replay. See CLAUDE.md invariant 3.
  program
    .command("memo")
    .description("Stage 3 only — render memos (no network, no API calls)")
    .requiredOption("--run <id>", "run id to render — required")
    .action(memoAction);

  return program;
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  return argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href;
}

if (isEntrypoint()) {
  // Only the entrypoint reads `.env`, so importing anything from `src/` leaves
  // the caller's environment alone. Absent is fine — every offline path runs
  // without it (TICKET-0006).
  loadDotEnv();
  // `parseAsync`, because stage 1 is asynchronous and commander would otherwise
  // return before the run finished.
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.stderr.write(`pipeline: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(EXIT.INVARIANT);
    });
}
