import { describe, expect, it } from "vitest";
import {
  GATHER_CONCURRENCY,
  GITHUB_PLANNING_SHARE,
  GITHUB_RATE_LIMIT,
  githubPlanningCeiling,
  mapWithConcurrency,
  meterLimits,
  planRun,
  requestMeter,
  SITE_RUN_CEILING,
} from "../src/analyse/budget.js";
import { ALL_CALLS, CHEAP_CALLS, defaultCalls } from "../src/evidence/github.js";
import { SITE_PAGE_BUDGET } from "../src/evidence/site.js";

describe("githubPlanningCeiling", () => {
  it("reserves a share of the documented hourly limit for retries", () => {
    expect(githubPlanningCeiling("unauthenticated")).toBe(
      Math.floor(GITHUB_RATE_LIMIT.unauthenticated * GITHUB_PLANNING_SHARE),
    );
    expect(githubPlanningCeiling("unauthenticated")).toBe(30);
    expect(githubPlanningCeiling("authenticated")).toBe(2_500);
  });
});

describe("planRun", () => {
  it("reproduces the adapters' per-candidate defaults at the size they assumed", () => {
    // The headline property: this module generalises `defaultCalls` and
    // `SITE_PAGE_BUDGET` rather than replacing them. A dozen candidates — the
    // run size both adapters were written against — gets their own numbers.
    const thin = planRun(12, "unauthenticated");
    expect(thin.github).toEqual(defaultCalls("unauthenticated"));
    expect(thin.github).toEqual(CHEAP_CALLS);
    expect(thin.sitePages).toBe(SITE_PAGE_BUDGET);

    const full = planRun(12, "authenticated");
    expect(full.github).toEqual(defaultCalls("authenticated"));
    expect(full.github).toEqual(ALL_CALLS);
    expect(full.sitePages).toBe(SITE_PAGE_BUDGET);
  });

  it("gives every candidate the same allowance, whatever the run size", () => {
    // Rule 1: coverage must not depend on where in the list a company sat.
    // The plan is one object for the whole run, so this is structural.
    const plan = planRun(40, "unauthenticated");
    expect(plan.candidates).toBe(40);
    expect(plan.planned.github).toBe(plan.github.length * 40);
    expect(plan.planned.site).toBe((1 + plan.sitePages) * 40);
    expect(plan.planned.hn).toBe(40);
  });

  it("thins the GitHub allowance as the run grows, and stays inside the ceiling", () => {
    // The `--limit 40` run inconsistency 60 is about: 80 requests planned
    // against a 60/hour limit before, one call each and 40 requests now.
    const forty = planRun(40, "unauthenticated");
    expect(forty.github).toEqual(["repo"]);
    expect(forty.planned.github).toBeLessThanOrEqual(GITHUB_RATE_LIMIT.unauthenticated);

    expect(planRun(15, "unauthenticated").github).toEqual(CHEAP_CALLS);
    expect(planRun(10, "unauthenticated").github).toEqual(["repo", "owner", "readme"]);
  });

  it("keeps the full call list with a token at any run size this tool reaches", () => {
    for (const candidates of [1, 15, 40, 500]) {
      expect(planRun(candidates, "authenticated").github).toEqual(ALL_CALLS);
    }
  });

  it("floors GitHub at one call rather than inventing a cliff at our own reserve", () => {
    // 31 candidates does not divide into 30 planned requests, but 31 requests
    // fit inside the real limit of 60. Returning "no GitHub for anybody" would
    // be a cliff created by our reserve, not by GitHub's limit.
    const plan = planRun(31, "unauthenticated");
    expect(plan.github).toEqual(["repo"]);
    expect(plan.over_planning_ceiling).toBe(true);
    expect(plan.planned.github).toBeLessThanOrEqual(GITHUB_RATE_LIMIT.unauthenticated);
    expect(planRun(30, "unauthenticated").over_planning_ceiling).toBe(false);
  });

  it("thins the site allowance to zero pages without dropping the home page", () => {
    // `sitePages` excludes the home page, so 0 is an honest answer: the
    // candidate's own page is still read.
    const plan = planRun(SITE_RUN_CEILING, "authenticated");
    expect(plan.sitePages).toBe(0);
    expect(plan.planned.site).toBe(SITE_RUN_CEILING);
    expect(planRun(100, "authenticated").sitePages).toBe(1);
  });

  it("never plans more site requests than the run ceiling", () => {
    for (const candidates of [1, 12, 40, 60, 100, 240]) {
      expect(planRun(candidates, "authenticated").planned.site).toBeLessThanOrEqual(
        SITE_RUN_CEILING,
      );
    }
  });

  it("treats an empty run as one candidate rather than dividing by zero", () => {
    const plan = planRun(0, "unauthenticated");
    expect(plan.candidates).toBe(1);
    expect(Number.isFinite(plan.planned.github)).toBe(true);
  });
});

describe("requestMeter", () => {
  it("counts across candidates, which is the thing neither adapter did", () => {
    const meter = requestMeter(meterLimits("unauthenticated"));
    meter.spend("github", 5);
    meter.spend("github", 7);
    expect(meter.spent("github")).toBe(12);
    expect(meter.remaining("github")).toBe(GITHUB_RATE_LIMIT.unauthenticated - 12);
    expect(meter.exhausted("github")).toBe(false);
  });

  it("stops at the documented limit, not at the planning ceiling", () => {
    const meter = requestMeter(meterLimits("unauthenticated"));
    meter.spend("github", githubPlanningCeiling("unauthenticated"));
    expect(meter.exhausted("github")).toBe(false);
    meter.spend("github", githubPlanningCeiling("unauthenticated"));
    expect(meter.exhausted("github")).toBe(true);
    expect(meter.remaining("github")).toBe(0);
  });

  it("leaves the HN pool ungated but still counted", () => {
    const meter = requestMeter(meterLimits("authenticated"));
    meter.spend("hn", 1_000);
    expect(meter.spent("hn")).toBe(1_000);
    expect(meter.exhausted("hn")).toBe(false);
    expect(meter.remaining("hn")).toBe(Number.POSITIVE_INFINITY);
    expect(meter.report().hn).toEqual({ spent: 1_000, limit: null });
  });

  it("ignores a spend that is not a positive count", () => {
    const meter = requestMeter(meterLimits("authenticated"));
    meter.spend("site", -3);
    meter.spend("site", Number.NaN);
    meter.spend("site", 0);
    expect(meter.spent("site")).toBe(0);
  });

  it("reports every pool with its limit, for the manifest", () => {
    const meter = requestMeter(meterLimits("authenticated"));
    meter.spend("github", 2);
    meter.spend("site", 4);
    expect(meter.report()).toEqual({
      github: { spent: 2, limit: GITHUB_RATE_LIMIT.authenticated },
      site: { spent: 4, limit: SITE_RUN_CEILING },
      hn: { spent: 0, limit: null },
    });
  });
});

describe("mapWithConcurrency", () => {
  const defer = () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release: () => release() };
  };

  it("returns results in input order, not completion order", async () => {
    const delays = [30, 0, 10, 20];
    const results = await mapWithConcurrency(delays, 4, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` at once", async () => {
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 8 }, defer);

    const all = mapWithConcurrency(gates, 3, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await item.gate;
      running -= 1;
      return running;
    });

    // Nothing has been released, so exactly `limit` tasks should be in flight.
    await Promise.resolve();
    expect(peak).toBe(3);
    for (const gate of gates) gate.release();
    await all;
    expect(peak).toBe(3);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("does not swallow a rejection — callers return failures as data", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("ships a concurrency default that is polite rather than optimal", () => {
    expect(GATHER_CONCURRENCY).toBeLessThanOrEqual(8);
    expect(GATHER_CONCURRENCY).toBeGreaterThan(1);
  });
});
