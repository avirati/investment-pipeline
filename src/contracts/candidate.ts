import { z } from "zod";

/** One company carried out of stage 1. Written to `candidates.jsonl`. */
export const CANDIDATE_SCHEMA_VERSION = 1;

/** Fixed by ADR-0004. A URL list is a seed form (SPEC §3.1), not a new source. */
export const CandidateSource = z.enum(["hn", "url_list"]);
export type CandidateSource = z.infer<typeof CandidateSource>;

/**
 * How this candidate came to be looked at. Kept on the candidate rather than
 * only in the manifest so a single JSONL line is self-explanatory.
 */
export const Provenance = z.object({
  source: CandidateSource,
  /** The query as approved in `query_plan.json` — not the raw seed. */
  query: z.string().min(1),
  at: z.iso.datetime(),
  /** Source-native id: an HN `objectID`, or null for a URL-list seed. */
  ref: z.string().nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Candidate = z.object({
  schema_version: z.literal(CANDIDATE_SCHEMA_VERSION),
  /** Filename-safe; the analysis and memo for this candidate are named by it. */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase kebab-case slug"),
  name: z.string().min(1),
  url: z.url(),
  one_liner: z.string(),
  provenance: Provenance,
});
export type Candidate = z.infer<typeof Candidate>;
