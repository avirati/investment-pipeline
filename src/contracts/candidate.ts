import { z } from "zod";

/** One company carried out of stage 1. Written to `candidates.jsonl`. */
export const CANDIDATE_SCHEMA_VERSION = 2;

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
  /**
   * When this run sourced the candidate, not when the post was made. The two
   * are separate fields because `created_at` can be absent on a hit and `at`
   * can not: dating a candidate by the run clock is a fact about the run, while
   * writing the run clock into `posted_at` would be inventing a post date.
   */
  at: z.iso.datetime(),
  /** Source-native id: an HN `objectID`, or null for a URL-list seed. */
  ref: z.string().nullable(),
  /**
   * The post title, verbatim. What `name` and `one_liner` were derived from
   * (`src/source/candidate.ts`), so the hand-check at TICKET-0013 can see the
   * input beside the output. Null when the source carried no title.
   */
  title: z.string().nullable(),
  /** The link as submitted, before canonicalisation and redirect resolution. */
  posted_url: z.url(),
  /** When the post was made. Null when the source did not say (invariant 4). */
  posted_at: z.iso.datetime().nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

/**
 * Every post that pointed at this company, **primary first**.
 *
 * Dedup produces a group, not a post (TICKET-0010): two Show HNs about one
 * company collapse to one candidate, and a singular `provenance` could only
 * record one of them — the contract would quietly delete the evidence that the
 * collapse happened at all. Version 1 of this schema had that defect; it is
 * STATE.md inconsistency 25 and this is the fix.
 *
 * A tuple rather than `z.array(...).min(1)` so the *type* carries the guarantee
 * the schema enforces: `provenance[0]` is the primary post and needs no
 * undefined check under `noUncheckedIndexedAccess`. It serialises as an
 * ordinary JSON array. "Primary" is `src/source/resolve.ts`'s ranking — highest
 * points, earliest post breaking the tie — and the candidate's `url` is that
 * post's link, so the two must not be reordered independently.
 */
export const ProvenanceList = z.tuple([Provenance]).rest(Provenance);
export type ProvenanceList = z.infer<typeof ProvenanceList>;

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
  provenance: ProvenanceList,
});
export type Candidate = z.infer<typeof Candidate>;
