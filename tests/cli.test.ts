import { execFileSync, spawnSync } from "node:child_process";
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
  // did for exactly one commit. The three that remain still exit before doing
  // anything (CLAUDE.md: never a test that needs the network or a key).
  const UNIMPLEMENTED = ["run", "memo"] as const;

  it.each(UNIMPLEMENTED.map((c) => [c, c === "memo" ? ["--run", "x"] : ["--seed", "x"]] as const))(
    "%s exits UNIMPLEMENTED until its stage lands",
    (command, args) => {
      const { status, stderr } = run([command, ...args]);
      expect(status).toBe(EXIT.UNIMPLEMENTED);
      expect(stderr).toContain("not implemented yet");
    },
  );

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
    expect(r.status).not.toBe(EXIT.UNIMPLEMENTED);
    expect(r.stderr).not.toContain("not implemented");
  });

  it("advertises a replay that spends nothing", () => {
    const { stdout } = run(["analyse", "--help"]);
    expect(stdout).toContain("--replay");
    expect(stdout).toContain("spends nothing");
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
    expect(r.status).not.toBe(EXIT.UNIMPLEMENTED);
    expect(r.stderr).not.toContain("not implemented");
  });
});
