import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { EnvSource } from "./config.js";

/**
 * `runs/<run_id>/manifest.json` — the record of how a run happened
 * (ARCHITECTURE §4, TICKET-0012).
 *
 * It is not one of the six stage contracts. Those are how stages talk to *each
 * other*; this is how a run talks to a *reviewer*, and the difference shows in
 * what it is allowed to contain: counts, timings, per-candidate status, and
 * every decision the run took that its outputs do not show. Nothing downstream
 * branches on it.
 *
 * Three rules:
 *
 * 1. **Later stages append, they do not rewrite.** `stages` is a map, one entry
 *    per stage, and `writeStage` merges rather than replacing the file. Stage 2
 *    running twice must not erase how stage 1 got its candidates.
 * 2. **A decision the run took goes in even when it is boring.** The fallback
 *    that did not fire, the arms that returned nothing, the flags as parsed. A
 *    manifest that only records the interesting parts is one a reviewer cannot
 *    use to reproduce the dull ones.
 * 3. **No secrets.** Provider and model names, never keys — the same rule
 *    `src/config.ts` enforces on `LlmConfig.toJSON`.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

/** SPEC §3.1's two seed forms. */
export const SeedForm = z.enum(["topic", "urls"]);
export type SeedForm = z.infer<typeof SeedForm>;

/**
 * The git sha of the code that produced the run, so an output committed to the
 * repo can always be tied to the code that made it. `dirty` is separate and not
 * folded into the sha with a `-dirty` suffix: a reviewer greps for the sha.
 */
export const GitInfo = z.object({
  sha: z.string().nullable(),
  dirty: z.boolean().nullable(),
});
export type GitInfo = z.infer<typeof GitInfo>;

/** What was configured, not what was used — stage 1 may spend no tokens at all. */
export const LlmInfo = z.object({
  provider: z.string().nullable(),
  models: z.record(z.string(), z.string().nullable()),
});
export type LlmInfo = z.infer<typeof LlmInfo>;

/**
 * A stage's own record. Deliberately `unknown` at this boundary: the manifest
 * is an audit trail rather than an interface, and pinning stage 2's shape here
 * before stage 2 exists would be guessing. Each stage parses its own payload —
 * `SourceStage` in `src/source/index.ts` is the first.
 */
export const Manifest = z.object({
  schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
  run_id: z.string().min(1),
  created_at: z.iso.datetime(),
  seed: z.object({ form: SeedForm, value: z.string().min(1) }),
  git: GitInfo,
  llm: LlmInfo,
  /** Prompt file versions the run read. Empty while no prompt is wired. */
  prompt_versions: z.record(z.string(), z.string()),
  stages: z.record(z.string(), z.unknown()),
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * `git rev-parse HEAD` and a porcelain check, or nulls.
 *
 * Shelling out rather than adding a git library: two commands, no dependency,
 * and CLAUDE.md wants a line in an ADR for a runtime dependency. Not being in a
 * git repository is not an error — a run from a downloaded tarball is a real
 * run, it just cannot say which commit made it, and `null` says that.
 */
export function gitInfo(cwd = "."): GitInfo {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const sha = git(["rev-parse", "HEAD"]);
  if (sha === null) return { sha: null, dirty: null };
  const status = git(["status", "--porcelain"]);
  return { sha, dirty: status === null ? null : status.length > 0 };
}

/**
 * Provider and model names as configured, without validating them: stage 1
 * makes no LLM call on the path that does not clarify, and `requireLlmConfig`
 * would fail a run for a variable it will never read (`src/config.ts`).
 */
export function llmInfo(env: EnvSource = process.env): LlmInfo {
  const value = (name: string): string | null => env[name]?.trim() || null;
  return {
    provider: value("LLM_PROVIDER"),
    models: { extract: value("MODEL_EXTRACT"), analyse: value("MODEL_ANALYSE") },
  };
}

export interface NewManifestInput {
  run_id: string;
  created_at: string;
  seed: { form: SeedForm; value: string };
  git?: GitInfo;
  llm?: LlmInfo;
  prompt_versions?: Record<string, string>;
}

export function newManifest(input: NewManifestInput): Manifest {
  return Manifest.parse({
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: input.run_id,
    created_at: input.created_at,
    seed: input.seed,
    git: input.git ?? gitInfo(),
    llm: input.llm ?? llmInfo(),
    prompt_versions: input.prompt_versions ?? {},
    stages: {},
  });
}

/** `null` when there is no manifest yet; a throw when there is one and it is not one. */
export function readManifest(path: string): Manifest | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return Manifest.parse(JSON.parse(raw));
}

/**
 * Overwrites, unlike every other artifact in a run directory. The manifest is
 * the one file that is *supposed* to change as a run proceeds — three stages
 * append to it — so the guard against clobbering is `writeStage` merging what
 * is already there, not the file refusing to be written.
 */
export function writeManifest(path: string, manifest: Manifest): Manifest {
  const validated = Manifest.parse(manifest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

/** Add or replace one stage's record, keeping every other stage's. */
export function writeStage(
  path: string,
  manifest: Manifest,
  stage: string,
  payload: unknown,
): Manifest {
  const existing = readManifest(path);
  const base = existing ?? manifest;
  return writeManifest(path, {
    ...base,
    stages: { ...base.stages, [stage]: payload },
  });
}
