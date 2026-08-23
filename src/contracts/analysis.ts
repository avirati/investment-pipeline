import { z } from "zod";
import { Candidate } from "./candidate.js";
import { Fact } from "./fact.js";

/**
 * Stage 2's output, written to `runs/<run_id>/analyses/<slug>.json`.
 *
 * **2** — added `status`, `status_reason` and `inputs` (TICKET-0022). v1 could
 * not tell a candidate the model failed to answer about from one there was
 * nothing to find about: both arrive here as zero facts, and both score 25 with
 * 0% coverage. Stage 3 has no LLM and may not guess (CLAUDE.md invariant 3), so
 * the difference has to be written down by the stage that saw it.
 */
export const ANALYSIS_SCHEMA_VERSION = 2;

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

/**
 * Whether this analysis is the full reading or a degraded one.
 *
 * There is no `failed`: a candidate that failed outright has no analysis file
 * at all, and its status is in the run manifest. What reaches this schema has
 * dimensions, a score and a call — the question is only how much it was allowed
 * to see.
 */
export const AnalysisStatus = z.enum(["ok", "partial"]);
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

/** Why extraction produced what it produced. Mirrors `ExtractResult.status`. */
export const ExtractionStatus = z.enum(["ok", "partial", "no_evidence"]);
export type ExtractionStatus = z.infer<typeof ExtractionStatus>;

/**
 * What this analysis was computed from — the counts a reader needs to tell a
 * thin company from a thin *reading* of a company.
 *
 * It is not a second copy of the manifest. The manifest is the run's audit
 * trail and nothing downstream branches on it; this travels with the candidate,
 * because the memo for one company must be renderable from that company's
 * analysis alone (ARCHITECTURE §1).
 */
export const AnalysisInputs = z.object({
  /** Records gathered, including the failed ones — they are evidence too. */
  evidence_records: z.number().int().min(0),
  /** Records with text the model could actually be shown. */
  evidence_usable: z.number().int().min(0),
  /** Fetches that produced no readable record. Coverage, not rejection. */
  gather_failures: z.number().int().min(0),
  extraction: z.object({
    status: ExtractionStatus,
    /** 0, 1 or 2 — larger than the calls that answered, when one failed. */
    attempts: z.number().int().min(0),
    facts: z.number().int().min(0),
    /** Facts the model produced and the parser refused (ADR-0003). */
    dropped: z.number().int().min(0),
    dropped_by_kind: z.record(z.string(), z.number().int().min(0)),
    /** Set only when `status` is not `ok`. The sentence a memo may print. */
    error: z.string().min(1).nullable(),
  }),
});
export type AnalysisInputs = z.infer<typeof AnalysisInputs>;

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
  status: AnalysisStatus,
  /**
   * One sentence saying why the status is not `ok`, written by stage 2 and
   * printed verbatim by stage 3. `null` when it is `ok` — nullable rather than
   * optional, so a gap is visible in a diff (contracts convention 2).
   */
  status_reason: z.string().min(1).nullable(),
  inputs: AnalysisInputs,
});
export type Analysis = z.infer<typeof Analysis>;
