import type { z } from "zod";

/**
 * Per-item tolerance for parsing model output. Extraction must drop the facts
 * it cannot validate and keep the rest — one bad citation should not cost a
 * whole candidate — but "dropped at parse time" has to be one behaviour in one
 * place, or it becomes several behaviours in several places (TICKET-0005).
 */

export interface Dropped {
  /** Index in the input array, so a caller can point at the offending item. */
  index: number;
  /** Why it failed, flattened. Recorded, not swallowed — drops are auditable. */
  reason: string;
}

export interface ParseOrDropResult<T> {
  kept: T[];
  dropped: Dropped[];
}

function flatten(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function parseOrDrop<T>(
  schema: z.ZodType<T>,
  items: readonly unknown[],
): ParseOrDropResult<T> {
  const kept: T[] = [];
  const dropped: Dropped[] = [];
  items.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) kept.push(result.data);
    else dropped.push({ index, reason: flatten(result.error) });
  });
  return { kept, dropped };
}
