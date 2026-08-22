import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type Probe, QUERY_PLAN_SCHEMA_VERSION, QueryPlan } from "../contracts/index.js";
import { type HttpOptions, httpGet } from "../evidence/fetch.js";
import {
  type ClassifiedHit,
  classifyHits,
  HN_HITS_PER_PAGE,
  hnSearchUrl,
  parseSearchResponse,
} from "./hn.js";

/**
 * Query planning (TICKET-0011), the shape ADR-0008 decided: **probe, then
 * clarify**. Read that ADR before changing anything here — it is the more
 * delicate half of stage 1, and it is the one place a person approves what gets
 * searched before any money is spent.
 *
 * ```
 * seed ──► probe: raw seed against HN Algolia          no LLM, one request
 *           │
 *           ├─ usable ≥ --min-hits ──────► pass through, zero LLM calls
 *           │
 *           └─ below threshold ──────────► the model proposes 3–4 refinements,
 *                                          a person picks one
 * ```
 *
 * Four rules hold in this file:
 *
 * 1. **The LLM chooses words. Code chooses filters.** Nothing a model returns
 *    reaches a tag, a date window, a page number or a hit count. It reaches
 *    `query=` and nothing else, and `sanitiseOptions` below is where that is
 *    enforced rather than assumed (ADR-0008, CLAUDE.md invariant 1).
 *
 * 2. **The trigger is measured yield, not a model's opinion of the phrasing.**
 *    `usable` is `classifyHits(...).usable.length` from TICKET-0009 — the count
 *    D-6's threshold is defined in terms of, and one that errs generous.
 *
 * 3. **Planning is an optimisation, never a gate.** Every failure path here —
 *    a dead probe request, a clarifier that throws, no TTY, no provider wired —
 *    ends with the raw seed and a `chosen_by` that says which one happened. A
 *    thin seed is a worse run; a failed plan must not be no run at all.
 *
 * 4. **It never prompts twice.** A `query_plan.json` already on disk is the
 *    answer, so a replay reads it rather than asking a person again.
 *
 * The clarifier itself is a seam, not a call: `Clarifier` and `Chooser` are
 * injected. TICKET-0018 (the provider factory) supplies the first and the
 * interactive select supplies the second. Until both are wired, a thin probe
 * takes the no-TTY path, which is what TICKET-0011's sequencing note asks for.
 */

/** D-6. A guess, labelled as one, and now measurable against a real result set. */
export const DEFAULT_MIN_HITS = 8;

/**
 * A refinement is a search query, not a paragraph. Long strings narrow Algolia
 * hard — every word has to match — so a model that answers with a sentence has
 * misunderstood the task and its answer is dropped rather than searched.
 */
export const MAX_OPTION_LENGTH = 120;

/** ADR-0008 says 3–4 refinements. Extra proposals are truncated, not offered. */
export const MAX_OPTIONS_OFFERED = 4;

/** A usage error: a file the operator named that cannot be used. Exit 1. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

// ---------------------------------------------------------------------------
// The probe. One request, no LLM, and the only measurement the threshold reads.
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  /** `--since`, passed through so the probe measures the window the run uses. */
  sinceDays?: number;
  hitsPerPage?: number;
  /** Passed to `httpGet` — transport, cache dir, clock, retry policy. */
  http?: HttpOptions;
  now?: () => Date;
}

export type ProbeOutcome =
  | {
      ok: true;
      url: string;
      probe: Probe;
      usable: ClassifiedHit[];
      /** Kept so a thin probe can explain *why* it was thin, not just that it was. */
      rejected: ClassifiedHit[];
    }
  | { ok: false; url: string; status: number; reason: string };

/**
 * The raw seed against HN Algolia, page 0, relevance-ranked, `story` tagged.
 *
 * Deliberately *not* the four expansion arms from `expandQuery`. The probe asks
 * "does the seed as the operator typed it already work?", and running the arms
 * would answer a different question — it would measure the expansion's yield
 * and then offer to fix a seed that was never the problem.
 *
 * `hits` counts the hits on the page the probe actually read, so `usable` is a
 * subset of it. Algolia's `nbHits` is a total for a result set nobody looked at
 * and would make the ratio meaningless.
 */
export async function probeSeed(seed: string, options: ProbeOptions = {}): Promise<ProbeOutcome> {
  const { sinceDays, hitsPerPage = HN_HITS_PER_PAGE, http = {}, now = () => new Date() } = options;

  const url = hnSearchUrl(
    {
      query: seed.trim(),
      tags: "story",
      page: 0,
      hitsPerPage,
      ...(sinceDays === undefined ? {} : { sinceDays }),
    },
    now(),
  );

  const result = await httpGet(url, http);
  if (!result.ok) return { ok: false, url, status: result.status, reason: result.reason };

  let page: ReturnType<typeof parseSearchResponse>;
  try {
    page = parseSearchResponse(JSON.parse(result.body));
  } catch (error) {
    // A 200 carrying something that is not a search response is the same class
    // of problem as a 500, and is recorded the same way.
    return {
      ok: false,
      url,
      status: result.status,
      reason: `unreadable response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const { usable, rejected } = classifyHits(page.hits);
  return {
    ok: true,
    url,
    probe: { hits: page.hits.length, usable: usable.length },
    usable,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// The clarifier seam. Two injected functions, neither of which this module
// implements — TICKET-0011's sequencing note is explicit that an LLM call must
// not be stubbed in here.
// ---------------------------------------------------------------------------

/** What the model is shown: the thin result set, and nothing it could act on. */
export interface ClarifierInput {
  seed: string;
  probe: Probe;
  /**
   * A sample of what the probe returned, usable and rejected alike, so the
   * model can explain why the seed underperformed rather than guess at intent.
   */
  sample: { title: string | null; url: string | null; usable: boolean; reason: string }[];
}

/** Returns 3–4 candidate rephrasings. Words only; see `sanitiseOptions`. */
export type Clarifier = (input: ClarifierInput) => Promise<string[]>;

/**
 * Puts the options in front of a person and returns what they chose — one of
 * the options, the original seed, or something they typed. Cancellation is the
 * implementation's problem: it returns the original seed, because "keep the
 * original" is one of the choices offered.
 */
export type Chooser = (input: { seed: string; options: string[] }) => Promise<string>;

/**
 * One proposal, reduced to something safe to put in a url and in a committed
 * artifact: control characters and newlines collapse to spaces, runs of
 * whitespace collapse to one, and anything empty or longer than
 * `MAX_OPTION_LENGTH` is dropped rather than truncated — a half-sentence is a
 * worse query than the seed it was meant to improve.
 */
export function cleanOption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // `\p{C}` is Unicode's "other" category: control, format and surrogate
  // characters, newlines included. Written as a property escape rather than a
  // literal range because a source file with a NUL byte in it is its own bug.
  const cleaned = raw
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || cleaned.length > MAX_OPTION_LENGTH) return null;
  return cleaned;
}

/**
 * The narrowing this module does to model output, and the reason rule 1 above
 * is a property rather than a hope: a proposal is a trimmed single line of at
 * most `MAX_OPTION_LENGTH` characters, deduped case-insensitively, never equal
 * to the seed (the chooser offers "keep the original" itself), and at most
 * `MAX_OPTIONS_OFFERED` of them survive.
 *
 * Newlines and control characters go because the value ends up in a url query
 * parameter and in a committed artifact; a proposal spanning three lines is
 * either a model explaining itself or a model trying to be a filter.
 */
export function sanitiseOptions(raw: unknown, seed: string): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>([seed.trim().toLowerCase()]);
  const options: string[] = [];

  for (const item of raw) {
    const cleaned = cleanOption(item);
    if (cleaned === null) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(cleaned);
    if (options.length >= MAX_OPTIONS_OFFERED) break;
  }
  return options;
}

// ---------------------------------------------------------------------------
// The artifact. `runs/<run_id>/query_plan.json`, read before it is written.
// ---------------------------------------------------------------------------

/**
 * A hand-written `--query-plan` file. `chosen` is the only thing it must say;
 * everything else about the plan is a record of a decision this file *is*.
 *
 * A file carrying `schema_version` is held to the full contract instead, so a
 * plan from an older schema fails loudly rather than being read as a stub and
 * silently stripped of its probe (CLAUDE.md invariant 6).
 */
const HandWrittenPlan = z.object({
  original_seed: z.string().min(1).optional(),
  chosen: z.string().min(1),
  options_offered: z.array(z.string().min(1)).optional(),
});

function parsePlanJson(raw: string, path: string, seed: string | null): QueryPlan {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new PlanError(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  const full = QueryPlan.safeParse(json);
  if (full.success) return full.data;

  const versioned =
    typeof json === "object" && json !== null && "schema_version" in (json as object);
  if (versioned) {
    throw new PlanError(
      `${path} is not a query plan this build can read ` +
        `(expected schema_version ${QUERY_PLAN_SCHEMA_VERSION}): ${full.error.issues[0]?.message}`,
    );
  }

  const stub = HandWrittenPlan.safeParse(json);
  if (!stub.success) {
    throw new PlanError(`${path} is not a query plan: ${stub.error.issues[0]?.message}`);
  }
  return QueryPlan.parse({
    schema_version: QUERY_PLAN_SCHEMA_VERSION,
    original_seed: stub.data.original_seed ?? seed ?? stub.data.chosen,
    // No probe ran: the operator handed the run its query. Not a zero (invariant 4).
    probe: null,
    clarified: false,
    options_offered: stub.data.options_offered ?? [],
    chosen: stub.data.chosen,
    chosen_by: "query_plan_file",
  });
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlanError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

/**
 * The run's own plan. `null` when there is none, which is the ordinary first
 * run; anything else on disk is either the plan or an error, never a partial
 * re-plan.
 */
export function readQueryPlan(path: string): QueryPlan | null {
  const raw = readFileOrNull(path);
  return raw === null ? null : parsePlanJson(raw, path, null);
}

/** `--query-plan <file>`. A named file that is not there is a usage error. */
export function loadQueryPlanFile(path: string, seed: string): QueryPlan {
  const raw = readFileOrNull(path);
  if (raw === null) throw new PlanError(`no query plan at ${path}`);
  return parsePlanJson(raw, path, seed);
}

/**
 * Written with `wx`: the read above is what stops a replay from re-planning,
 * and this is what stops two processes racing to answer the same question
 * differently. ADR-0001 names refusing to overwrite as the concurrency guard.
 */
export function writeQueryPlan(path: string, plan: QueryPlan): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PlanError(`${path} already exists — refusing to overwrite a decided plan`);
    }
    throw error;
  }
  return path;
}

// ---------------------------------------------------------------------------
// The whole decision, in ADR-0008's order.
// ---------------------------------------------------------------------------

export interface PlanQueryOptions {
  /** `--min-hits`. Usable hits at or above which the seed passes through. */
  minHits?: number;
  /** `--no-expand`. False uses the seed verbatim and skips the probe entirely. */
  expand?: boolean;
  /** `--query-plan <file>`. */
  planFile?: string;
  /** The run's own `query_plan.json`: read instead of planning, then written. */
  planPath?: string;
  clarifier?: Clarifier;
  chooser?: Chooser;
  /** Defaults to a real TTY check on both ends of the pipe. */
  isInteractive?: () => boolean;
  probe?: ProbeOptions;
  /** How many of the probe's hits the clarifier is shown. */
  sampleSize?: number;
}

export interface PlanResult {
  plan: QueryPlan;
  /** True when the plan was already on disk — a replay, which never re-prompts. */
  replayed: boolean;
  /** Where it lives, or null when the caller asked for no artifact. */
  path: string | null;
}

function ttyPresent(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * A refinement, or a person's own words, or the seed. Whatever it is, it is a
 * search query in the end, so it goes through the same narrowing as the
 * proposals did — a chooser that returns junk falls back to the seed rather
 * than putting junk in a url.
 */
function chosenOrSeed(chosen: unknown, seed: string): string {
  return cleanOption(chosen) ?? seed;
}

/**
 * Resolve the query this run will search for, and record how it was resolved.
 *
 * The order of the branches is ADR-0008's context table, top to bottom, and the
 * first row is the replay guard: an existing plan wins over `--query-plan` and
 * over `--no-expand`, because a decided run is a decided run and re-answering
 * it would make the committed artifact a lie.
 */
export async function planQuery(seed: string, options: PlanQueryOptions = {}): Promise<PlanResult> {
  const {
    minHits = DEFAULT_MIN_HITS,
    expand = true,
    planFile,
    planPath,
    clarifier,
    chooser,
    isInteractive = ttyPresent,
    probe: probeOptions = {},
    sampleSize = 10,
  } = options;

  const trimmed = seed.trim();
  if (trimmed.length === 0) throw new PlanError("empty seed — nothing to plan");

  if (planPath) {
    const existing = readQueryPlan(planPath);
    if (existing) return { plan: existing, replayed: true, path: planPath };
  }

  /**
   * Re-parsed on the way out rather than trusted: on the clarified path both
   * `chosen` and `options_offered` started life outside this process, and the
   * contract is the thing that says what a plan is (CLAUDE.md invariant 5).
   */
  const settle = (draft: QueryPlan): PlanResult => {
    const plan = QueryPlan.parse(draft);
    if (!planPath) return { plan, replayed: false, path: null };
    return { plan, replayed: false, path: writeQueryPlan(planPath, plan) };
  };

  if (planFile) return settle(loadQueryPlanFile(planFile, trimmed));

  const base = {
    schema_version: QUERY_PLAN_SCHEMA_VERSION,
    original_seed: trimmed,
    clarified: false,
    options_offered: [] as string[],
    chosen: trimmed,
  } as const;

  if (!expand) {
    return settle({ ...base, probe: null, chosen_by: "no_expand" });
  }

  const outcome = await probeSeed(trimmed, probeOptions);
  if (!outcome.ok) {
    // Planning is an optimisation, not a gate (rule 3). The run continues on
    // the raw seed and the artifact says the measurement never happened.
    return settle({ ...base, probe: null, chosen_by: "probe_failed" });
  }

  if (outcome.probe.usable >= minHits) {
    return settle({ ...base, probe: outcome.probe, chosen_by: "probe" });
  }

  // Below threshold. Clarification needs a person *and* a model; missing either
  // is the same outcome — nobody was asked, and the seed goes through as typed.
  const thin = { ...base, probe: outcome.probe, chosen_by: "non-interactive" } as const;
  if (!clarifier || !chooser || !isInteractive()) return settle(thin);

  const sample = [...outcome.usable, ...outcome.rejected].slice(0, sampleSize).map((entry) => ({
    title: entry.hit.title,
    url: entry.hit.url,
    usable: entry.classification.usable,
    reason: entry.classification.reason,
  }));

  let offered: string[];
  try {
    offered = sanitiseOptions(
      await clarifier({ seed: trimmed, probe: outcome.probe, sample }),
      trimmed,
    );
  } catch {
    // A provider outage must not cost the run. Recorded as the same "nobody was
    // asked" outcome, which inconsistency 29 in STATE.md flags as doing three
    // jobs with one enum value.
    return settle(thin);
  }
  if (offered.length === 0) return settle(thin);

  let chosen: string;
  try {
    chosen = chosenOrSeed(await chooser({ seed: trimmed, options: offered }), trimmed);
  } catch {
    return settle(thin);
  }

  return settle({
    ...base,
    probe: outcome.probe,
    clarified: true,
    options_offered: offered,
    chosen,
    chosen_by: "user",
  });
}
