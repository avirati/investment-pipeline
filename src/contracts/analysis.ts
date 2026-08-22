import { z } from "zod";
import { Candidate } from "./candidate.js";
import { Fact } from "./fact.js";

/** Stage 2's output, written to `runs/<run_id>/analyses/<slug>.json`. */
export const ANALYSIS_SCHEMA_VERSION = 1;

/**
 * The pipeline's output vocabulary (SPEC §3). It lives here, once, because
 * stage 2 produces it and stage 3 renders it. The *thresholds* that map a score
 * to one of these stay in `src/analyse/score.ts` — see the note below.
 */
export const Call = z.enum(["PASS", "WATCH", "TAKE_A_MEETING"]);
export type Call = z.infer<typeof Call>;

/**
 * Note on `id` and `max` being loosely typed here: dimension ids, their weights
 * and the four disqualifier ids are *the thesis*, and CLAUDE.md invariant 7 puts
 * the thesis in exactly one place — the rubric in `src/analyse/score.ts`.
 * Restating `D1 = 25 pts` in the contract would make this the second place, and
 * the two would drift. The contract pins the shape; the rubric owns the content.
 */
export const Dimension = z.object({
  /** `D1`–`D5`. Vocabulary owned by the rubric (SPEC §2). */
  id: z.string().min(1),
  name: z.string().min(1),
  score: z.number().int().min(0),
  max: z.number().int().positive(),
  /** The band the score came from, so the number is recomputable by hand. */
  band: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)),
  /**
   * False means no primary source backed this dimension. It then sits at its
   * band floor and drags coverage down — it is never zeroed or omitted
   * (CLAUDE.md invariant 4, SPEC §2).
   */
  covered: z.boolean(),
});
export type Dimension = z.infer<typeof Dimension>;

/**
 * A disqualifier forces PASS regardless of score (SPEC §1.1), so it is the one
 * place where the schema is stricter than a `Fact`: `.min(1)` evidence ids,
 * because we do not pass on inference.
 */
export const Disqualifier = z.object({
  /** `D-1`–`D-4`. Vocabulary owned by the rubric (SPEC §1.1). */
  id: z.string().min(1),
  statement: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)).min(1),
});
export type Disqualifier = z.infer<typeof Disqualifier>;

export const Analysis = z.object({
  schema_version: z.literal(ANALYSIS_SCHEMA_VERSION),
  candidate: Candidate,
  facts: z.array(Fact),
  dimensions: z.array(Dimension),
  /** Arithmetic over `dimensions` (SPEC §4 hard rule 3), not a model's number. */
  score: z.number().int().min(0).max(100),
  /** Share of dimensions with a primary source behind them, 0–1. 0.6 is the gate. */
  coverage: z.number().min(0).max(1),
  disqualifiers: z.array(Disqualifier),
  call: Call,
  /** Written out as unknowns, never smoothed into prose (SPEC §4 hard rule 4). */
  unknowns: z.array(z.string().min(1)),
});
export type Analysis = z.infer<typeof Analysis>;
