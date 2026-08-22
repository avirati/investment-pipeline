import { z } from "zod";

/**
 * One retrieval, one record. Written by `src/evidence/store.ts` under
 * `runs/<run_id>/evidence/<id>.json` and committed, so a reviewer can open the
 * exact text the model saw at the moment it saw it (ADR-0003).
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * `sha256(url + retrieved_at)` truncated to 16 hex characters (ADR-0003). The
 * length is pinned here rather than in the store so that "what an id looks
 * like" has one definition; TICKET-0007's helper truncates to match.
 */
export const EVIDENCE_ID_LENGTH = 16;
export const EVIDENCE_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * `fetch_failed` is a member on purpose: a failed fetch is a record, not an
 * absence (ARCHITECTURE §5). It is what lets a memo say "we could not reach
 * their site" with a citation behind it, instead of saying nothing.
 */
export const EvidenceType = z.enum([
  "hn_item",
  "company_site",
  "github_repo",
  "github_user",
  "fetch_failed",
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const Evidence = z.object({
  schema_version: z.literal(EVIDENCE_SCHEMA_VERSION),
  id: z.string().regex(EVIDENCE_ID_PATTERN, "expected a 16-character hex evidence id"),
  url: z.url(),
  type: EvidenceType,
  retrieved_at: z.iso.datetime(),
  /** HTTP status, or 0 when the request never got one (DNS, timeout, abort). */
  status: z.number().int().min(0),
  /** Null rather than absent — see the note on nullability in `index.ts`. */
  title: z.string().nullable(),
  /** Extracted text, truncated by the store. On `fetch_failed`, the reason. */
  text: z.string(),
  /** Adapter-specific extras: stars, points, num_comments, objectID, headers. */
  meta: z.record(z.string(), z.unknown()),
});
export type Evidence = z.infer<typeof Evidence>;
