/**
 * How a run is paced: how many requests it is willing to make, and how many of
 * them at once (TICKET-0017).
 *
 * This file exists because of a defect both adapters shipped with. STATE
 * inconsistencies 60 and 66 say it in the same words, one module apart: **the
 * request budget is decided per candidate and spent per run.**
 * `defaultCalls(mode)` reads two GitHub endpoints unauthenticated and five with
 * a token; `SITE_PAGE_BUDGET` reads three pages past the home page. Both are
 * the right answer for *one* candidate and only an assumption about the run —
 * they assume roughly a dozen of them. A `--limit 40` run unauthenticated is 80
 * GitHub requests against a 60/hour limit, and the candidates that pay for it
 * are whichever ones happen to sit at the end of the list.
 *
 * Three rules hold here:
 *
 * 1. **The allowance is planned before the loop starts, not discovered during
 *    it.** A budget spent first-come-first-served produces a run whose coverage
 *    depends on where in the list a company happened to sit. A run that is
 *    uniformly thinner and says so is worse for the last candidate and better
 *    for the reader, who can no longer mistake "we ran out" for "there was
 *    nothing there". This is the same argument `defaultCalls` already makes
 *    about degraded mode; it is applied one level up.
 *
 * 2. **The plan reproduces the per-candidate defaults at the size they
 *    assumed.** Twelve candidates gets exactly `CHEAP_CALLS` unauthenticated
 *    and exactly `ALL_CALLS` with a token — the adapters' own numbers. This is
 *    a generalisation of the existing behaviour, not a replacement for it, and
 *    a test pins that.
 *
 * 3. **The meter is a wall, not a shaper.** Retries are requests too, and the
 *    plan cannot know how many there will be. So actual spend is counted as it
 *    happens and a pool that reaches its hard limit stops being called — the
 *    caller records an unknown with a reason (CLAUDE.md invariant 4) rather
 *    than issuing a request that will be rejected and retried.
 */

import type { GithubMode } from "../config.js";
import { ALL_CALLS, type GithubCall } from "../evidence/github.js";
import { SITE_PAGE_BUDGET } from "../evidence/site.js";

/* -------------------------------------------------------------------------- */
/* The pools                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Requests are counted per destination, because the reason to stop differs.
 * `github` is one host with a documented hourly limit. `site` is a different
 * host per candidate with no shared limit at all, so its ceiling is a
 * runaway guard rather than an external constraint. The HN thread is one
 * request per candidate against a third host and is counted for the report
 * without being gated — there is no arithmetic in which it is the thing that
 * ran a run out of budget.
 */
export type RequestPool = "github" | "site" | "hn";

export const REQUEST_POOLS: readonly RequestPool[] = ["github", "site", "hn"];

/**
 * GitHub's documented limits, per hour, per the mode in `src/config.ts`. These
 * are theirs, not ours: they are the wall the meter stops at.
 */
export const GITHUB_RATE_LIMIT: Record<GithubMode, number> = {
  unauthenticated: 60,
  authenticated: 5_000,
};

/**
 * How much of the hour a run is willing to plan against. The other half pays
 * for the retries `httpGet` makes on a 5xx or a 429 — which are requests the
 * plan cannot count because it does not know how bad the network is — and for
 * whatever else this IP address did in the same hour, which a run cannot see
 * at all.
 */
export const GITHUB_PLANNING_SHARE = 0.5;

export function githubPlanningCeiling(mode: GithubMode): number {
  return Math.floor(GITHUB_RATE_LIMIT[mode] * GITHUB_PLANNING_SHARE);
}

/**
 * The whole run's company-page allowance. Unlike GitHub this is not somebody
 * else's limit — each candidate's site is a different host and none of them
 * has agreed to anything. It is a bound on the run itself: at four requests a
 * candidate (a home page and up to `SITE_PAGE_BUDGET` past it), 240 is sixty
 * companies read in full, which is well past the `--limit 15` this tool is
 * for. A run that wants to make more requests than this against sixty
 * different strangers' web servers is a bug, and the ceiling is where that
 * shows up.
 *
 * Because it is our own number and not theirs, the plan spends all of it
 * rather than reserving a share the way the GitHub pool does.
 */
export const SITE_RUN_CEILING = 240;

/** A home page always costs one request; the page budget is what is left. */
export const SITE_REQUESTS_PER_CANDIDATE = 1 + SITE_PAGE_BUDGET;

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What one candidate is allowed, and why. Every candidate in a run gets the
 * same one — that is rule 1 — so this is a run-level object even though its
 * fields are per-candidate quantities.
 */
export interface RunPlan {
  /** How many candidates it was divided between. */
  candidates: number;
  mode: GithubMode;
  /** The prefix of `ALL_CALLS` each candidate may make. */
  github: readonly GithubCall[];
  /** Passed to `gatherSite` as its `budget`; excludes the home page. */
  sitePages: number;
  /** What the plan expects to spend, before retries. For the manifest. */
  planned: Record<RequestPool, number>;
  /**
   * True when the run is large enough that one GitHub call per candidate is
   * already past the planning ceiling. The floor is deliberate — see
   * `planRun` — and this field is how a thin run says why it was thin.
   */
  over_planning_ceiling: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Divide the run's ceilings by the number of candidates, uniformly.
 *
 * The GitHub allowance floors at one call rather than at zero. Zero is the
 * arithmetic answer for a 31-candidate unauthenticated run — 30 planned
 * requests do not go round — but it is the wrong one: the real limit is 60,
 * 31 requests fit inside it, and returning "no GitHub evidence for anybody"
 * because of our own conservative reserve would be a cliff we invented. So the
 * floor holds, `over_planning_ceiling` records that the reserve was crossed,
 * and the meter's hard limit is what actually stops the run.
 *
 * The site allowance has no such floor and needs none: the home page is the
 * candidate, so `sitePages: 0` still reads one page and is an honest answer.
 */
export function planRun(candidates: number, mode: GithubMode): RunPlan {
  const n = Math.max(1, candidates);

  const githubCeiling = githubPlanningCeiling(mode);
  const githubAllowance = Math.floor(githubCeiling / n);
  const githubCalls = ALL_CALLS.slice(0, clamp(githubAllowance, 1, ALL_CALLS.length));

  const siteAllowance = Math.floor(SITE_RUN_CEILING / n) - 1;
  const sitePages = clamp(siteAllowance, 0, SITE_PAGE_BUDGET);

  return {
    candidates: n,
    mode,
    github: githubCalls,
    sitePages,
    planned: {
      github: githubCalls.length * n,
      site: (1 + sitePages) * n,
      hn: n,
    },
    over_planning_ceiling: githubAllowance < 1,
  };
}

/* -------------------------------------------------------------------------- */
/* The meter                                                                   */
/* -------------------------------------------------------------------------- */

/** What a pool has spent and what it is allowed. Reported, not just enforced. */
export interface PoolReport {
  spent: number;
  /** `null` for an ungated pool. */
  limit: number | null;
}

/**
 * Counts what was actually issued, across candidates, and says when a pool is
 * done. Mutable and shared by every candidate in the run — which is safe here
 * because `spend` is synchronous and nothing awaits between reading a counter
 * and writing it.
 */
export interface RequestMeter {
  readonly limits: Readonly<Record<RequestPool, number | null>>;
  spend(pool: RequestPool, requests: number): void;
  spent(pool: RequestPool): number;
  /** `Infinity` for an ungated pool. */
  remaining(pool: RequestPool): number;
  /** True when the next request in this pool would cross the wall. */
  exhausted(pool: RequestPool): boolean;
  report(): Record<RequestPool, PoolReport>;
}

/**
 * The hard limits, which are not the planning ceilings: GitHub's is theirs and
 * is the whole hourly allowance, the site pool's is ours and is the same
 * ceiling the plan divided up, and the HN pool is ungated (see `RequestPool`).
 */
export function meterLimits(mode: GithubMode): Record<RequestPool, number | null> {
  return { github: GITHUB_RATE_LIMIT[mode], site: SITE_RUN_CEILING, hn: null };
}

export function requestMeter(limits: Record<RequestPool, number | null>): RequestMeter {
  const spent: Record<RequestPool, number> = { github: 0, site: 0, hn: 0 };

  const limitOf = (pool: RequestPool): number | null => limits[pool];

  const remaining = (pool: RequestPool): number => {
    const limit = limitOf(pool);
    return limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - spent[pool]);
  };

  return {
    limits,
    spend: (pool, requests) => {
      // A negative or fractional count would silently corrupt the wall.
      if (Number.isFinite(requests) && requests > 0) spent[pool] += Math.round(requests);
    },
    spent: (pool) => spent[pool],
    remaining,
    exhausted: (pool) => remaining(pool) <= 0,
    report: () =>
      Object.fromEntries(
        REQUEST_POOLS.map((pool) => [pool, { spent: spent[pool], limit: limitOf(pool) }]),
      ) as Record<RequestPool, PoolReport>,
  };
}

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Four candidates at a time. The live runs behind TICKET-0015 and TICKET-0016
 * averaged about three seconds a company across both adapters, so a `--limit
 * 15` run is roughly forty-five seconds in sequence and twelve in parallel.
 * Four is chosen to be obviously polite rather than optimal: GitHub's limit is
 * hourly, not per second, and the sites belong to strangers.
 */
export const GATHER_CONCURRENCY = 4;

/**
 * `Promise.all` with a cap — SCOPE says no queue, and this is the entire
 * concurrency requirement. Results come back in input order regardless of the
 * order they finished in, because the bundle list is written to disk and a run
 * that reorders itself between invocations is not replayable.
 *
 * Rejections are not caught. Every caller here returns its failures as data
 * (ARCHITECTURE §5), so a throw reaching this function is a bug in the caller
 * and swallowing it would hide it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // `index` came from the length, so the element is there.
      // `noUncheckedIndexedAccess` cannot see that, and skipping a `undefined`
      // instead would leave a hole in `results` rather than reporting one.
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}
