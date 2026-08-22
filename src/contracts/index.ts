/**
 * The stage boundary. Stages know about each other through these schemas and
 * nothing else (CLAUDE.md invariant 5).
 *
 * Two conventions hold across all six contracts:
 *
 * 1. **`schema_version` is a required literal, in the file.** Not a default and
 *    not a comment. Cache keys include it, so a bump must invalidate downstream
 *    caches loudly rather than let a stale response survive (CLAUDE.md invariant
 *    6). An artifact written before the field existed fails to parse, which is
 *    the intended behaviour: it is from a different schema.
 *
 * 2. **Nullable, not optional.** A field we have no value for is written as
 *    `null`, not omitted. Unknown is written as unknown (CLAUDE.md invariant 4),
 *    and a committed artifact that records a gap should be distinguishable in a
 *    diff from one that never had the field at all.
 */
export * from "./analysis.js";
export * from "./candidate.js";
export * from "./evidence.js";
export * from "./fact.js";
export * from "./memo.js";
export * from "./parse.js";
export * from "./query-plan.js";
