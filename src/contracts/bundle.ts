import { z } from "zod";
import { Candidate } from "./candidate.js";
import { EVIDENCE_ID_PATTERN } from "./evidence.js";

/**
 * `runs/<run_id>/bundles/<slug>.json` — what stage 2a gathered for one
 * candidate, and therefore what stage 2b was shown (STATE inconsistencies 70
 * and 84).
 *
 * Until this contract existed the `Bundle` was a value passed between two
 * functions inside stage 2 and nothing else. Two things followed from that, and
 * this file exists to end both:
 *
 * 1. **A reviewer could not open one file and see what the model was given.**
 *    It was reconstructible — the analysis's `evidence_ids` plus the store —
 *    but reconstruction is not the same as reading (inconsistency 70).
 * 2. **A replay had to gather again**, which on a fresh clone means fetching,
 *    which means an empty bundle when there is no `.cache/http/` and no
 *    network. That is inconsistency 84, and it destroyed a committed run's
 *    analyses rather than reproducing them.
 *
 * Three rules hold here:
 *
 * - **Evidence is referenced, never copied.** `evidence_ids` holds ids in the
 *   order they were gathered; the text lives once, in `evidence/<id>.json`.
 *   Copying it would double the repo and give a reviewer two texts to
 *   reconcile, and the id is already content-addressed (ADR-0003).
 * - **Order is part of the contract.** `bundleItems` is the extraction prompt's
 *   input and the LLM cache key is a hash over that input, so a bundle
 *   rehydrated in a different order would miss a cache it should hit.
 * - **This is a record of a gather, not a plan for one.** It carries what was
 *   found, what was not (`unknowns`), and what failed (`failures`). Nothing
 *   reads it to decide what to fetch.
 */
export const BUNDLE_SCHEMA_VERSION = 1;

/** Where a resolved company site came from. Mirrors `SiteOrigin`. */
export const BundleSiteOrigin = z.enum(["candidate_url", "github_homepage"]);
export type BundleSiteOrigin = z.infer<typeof BundleSiteOrigin>;

/** Where a resolved GitHub account came from. Mirrors `GithubOrigin`. */
export const BundleGithubOrigin = z.enum(["candidate_url", "site_link"]);
export type BundleGithubOrigin = z.infer<typeof BundleGithubOrigin>;

/** Mirrors `RepoRef` in `src/evidence/github.ts`. */
export const BundleRepoRef = z.object({
  owner: z.string().min(1),
  repo: z.string().nullable(),
  from: z.enum(["github.com", "github.io", "gist"]),
});

/** Mirrors `BundleJoin` — both halves, each with the direction it was made in. */
export const StoredBundleJoin = z.object({
  site: z.object({ url: z.string().min(1), from: BundleSiteOrigin }).nullable(),
  github: z.object({ ref: BundleRepoRef, from: BundleGithubOrigin }).nullable(),
});

/**
 * Mirrors `Signal` in `src/evidence/signal.ts`. `derived_from` stays optional
 * rather than nullable, against the convention in `index.ts`, because it is
 * optional on the in-memory type this serialises and a schema that disagreed
 * with it would fail on every read signal.
 */
export const StoredSignal = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  as_of: z.iso.datetime(),
  evidence_id: z.string().regex(EVIDENCE_ID_PATTERN),
  derived_from: z.string().optional(),
});

/** Mirrors `UnknownSignal`. A metric that could not be produced, and why. */
export const StoredUnknown = z.object({
  key: z.string().min(1),
  reason: z.string(),
});

/** Mirrors `Person` in `src/evidence/site.ts`. */
export const StoredPerson = z.object({
  name: z.string().min(1),
  role: z.string(),
  matched: z.string(),
  context: z.string(),
});

/** Mirrors `GatherFailure`. Data, never a throw (ARCHITECTURE §5). */
export const StoredFailure = z.object({
  pool: z.enum(["github", "site", "hn"]),
  url: z.string().min(1),
  status: z.number().int().min(0),
  reason: z.string(),
});

export const StoredRequestCounts = z.object({
  github: z.number().int().min(0),
  site: z.number().int().min(0),
  hn: z.number().int().min(0),
});

export const StoredBundle = z.object({
  schema_version: z.literal(BUNDLE_SCHEMA_VERSION),
  run_id: z.string().min(1),
  slug: z.string().min(1),
  /** When the gather that produced this finished. Not when the file was written. */
  gathered_at: z.iso.datetime(),
  candidate: Candidate,
  join: StoredBundleJoin,
  /** Rule 1 and rule 2: ids only, in gather order. */
  evidence_ids: z.array(z.string().regex(EVIDENCE_ID_PATTERN)),
  signals: z.array(StoredSignal),
  unknowns: z.array(StoredUnknown),
  people: z.array(StoredPerson),
  requests: StoredRequestCounts,
  failures: z.array(StoredFailure),
});
export type StoredBundle = z.infer<typeof StoredBundle>;
