import { z } from "zod";

/** Stage 3's output. Rendered from an `Analysis`; no LLM (CLAUDE.md invariant 3). */
export const MEMO_SCHEMA_VERSION = 1;

export const Memo = z.object({
  schema_version: z.literal(MEMO_SCHEMA_VERSION),
  markdown: z.string().min(1),
  /**
   * Every evidence id the rendered markdown cites. `src/memo/validate.ts`
   * resolves each against the run's evidence store and hard-fails on a miss —
   * the one failure in the pipeline that is a bug rather than a data gap
   * (ADR-0003, ARCHITECTURE §5).
   */
  citations: z.array(z.string().min(1)),
});
export type Memo = z.infer<typeof Memo>;
