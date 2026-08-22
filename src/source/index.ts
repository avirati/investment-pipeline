import { readFileSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { EnvSource } from "../config.js";
import type { Candidate, QueryPlan } from "../contracts/index.js";
import type { HttpOptions } from "../evidence/fetch.js";
import { llmInfo, type Manifest, newManifest, writeStage } from "../manifest.js";
import { createRunDir, type RunPaths, resolveRunId } from "../run.js";
import { candidatesFromUrls, parseUrlList, toCandidates } from "./candidate.js";
import { classifyHits, type HnSearchResult, type QueryExpansion, searchHn } from "./hn.js";
import { type Chooser, type Clarifier, planQuery } from "./plan.js";
import {
  dedupeHits,
  type ResolvedSite,
  type ResolvedSiteWithRedirect,
  resolveSites,
  strongerPost,
} from "./resolve.js";

/**
 * Stage 1, wired (TICKET-0012). `./pipeline source` is this function plus
 * argument parsing.
 *
 * ```
 * seed ─► run id ─► run dir ─► planQuery ─► searchHn ─► dedupeHits
 *                                                          │
 *            candidates.jsonl ◄─ toCandidates ◄─ resolveSites ◄─ --limit ◄─ rank
 * ```
 *
 * The ordering is the ticket's third owed item and it is load-bearing:
 * **dedup, then rank, then cut, then resolve.** Redirect resolution is one
 * request per *company*, so cutting before it is what keeps a 200-post result
 * set to a `--limit`-sized number of requests rather than 200. Ranking before
 * cutting is the fix the first live run forced — see `rankSites`.
 *
 * This is also the layer ARCHITECTURE §5 was waiting for. `searchHn` returns
 * failures as data because one dead page among eight is not a dead run; this
 * function is the only one that can see the whole picture, so it is where "the
 * source produced nothing at all" becomes an error (`SourceError`).
 */

/** SCOPE's risks table: a run this thin fires the documented fallback. */
export const MIN_CANDIDATE_YIELD = 10;

/**
 * What the fallback widens `--since` to. Two years is not a measurement: it is
 * "old enough that a seed-stage company posting about itself is still a
 * seed-stage company", and it is one constant.
 */
export const FALLBACK_SINCE_DAYS = 730;

/** Why the run has nothing to hand stage 2. All three exit 2 (a data gap). */
export type SourceFailure =
  /** Every request to the source failed. ARCHITECTURE §5's "fail the run". */
  | "source_dead"
  /** The source answered and had nothing for this query. */
  | "no_hits"
  /** Hits existed and none of them survived classification, dedup or parsing. */
  | "no_candidates";

export class SourceError extends Error {
  readonly failure: SourceFailure;
  constructor(failure: SourceFailure, message: string) {
    super(message);
    this.name = "SourceError";
    this.failure = failure;
  }
}

// ---------------------------------------------------------------------------
// The manifest's stage-1 record. Parsed rather than assembled loosely: it is
// the audit trail the gate at TICKET-0013 reads, and a field that silently
// stopped being written would not be noticed by anything else.
// ---------------------------------------------------------------------------

export const SourceStage = z.object({
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  duration_ms: z.number().int().min(0),
  seed_form: z.enum(["topic", "urls"]),
  flags: z.object({
    limit: z.number().int().min(1),
    since_days: z.number().int().min(1),
    min_hits: z.number().int().min(0),
    expand: z.boolean(),
    replay: z.boolean(),
    query_plan_file: z.string().nullable(),
  }),
  query: z
    .object({
      chosen: z.string(),
      chosen_by: z.string(),
      clarified: z.boolean(),
      options_offered: z.array(z.string()),
      probe: z.object({ hits: z.number(), usable: z.number() }).nullable(),
      replayed: z.boolean(),
    })
    .nullable(),
  search: z
    .object({
      arms: z.array(
        z.object({
          label: z.string(),
          query: z.string(),
          tags: z.string(),
          pages_fetched: z.number().int(),
          hits: z.number().int(),
          new_hits: z.number().int(),
        }),
      ),
      pages_fetched: z.number().int(),
      distinct_posts: z.number().int(),
      unparseable_hits: z.number().int(),
      failures: z.array(
        z.object({
          label: z.string(),
          page: z.number().int(),
          url: z.string(),
          status: z.number().int(),
          reason: z.string(),
        }),
      ),
    })
    .nullable(),
  /** Null when it did not fire, so "did not fire" is distinguishable from "not asked". */
  fallback: z
    .object({
      fired: z.literal(true),
      from_days: z.number().int(),
      to_days: z.number().int(),
      sites_before: z.number().int(),
      sites_after: z.number().int(),
      /** False when `--no-expand` kept the arms off; the window still widened. */
      expanded_arms: z.boolean(),
    })
    .nullable(),
  filter: z.object({
    usable_posts: z.number().int(),
    rejected_posts: z.number().int(),
    rejected_by_kind: z.record(z.string(), z.number().int()),
  }),
  dedup: z.object({
    sites: z.number().int(),
    sites_with_multiple_posts: z.number().int(),
  }),
  resolve: z
    .object({
      requests: z.number().int(),
      redirected: z.number().int(),
      rekeyed: z.number().int(),
      unreachable: z.number().int(),
      rejected_on_landing: z.number().int(),
    })
    .nullable(),
  candidates: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      url: z.string(),
      posts: z.number().int().min(1),
      /** `ok`, or the reason its own url did not answer. Coverage, not rejection. */
      status: z.enum(["ok", "unreachable"]),
      http_status: z.number().int().nullable(),
    }),
  ),
  counts: z.object({ candidates: z.number().int(), dropped: z.number().int() }),
});
export type SourceStage = z.infer<typeof SourceStage>;

// ---------------------------------------------------------------------------

/**
 * A topic, or a path to a list of urls (SPEC §3.1).
 *
 * The test is "does this name a readable file", not a pattern on the string: a
 * topic that happens to look like a path is a mistake worth catching, and a
 * list file with no extension is not.
 */
export function seedForm(seed: string): "topic" | "urls" {
  try {
    return statSync(seed).isFile() ? "urls" : "topic";
  } catch {
    return "topic";
  }
}

/**
 * Sites strongest-first, by the rule `resolve.ts` already uses inside a group.
 *
 * The first live run is why this exists. Discovery order is arm order then page
 * order — a relevance ranking over four concatenated queries, which is not a
 * ranking of companies. On `"LLM observability"` the first ten sites carried
 * 74, 3, 2, 2, 2, 2, 2, 1, 1 and 31 points while the strongest ten carried 105,
 * 85, 74, 74, 59, 32, 31, 13, 12 and 10: a `--limit 10` was spending its whole
 * budget on the posts nobody read. Points are also the traction signal SPEC §2's
 * D3 reads, so this is the same ordering the rubric would ask for.
 */
export function rankSites<T extends ResolvedSite>(sites: readonly T[]): T[] {
  return [...sites].sort((a, b) => {
    const [pa, pb] = [a.posts[0], b.posts[0]];
    if (pa === undefined || pb === undefined) return 0;
    return strongerPost(pa, pb);
  });
}

export interface SourceOptions {
  seed: string;
  runId?: string;
  limit?: number;
  sinceDays?: number;
  minHits?: number;
  /** `--no-expand`: the raw seed verbatim, and — inconsistency 31 — one arm. */
  expand?: boolean;
  queryPlanFile?: string;
  /** `--replay`: reuse the run directory and the plan already decided in it. */
  replay?: boolean;
  /** Repo root. Tests point this at a temp directory. */
  root?: string;
  http?: HttpOptions;
  now?: () => Date;
  clarifier?: Clarifier;
  chooser?: Chooser;
  isInteractive?: () => boolean;
  env?: EnvSource;
}

export interface SourceOutcome {
  run_id: string;
  paths: RunPaths;
  candidates: Candidate[];
  plan: QueryPlan | null;
  stage: SourceStage;
  manifest: Manifest;
}

function countKinds(entries: readonly { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}

/**
 * `--no-expand` cuts the four arms as well as the planning (inconsistency 31).
 *
 * The flag's own help text says "use the raw seed verbatim", and a run that
 * skipped the clarifier and then quietly searched `"<seed> raises seed funding"`
 * would not be that. ADR-0008 only speaks about planning, so this is 0012's
 * call and it is made in the direction the operator's words point.
 */
function armsFor(
  query: string,
  expand: boolean,
): { expansions: QueryExpansion[] } | Record<string, never> {
  return expand ? {} : { expansions: [{ label: "raw", query, tags: "story" }] };
}

/** Stage 1, end to end. Writes `candidates.jsonl` and the manifest's `source` record. */
export async function runSource(options: SourceOptions): Promise<SourceOutcome> {
  const {
    seed,
    runId: explicitRunId,
    limit = 15,
    sinceDays = 180,
    minHits = 8,
    expand = true,
    queryPlanFile,
    replay = false,
    root = ".",
    http = {},
    now = () => new Date(),
    clarifier,
    chooser,
    isInteractive,
    env,
  } = options;

  const startedAt = now();
  const form = seedForm(seed);
  const runId = resolveRunId({
    ...(explicitRunId === undefined ? {} : { explicit: explicitRunId }),
    seed,
    now: startedAt,
  });
  const paths = createRunDir(runId, { root, allowExisting: replay });

  const manifest = newManifest({
    run_id: runId,
    created_at: startedAt.toISOString(),
    seed: { form, value: seed },
    llm: llmInfo(env ?? process.env),
  });

  let plan: QueryPlan | null = null;
  let stageQuery: SourceStage["query"] = null;
  let search: HnSearchResult | null = null;
  let fallback: SourceStage["fallback"] = null;
  let sites: ResolvedSite[] = [];
  let usablePosts = 0;
  /** Companies after grouping. Sites on the topic path, candidates on the url path. */
  let groupedSites = 0;
  let rejectedPosts: { kind: string }[] = [];
  let resolved: { sites: ResolvedSiteWithRedirect[]; rejected: { kind: string }[] } | null = null;
  /** Requests made, which is the shortlist — resolution can merge two sites into one. */
  let resolveRequests = 0;
  let candidates: Candidate[] = [];
  let dropped = 0;

  const finish = (): SourceOutcome => {
    const finishedAt = now();
    const byUrl = new Map(resolved?.sites.map((site) => [site.canonical_url, site]) ?? []);
    const stage = SourceStage.parse({
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      seed_form: form,
      flags: {
        limit,
        since_days: sinceDays,
        min_hits: minHits,
        expand,
        replay,
        query_plan_file: queryPlanFile ?? null,
      },
      query: stageQuery,
      search:
        search === null
          ? null
          : {
              arms: search.arms,
              pages_fetched: search.pages_fetched,
              distinct_posts: search.hits.length,
              unparseable_hits: search.dropped.length,
              failures: search.failures,
            },
      fallback,
      filter: {
        usable_posts: usablePosts,
        rejected_posts: rejectedPosts.length,
        rejected_by_kind: countKinds(rejectedPosts),
      },
      dedup: {
        sites: groupedSites,
        sites_with_multiple_posts:
          form === "urls"
            ? candidates.filter((candidate) => candidate.provenance.length > 1).length
            : sites.filter((site) => site.posts.length > 1).length,
      },
      resolve:
        resolved === null
          ? null
          : {
              requests: resolveRequests,
              redirected: resolved.sites.filter((site) => site.resolution.redirected).length,
              rekeyed: resolved.sites.filter((site) => site.resolution.rekeyed).length,
              unreachable: resolved.sites.filter((site) => site.resolution.reason !== null).length,
              rejected_on_landing: resolved.rejected.length,
            },
      candidates: candidates.map((candidate) => {
        const site = byUrl.get(candidate.url);
        return {
          slug: candidate.slug,
          name: candidate.name,
          url: candidate.url,
          posts: candidate.provenance.length,
          status: site?.resolution.reason == null ? "ok" : "unreachable",
          http_status: site?.resolution.status ?? null,
        };
      }),
      counts: { candidates: candidates.length, dropped },
    });

    writeFileSync(
      paths.candidates,
      candidates.map((candidate) => JSON.stringify(candidate)).join("\n") +
        (candidates.length > 0 ? "\n" : ""),
    );
    const written = writeStage(paths.manifest, manifest, "source", stage);
    return { run_id: runId, paths, candidates, plan, stage, manifest: written };
  };

  /** A run that cannot continue still writes its manifest: it is how a reviewer sees why. */
  const fail = (failure: SourceFailure, message: string): never => {
    finish();
    throw new SourceError(failure, message);
  };

  const at = startedAt.toISOString();

  if (form === "urls") {
    const entries = parseUrlList(readFileSync(seed, "utf8"));
    const built = candidatesFromUrls(entries, { query: seed, at, source: "url_list" });
    candidates = built.candidates.slice(0, limit);
    dropped = built.rejected.length;
    rejectedPosts = built.rejected;
    // Lines, not candidates: two lines pointing at one company are two usable
    // lines and one candidate, and a count that conflated them would hide the
    // collapse this stage exists to make.
    usablePosts = entries.length - built.rejected.length;
    groupedSites = built.candidates.length;
    if (candidates.length === 0) {
      fail("no_candidates", `no usable urls in ${seed} (${built.rejected.length} rejected)`);
    }
    return finish();
  }

  const planned = await planQuery(seed, {
    minHits,
    expand,
    planPath: paths.queryPlan,
    ...(queryPlanFile === undefined ? {} : { planFile: queryPlanFile }),
    ...(clarifier === undefined ? {} : { clarifier }),
    ...(chooser === undefined ? {} : { chooser }),
    ...(isInteractive === undefined ? {} : { isInteractive }),
    probe: { sinceDays, http, now: () => startedAt },
  });
  plan = planned.plan;
  stageQuery = {
    chosen: plan.chosen,
    chosen_by: plan.chosen_by,
    clarified: plan.clarified,
    options_offered: plan.options_offered,
    probe: plan.probe,
    replayed: planned.replayed,
  };

  search = await searchHn(plan.chosen, {
    sinceDays,
    http,
    now: () => startedAt,
    ...armsFor(plan.chosen, expand),
  });

  // ARCHITECTURE §5. Not "a page failed" — every page failed, which is the only
  // shape of failure that means the source itself is unusable.
  if (search.pages_fetched === 0 && search.failures.length > 0) {
    const first = search.failures[0];
    fail(
      "source_dead",
      `every source request failed (${search.failures.length}); first: ${first?.status} ${first?.reason}`,
    );
  }
  if (search.hits.length === 0) {
    fail("no_hits", `the source had nothing for ${JSON.stringify(plan.chosen)}`);
  }

  const classified = classifyHits(search.hits.map((sourced) => sourced.hit));
  usablePosts = classified.usable.length;
  rejectedPosts = classified.rejected.map((entry) => ({ kind: entry.classification.kind }));

  sites = dedupeHits(search.hits).sites;
  groupedSites = sites.length;

  // The documented fallback (SCOPE's risks table): a thin yield widens the
  // window and searches again. It widens the *arms* only if the operator did
  // not turn them off — `--no-expand` is a instruction, not a preference.
  if (sites.length < MIN_CANDIDATE_YIELD && sinceDays < FALLBACK_SINCE_DAYS) {
    const before = sites.length;
    const wider = await searchHn(plan.chosen, {
      sinceDays: FALLBACK_SINCE_DAYS,
      http,
      now: () => startedAt,
      ...armsFor(plan.chosen, expand),
    });
    const byId = new Map(search.hits.map((sourced) => [sourced.hit.object_id, sourced]));
    for (const sourced of wider.hits)
      if (!byId.has(sourced.hit.object_id)) byId.set(sourced.hit.object_id, sourced);
    const merged = [...byId.values()];
    search = {
      ...wider,
      hits: merged,
      arms: [...search.arms, ...wider.arms],
      failures: [...search.failures, ...wider.failures],
      dropped: [...search.dropped, ...wider.dropped],
      pages_fetched: search.pages_fetched + wider.pages_fetched,
    };
    const reclassified = classifyHits(merged.map((sourced) => sourced.hit));
    usablePosts = reclassified.usable.length;
    rejectedPosts = reclassified.rejected.map((entry) => ({ kind: entry.classification.kind }));
    sites = dedupeHits(merged).sites;
    groupedSites = sites.length;
    fallback = {
      fired: true,
      from_days: sinceDays,
      to_days: FALLBACK_SINCE_DAYS,
      sites_before: before,
      sites_after: sites.length,
      expanded_arms: expand,
    };
  }

  if (sites.length === 0) {
    fail("no_candidates", `every one of ${search.hits.length} posts was rejected before dedup`);
  }

  // Rank, then cut, then resolve: one request per company that survived the cut.
  const shortlist = rankSites(sites).slice(0, limit);
  resolveRequests = shortlist.length;
  resolved = await resolveSites(shortlist, { http });

  const built = toCandidates(resolved.sites, { query: plan.chosen, at });
  candidates = built.candidates;
  dropped = built.dropped.length;
  if (candidates.length === 0) {
    fail(
      "no_candidates",
      `no site survived redirect resolution (${resolved.rejected.length} rejected)`,
    );
  }

  return finish();
}
