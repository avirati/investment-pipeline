import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const COMMANDS = ["run", "source", "analyse", "memo"] as const;

const RUN_ID = "2026-08-23-llm-observability";

/** The least a run directory can hold and still be one (`src/manifest.ts`). */
const MANIFEST = `${JSON.stringify(
  {
    schema_version: 1,
    run_id: RUN_ID,
    created_at: "2026-08-23T09:00:00.000Z",
    seed: { form: "topic", value: "llm observability" },
    git: { sha: null, dirty: null },
    llm: { provider: null, models: {} },
    prompt_versions: {},
    stages: {},
  },
  null,
  2,
)}\n`;

describe("pipeline --help", () => {
  const help = execFileSync(TSX, [CLI, "--help"], { encoding: "utf8" });

  it("names every command", () => {
    for (const command of COMMANDS) expect(help).toContain(command);
  });

  it("shows both seed forms where someone will see them (SCOPE #12)", () => {
    expect(help).toContain('--seed "AI agents for SMBs"');
    expect(help).toContain("--seed ./urls.txt");
  });

  it("shows worked examples", () => {
    expect(help).toContain('./pipeline run  --seed "LLM observability" --limit 15');
  });

  it("documents the exit codes", () => {
    for (const code of Object.values(EXIT))
      expect(help).toMatch(new RegExp(`^\\s{2}${code}\\s`, "m"));
  });

  it("does not offer a feed seed form (TICKET-0002)", () => {
    expect(help).not.toContain("--feed");
  });
});

describe("--help on each sub-command", () => {
  it.each(COMMANDS)("%s --help exits 0 and lists its flags", (command) => {
    const { status, stdout } = run([command, "--help"]);
    expect(status).toBe(EXIT.OK);
    expect(stdout).toContain(`Usage: pipeline ${command} [options]`);
    expect(stdout).toContain("--run <id>");
  });

  it("-h is accepted as well as --help", () => {
    expect(run(["-h"]).status).toBe(EXIT.OK);
  });
});

describe("exit codes", () => {
  // `source` left this list at TICKET-0012, and had to: the case below spawns
  // the command for real, so leaving it here would have made the suite fetch
  // from HN Algolia and write a run directory into the repo. Which is what it
  // did for exactly one commit. `analyse` left at 0022, `memo` at 0026, and
  // `run` at TICKET-0027 — which emptied the list and retired the code with
  // it. What is left is the assertion that it stays retired: no command
  // reports itself unimplemented, and 70 is no longer in the contract.
  it("no longer documents an unimplemented exit code", () => {
    const { stdout } = run(["--help"]);
    expect(stdout).not.toMatch(/^\s{2}70\s/m);
    expect(stdout).not.toContain("not implemented");
  });

  it("a missing required flag is a usage error", () => {
    expect(run(["source"]).status).toBe(EXIT.USAGE);
  });

  it("an unknown command is a usage error", () => {
    expect(run(["nonesuch"]).status).toBe(EXIT.USAGE);
  });

  it("a non-numeric --limit is a usage error, not a NaN carried downstream", () => {
    const { status, stderr } = run(["source", "--seed", "x", "--limit", "twelve"]);
    expect(status).toBe(EXIT.USAGE);
    expect(stderr).toContain("positive integer");
  });
});

// Stage 1 is wired (TICKET-0012), and these are the paths that reach an exit
// code without touching the network: the run id is validated before anything is
// created, and a named `--query-plan` that is not there is a usage error.
// Stage 2 is wired (TICKET-0022). Both paths below exit before a request is
// made: the run id is validated first, and a run directory that is not there
// is refused before anything is gathered.
describe("pipeline analyse — offline failure paths", () => {
  it("rejects an unusable --run before it reads anything", () => {
    const r = run(["analyse", "--run", "../escape"]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("not a usable run id");
  });

  it("refuses a run directory stage 1 never made", () => {
    const r = run(["analyse", "--run", "2000-01-01-not-a-real-run"]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("is not a run directory");
  });

  it("still requires a run id", () => {
    expect(run(["analyse"]).status).toBe(EXIT.USAGE);
  });

  it("no longer reports itself unimplemented", () => {
    const r = run(["analyse", "--run", "2000-01-01-not-a-real-run"]);
    expect(r.stderr).not.toContain("not implemented");
  });

  it("advertises a replay that spends nothing", () => {
    const { stdout } = run(["analyse", "--help"]);
    expect(stdout).toContain("--replay");
    expect(stdout).toContain("spends nothing");
    // The other half of the same promise: a replay is safe *because* an
    // ordinary re-run is not, and the flag that overrides that is advertised
    // beside it (STATE inconsistency 84).
    expect(stdout).toContain("--force");
  });
});

// Stage 3 is wired (TICKET-0026), and it is the one command that can be run
// end to end in this file: it makes no request, reads no key, and writes only
// into the temp directory it is pointed at.
describe("pipeline memo", () => {
  it("rejects an unusable --run before it reads anything", () => {
    const r = run(["memo", "--run", "../escape"]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("not a usable run id");
  });

  it("refuses a run directory stage 1 never made", () => {
    const r = run(["memo", "--run", "2000-01-01-not-a-real-run"]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("is not a run directory");
  });

  it("no longer reports itself unimplemented", () => {
    const r = run(["memo", "--run", "2000-01-01-not-a-real-run"]);
    expect(r.stderr).not.toContain("not implemented");
  });

  it("offers no --replay, because stage 3 makes no LLM call", () => {
    expect(run(["memo", "--help"]).stdout).not.toContain("--replay");
  });

  it("renders a run to disk and exits 0, with no key and no network", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cli-memo-"));
    try {
      const golden = fileURLToPath(new URL("./golden/", import.meta.url));
      const runDir = join(cwd, "runs", RUN_ID);
      mkdirSync(join(runDir, "analyses"), { recursive: true });
      mkdirSync(join(runDir, "evidence"), { recursive: true });
      writeFileSync(join(runDir, "manifest.json"), MANIFEST);
      copyFileSync(
        join(golden, "analysis.golden.json"),
        join(runDir, "analyses", "acme-traces.json"),
      );
      for (const record of JSON.parse(
        readFileSync(join(golden, "evidence.golden.json"), "utf8"),
      ) as { id: string }[]) {
        writeFileSync(join(runDir, "evidence", `${record.id}.json`), JSON.stringify(record));
      }

      const r = spawnSync(TSX, [CLI, "memo", "--run", RUN_ID], { encoding: "utf8", cwd });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(EXIT.OK);
      expect(r.stdout).toContain("acme-traces");
      expect(r.stdout).toContain("1 written, 0 unchanged");
      expect(readFileSync(join(cwd, "memos", RUN_ID, "acme-traces.md"), "utf8")).toBe(
        readFileSync(join(golden, "memo.golden.md"), "utf8"),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("pipeline source — offline failure paths", () => {
  it("rejects an unusable --run before it creates or fetches anything", () => {
    const r = run(["source", "--seed", "LLM observability", "--run", "../escape"]);
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("not a usable run id");
  });

  it("still requires a seed", () => {
    expect(run(["source"]).status).toBe(EXIT.USAGE);
  });

  it("no longer reports itself unimplemented", () => {
    const r = run(["source", "--seed", "LLM observability", "--run", "../escape"]);
    expect(r.stderr).not.toContain("not implemented");
  });
});
