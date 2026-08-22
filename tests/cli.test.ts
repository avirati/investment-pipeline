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
  it.each(
    COMMANDS.map(
      (c) => [c, c === "analyse" || c === "memo" ? ["--run", "x"] : ["--seed", "x"]] as const,
    ),
  )("%s exits UNIMPLEMENTED until its stage lands", (command, args) => {
    const { status, stderr } = run([command, ...args]);
    expect(status).toBe(EXIT.UNIMPLEMENTED);
    expect(stderr).toContain("not implemented yet");
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
