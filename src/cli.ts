#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { EXIT } from "./exit-codes.js";

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
  ).action(() => notImplemented("source", "TICKET-0012"));

  program
    .command("analyse")
    .description("Stage 2 only — gather evidence, extract facts, score")
    .requiredOption("--run <id>", "run id to analyse — required")
    .option("--replay", "reuse cached LLM responses; spends nothing")
    .action(() => notImplemented("analyse", "TICKET-0022"));

  // No --replay on memo: stage 3 makes no LLM calls, so there is nothing to
  // replay. See CLAUDE.md invariant 3.
  program
    .command("memo")
    .description("Stage 3 only — render memos (no network, no API calls)")
    .requiredOption("--run <id>", "run id to render — required")
    .action(() => notImplemented("memo", "TICKET-0026"));

  return program;
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  return argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href;
}

if (isEntrypoint()) {
  buildProgram().parse(process.argv);
}
