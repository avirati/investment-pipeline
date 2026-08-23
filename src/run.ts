import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Run identity and the run directory (TICKET-0012).
 *
 * A run id is the only handle the three stages share: `./pipeline source`
 * mints one, `analyse` and `memo` are given it with `--run`, and every artifact
 * in ARCHITECTURE §4 is named by it. So the rules live here rather than in the
 * stage that happens to need them first:
 *
 * 1. **An id is a directory name, and is treated as one.** Lowercase kebab
 *    only — no separators, no dots, no capitals. A run id built from operator
 *    input reaches `mkdir` and `join`, and "sanitise it at the edge" is only
 *    true if there is one edge.
 * 2. **A run directory is created, never opened.** Refusing to overwrite is
 *    ADR-0001's concurrency guard: two `source` runs racing on one id would
 *    interleave their candidates and the manifest would describe neither.
 *    `--replay` is the one caller that may reuse a directory, because a replay
 *    is by definition a second look at a decided run.
 * 3. **`memos/` is not inside `runs/`.** ARCHITECTURE §6 puts rendered memos at
 *    `memos/<run_id>/` — they are the output a human reads, not a run artifact —
 *    and this module is where that split is written down once.
 */

/** ARCHITECTURE §6. Committed, so both are repo-relative by default. */
export const RUNS_ROOT = "runs";
export const MEMOS_ROOT = "memos";

/**
 * The date part is `YYYY-MM-DD` and the rest is the seed, so `ls runs/` reads
 * like a lab notebook. UTC, not local time: the same seed run from two
 * timezones on the same day should collide (that is the guard doing its job)
 * rather than produce two directories that look like two experiments.
 */
export const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Long enough for a real topic — "llm observability for agents" fits — and
 * short enough that `runs/<id>/evidence/<sha>.json` stays a readable path.
 */
export const MAX_SEED_SLUG_LENGTH = 48;

/** A seed of nothing but punctuation still has to produce a directory name. */
export const FALLBACK_SLUG = "run";

/** A usage error: an id the operator gave that cannot be used. Exit 1. */
export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunError";
  }
}

/**
 * Text to a filename-safe kebab slug: everything that is not `a-z` or `0-9`
 * becomes a separator, runs collapse, and the result is cut to
 * `MAX_SEED_SLUG_LENGTH` **at a word boundary** rather than mid-word, so a
 * truncated id still reads as words.
 *
 * Deliberately ASCII-only. A seed in another script would otherwise produce a
 * directory name that is correct, unreadable in a `ls`, and different depending
 * on which Unicode normalisation the shell used; those runs get
 * `FALLBACK_SLUG` and an explicit `--run` is the escape hatch.
 */
export function slugify(text: string): string {
  const kebab = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (kebab.length <= MAX_SEED_SLUG_LENGTH) return kebab;
  const cut = kebab.slice(0, MAX_SEED_SLUG_LENGTH + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, MAX_SEED_SLUG_LENGTH)).replace(
    /-+$/,
    "",
  );
}

/** `2026-08-22`, UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * `<utc-day>-<seed-slug>`, which is the form `--help` has advertised since
 * TICKET-0003 (`./pipeline memo --run 2026-08-22-llm-observability`).
 *
 * Derived from the seed as typed, not from the query the planner chose: the id
 * is minted before `planQuery` runs — the plan is written *into* the run
 * directory — and an id that changed when a person picked a refinement would
 * mean the artifact could not be filed under the run that produced it.
 */
export function deriveRunId(seed: string, now: Date): string {
  const slug = slugify(seed);
  return `${utcDay(now)}-${slug.length > 0 ? slug : FALLBACK_SLUG}`;
}

/**
 * An operator-supplied `--run`. Rejected rather than sanitised: silently
 * rewriting `../../etc` into something safe would make `--run` name one
 * directory and write to another, and the operator would not be told.
 *
 * Uppercase is rejected too, which is not paranoia about paths but about
 * filesystems: `Runs-A` and `runs-a` are one directory on macOS and two on
 * Linux, and a run id that means different things on two machines is not an id.
 */
export function validateRunId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) throw new RunError("empty run id");
  if (!RUN_ID_PATTERN.test(trimmed)) {
    throw new RunError(
      `'${trimmed}' is not a usable run id — lowercase letters, digits and single hyphens only`,
    );
  }
  return trimmed;
}

/** `--run <id>` when given, the date-and-seed slug otherwise. */
export function resolveRunId(options: { explicit?: string; seed: string; now?: Date }): string {
  const { explicit, seed, now = new Date() } = options;
  return explicit === undefined ? deriveRunId(seed, now) : validateRunId(explicit);
}

/**
 * Every path a run owns, in one place. Stages take these rather than joining
 * strings themselves, so the layout in ARCHITECTURE §4 has exactly one
 * definition in code.
 */
export interface RunPaths {
  id: string;
  dir: string;
  manifest: string;
  queryPlan: string;
  candidates: string;
  /** Stage 2a's record of what each candidate was gathered from (STATE 70, 84). */
  bundlesDir: string;
  evidenceDir: string;
  analysesDir: string;
  /** Outside `runs/` — see rule 3 above. */
  memoDir: string;
}

export function runPaths(id: string, root = "."): RunPaths {
  const dir = join(root, RUNS_ROOT, id);
  return {
    id,
    dir,
    manifest: join(dir, "manifest.json"),
    queryPlan: join(dir, "query_plan.json"),
    candidates: join(dir, "candidates.jsonl"),
    bundlesDir: join(dir, "bundles"),
    evidenceDir: join(dir, "evidence"),
    analysesDir: join(dir, "analyses"),
    memoDir: join(root, MEMOS_ROOT, id),
  };
}

export interface CreateRunDirOptions {
  root?: string;
  /**
   * `--replay`. A replay is a second look at a run that already happened, so
   * its directory is expected to be there; without the flag an existing
   * directory is the collision the guard exists to catch.
   */
  allowExisting?: boolean;
}

/**
 * Create `runs/<id>/`, or refuse.
 *
 * `mkdir` without `recursive` is the guard itself rather than a check before
 * one: `existsSync` then `mkdirSync` is two syscalls with a race between them,
 * and the race is exactly the case ADR-0001 names — two `source` invocations
 * starting at the same second on the same seed. The parent `runs/` is created
 * recursively because a missing `runs/` is a fresh clone, not a collision.
 */
export function createRunDir(id: string, options: CreateRunDirOptions = {}): RunPaths {
  const { root = ".", allowExisting = false } = options;
  const paths = runPaths(id, root);
  mkdirSync(join(root, RUNS_ROOT), { recursive: true });
  try {
    mkdirSync(paths.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!allowExisting) {
      throw new RunError(
        `${paths.dir} already exists — refusing to overwrite a run. ` +
          `Pass --run <id> for a new one, or --replay to reuse this one`,
      );
    }
  }
  return paths;
}
