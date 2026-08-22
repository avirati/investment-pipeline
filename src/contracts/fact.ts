import { z } from "zod";

/**
 * The LLM's entire output surface (ADR-0002). A fact is a claim bound to the
 * evidence it came from; the rubric turns facts into numbers, the model never
 * does.
 */
export const FACT_SCHEMA_VERSION = 1;

/** A JSON scalar. Facts are atoms, not nested documents. */
export const FactValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FactValue = z.infer<typeof FactValue>;

export const FactConfidence = z.enum(["high", "medium", "low"]);
export type FactConfidence = z.infer<typeof FactConfidence>;

export const Fact = z.object({
  schema_version: z.literal(FACT_SCHEMA_VERSION),
  /**
   * Stable identifier the rubric matches on, e.g. `founder.prior_exit`. The
   * vocabulary itself is not enumerated here: it belongs to the extraction
   * schema (TICKET-0020) and the rubric (TICKET-0021), and pinning it now would
   * be guessing. This field is an addition to ARCHITECTURE §2's sketch — see
   * that section for why scoring needs something other than prose to switch on.
   */
  key: z.string().min(1),
  /** The human sentence. Read by a partner; never parsed by the rubric. */
  statement: z.string().min(1),
  value: FactValue,
  /**
   * Load-bearing. `.min(1)`, never optional: a fact with no ids fails to parse,
   * and that failure *is* the mechanism by which uncited facts are dropped
   * (ADR-0003, ARCHITECTURE §3). Do not relax this.
   */
  evidence_ids: z.array(z.string().min(1)).min(1),
  confidence: FactConfidence,
});
export type Fact = z.infer<typeof Fact>;
