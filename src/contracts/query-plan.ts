import { z } from "zod";

/**
 * The record of what was searched and who approved it, written once per run to
 * `runs/<run_id>/query_plan.json`. Shape from ADR-0008.
 */
export const QUERY_PLAN_SCHEMA_VERSION = 1;

/**
 * Every row of ADR-0008's context table, so "how did this query get chosen" is
 * answerable from the artifact alone. The hyphen in `non-interactive` and the
 * underscores elsewhere are the ADR's spelling, kept verbatim.
 */
export const ChosenBy = z.enum([
  /** Probe met `--min-hits`; passed through with zero LLM calls. */
  "probe",
  /** A person picked a refinement, kept the original, or typed their own. */
  "user",
  /** Thin probe, no TTY. Raw seed used and the fact recorded. */
  "non-interactive",
  /** The probe request itself failed. Planning is an optimisation, not a gate. */
  "probe_failed",
  /** `--query-plan <file>` — planning skipped entirely. */
  "query_plan_file",
  /** `--no-expand` — raw seed verbatim. */
  "no_expand",
]);
export type ChosenBy = z.infer<typeof ChosenBy>;

/**
 * `usable` is the trigger, not `hits`: the threshold is measured yield, not a
 * model's opinion of the phrasing (ADR-0008). The classifier lives in
 * `src/source/hn.ts`.
 */
export const Probe = z.object({
  hits: z.number().int().min(0),
  usable: z.number().int().min(0),
});
export type Probe = z.infer<typeof Probe>;

export const QueryPlan = z.object({
  schema_version: z.literal(QUERY_PLAN_SCHEMA_VERSION),
  original_seed: z.string().min(1),
  probe: Probe,
  clarified: z.boolean(),
  /** Empty when `clarified` is false. The LLM chooses words; code chooses filters. */
  options_offered: z.array(z.string().min(1)),
  chosen: z.string().min(1),
  chosen_by: ChosenBy,
});
export type QueryPlan = z.infer<typeof QueryPlan>;
