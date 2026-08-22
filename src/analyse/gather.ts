/**
 * Stage 2a — evidence gathering (TICKET-0017). ARCHITECTURE §1: *company site
 * + GitHub org + HN thread → `runs/<run_id>/evidence/<id>.json`, deterministic,
 * cached, no LLM.*
 *
 * This module is a loop, a join and a budget. It fetches nothing itself: the
 * two adapters (`src/evidence/github.ts`, `src/evidence/site.ts`) do the
 * reading and `fetchEvidence` does the HN thread, all three through the one
 * choke point CLAUDE.md requires. What is new here is what only exists once
 * there is more than one candidate.
 *
 * Four rules hold in this file:
 *
 * 1. **No model, and the test says so rather than the comment.** 2a being a
 *    separate module from 2b is what makes "the gather step concludes nothing"
 *    checkable instead of asserted (TICKET-0017's own reason for existing).
 *    Nothing here imports `src/llm/`.
 *
 * 2. **The bundle carries ids alongside text.** That is the mechanism of
 *    closed-world citation (ADR-0003): the extractor is handed `bundleItems`,
 *    every item has an id, and a fact citing an id that is not in that set is
 *    dropped at parse time in TICKET-0020. The model cannot invent a source
 *    because it was never shown one it could not cite.
 *
 * 3. **Zero usable evidence is a bundle, not a failure.** A dead site, no
 *    GitHub account and a deleted thread produce a bundle of `fetch_failed`
 *    records and the run continues. It becomes a low-coverage analysis
 *    (CLAUDE.md invariant 4), which is a different and more honest thing than
 *    a missing one.
 *
 * 4. **The join runs in both directions.** STATE inconsistency 45 — one
 *    company took three of twelve slots and no url said they were one company
 *    — is a repo that knows its `homepage` and a site that links to its repo.
 *    A candidate sourced as a GitHub url reaches the company site through
 *    `repo.homepage`; a candidate sourced as a company site reaches the repo
 *    through the code-host link the site adapter already discovers. Both
 *    directions are recorded on the bundle with where they came from, so a
 *    reviewer can see the guess. **Neither merges two candidates** — that is
 *    still open, and still not this ticket's.
 */

import type { GithubAuth } from "../config.js";
import { githubAuth } from "../config.js";
import type { Candidate, Evidence, EvidenceType } from "../contracts/index.js";
import type { HttpOptions } from "../evidence/fetch.js";
import { fetchEvidence } from "../evidence/fetch.js";
import type { GatherGithubOptions, GithubResult, RepoRef } from "../evidence/github.js";
import { gatherGithub, parseGithubRef } from "../evidence/github.js";
import type { Signal, UnknownSignal } from "../evidence/signal.js";
import type { Person, SiteResult } from "../evidence/site.js";
import { gatherSite } from "../evidence/site.js";
import type { EvidenceStore } from "../evidence/store.js";
import { hnItemUrl } from "../source/hn.js";
import type { RequestMeter, RequestPool, RunPlan } from "./budget.js";
import {
  GATHER_CONCURRENCY,
  mapWithConcurrency,
  meterLimits,
  planRun,
  requestMeter,
} from "./budget.js";

/* -------------------------------------------------------------------------- */
/* What a bundle is                                                            */
/* -------------------------------------------------------------------------- */

/** Where a resolved company site came from. Recorded, never assumed. */
export type SiteOrigin = "candidate_url" | "github_homepage";
/** Where a resolved GitHub account came from. */
export type GithubOrigin = "candidate_url" | "site_link";

/**
 * The two halves of the join, and which direction each was made in. Null on
 * either side is the ordinary case: most companies have no public repo, and a
 * repo with no `homepage` field is most repos.
 */
export interface BundleJoin {
  site: { url: string; from: SiteOrigin } | null;
  github: { ref: RepoRef; from: GithubOrigin } | null;
}

/**
 * One evidence record as the extractor sees it: an id, and the text that id
 * addresses. Deliberately **not** the `Evidence` record — `meta` carries
 * transport detail (attempt counts, cache hits, projection names) that is for
 * a reviewer reading the store, not for a model deciding what a company does,
 * and every field handed to a model is a field it can be confused by.
 *
 * Rule 2 lives in this type: `id` travels with `text` and there is no shape in
 * which the model gets one without the other.
 */
export interface BundleItem {
  id: string;
  url: string;
  type: EvidenceType;
  title: string | null;
  retrieved_at: string;
  text: string;
}

/** What one candidate cost, by destination. Summed across the run. */
export type RequestCounts = Record<RequestPool, number>;

/** Something that produced no evidence, and why. Data, never a throw (§5). */
export interface GatherFailure {
  pool: RequestPool;
  url: string;
  /** HTTP status, or 0 when the request never got one. */
  status: number;
  reason: string;
}

/** Everything stage 2b is given about one candidate, and nothing else. */
export interface Bundle {
  /** `Candidate.slug`. The analysis and memo for this candidate are named by it. */
  slug: string;
  candidate: Candidate;
  join: BundleJoin;
  /** Every record fetched, including the failed ones, already written to the store. */
  evidence: Evidence[];
  signals: Signal[];
  unknowns: UnknownSignal[];
  /** Named people the site adapter found. See its own caveat (inconsistency 64). */
  people: Person[];
  requests: RequestCounts;
  failures: GatherFailure[];
}

/**
 * The bundle as the extraction prompt receives it (TICKET-0019 formats this).
 * A projection rather than a field so there is one source of truth for the
 * text, and so "what the model was shown" is a function a test can call.
 */
export function bundleItems(bundle: Bundle): BundleItem[] {
  return bundle.evidence.map((record) => ({
    id: record.id,
    url: record.url,
    type: record.type,
    title: record.title,
    retrieved_at: record.retrieved_at,
    text: record.text,
  }));
}

/** The closed world. TICKET-0020 drops any fact citing an id outside this set. */
export function bundleIds(bundle: Bundle): Set<string> {
  return new Set(bundle.evidence.map((record) => record.id));
}

/**
 * Records that actually carry something to read. A bundle of nothing but
 * `fetch_failed` is still a bundle (rule 3) — this is how the caller tells the
 * difference without inspecting types itself.
 */
export function usableEvidence(bundle: Bundle): Evidence[] {
  return bundle.evidence.filter((record) => record.type !== "fetch_failed");
}

/* -------------------------------------------------------------------------- */
/* Resolving what to fetch                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The candidate url read as a company site, or null when it is not one.
 *
 * A `github.com/acme/thing` url is an account, not a company page, and
 * fetching it as a site would put GitHub's own chrome into the evidence store
 * as if the company had written it. A gist is the same. `acme.github.io` is
 * the exception that has to be named: it is a GitHub account *and* a hosted
 * page, and on a small company it is routinely the only page they have.
 */
export function siteUrlFromCandidate(url: string, ref: RepoRef | null): string | null {
  if (ref === null) return url;
  return ref.from === "github.io" ? url : null;
}

/**
 * The first code-host link on the company's own home page that resolves to a
 * GitHub account. The reverse join — a site that points at its repo.
 *
 * Document order is why "first" is meaningful rather than arbitrary: the site
 * adapter keeps links in the order they appear, so a header or hero link comes
 * before a footer one. It is still a guess, and it is recorded as
 * `from: "site_link"` so a wrong one is readable.
 */
export function githubRefFromSite(site: SiteResult): RepoRef | null {
  for (const link of site.links) {
    if (link.role !== "repo") continue;
    const ref = parseGithubRef(link.url);
    if (ref !== null) return ref;
  }
  return null;
}

/**
 * The HN thread this candidate came from, or null when it did not come from
 * one. The **primary** post only: `provenance` is a group (schema v2) and the
 * secondary posts are the same company discussed again, which costs a request
 * each for a thread the primary already covers.
 */
export function hnThreadUrl(candidate: Candidate): string | null {
  const primary = candidate.provenance[0];
  if (primary.source !== "hn" || primary.ref === null) return null;
  return hnItemUrl(primary.ref);
}

/* -------------------------------------------------------------------------- */
/* Gathering one candidate                                                     */
/* -------------------------------------------------------------------------- */

export interface GatherOptions {
  /** Records are written here as they are produced. Omit to gather without persisting. */
  store?: EvidenceStore;
  /** The per-candidate allowance. Defaults to a one-candidate run. */
  plan?: RunPlan;
  /** Shared across candidates — the whole point of it. Defaults to a fresh one. */
  meter?: RequestMeter;
  /** Passed through to `httpGet` — transport, cache dir, clock, retry policy. */
  http?: HttpOptions;
  /** Defaults to `githubAuth()`. Injected in tests so no environment is read. */
  auth?: GithubAuth;
}

const emptyCounts = (): RequestCounts => ({ github: 0, site: 0, hn: 0 });

/**
 * Read one candidate: the HN thread it came from, its company site, its GitHub
 * account, and whichever of the two the other one pointed at.
 *
 * Best-effort throughout, the same contract both adapters already keep: the
 * return value has the same shape whether everything succeeded or nothing did,
 * and the difference shows up as unknowns and failures rather than as a throw.
 */
export async function gatherCandidate(
  candidate: Candidate,
  options: GatherOptions = {},
): Promise<Bundle> {
  const auth = options.auth ?? githubAuth();
  const plan = options.plan ?? planRun(1, auth.mode);
  const meter = options.meter ?? requestMeter(meterLimits(auth.mode));

  const bundle: Bundle = {
    slug: candidate.slug,
    candidate,
    join: { site: null, github: null },
    evidence: [],
    signals: [],
    unknowns: [],
    people: [],
    requests: emptyCounts(),
    failures: [],
  };

  /** Every record reaches the store through here, so none can be forgotten. */
  const keep = (records: readonly Evidence[]): void => {
    for (const record of records) {
      bundle.evidence.push(record);
      options.store?.write(record);
    }
  };

  const charge = (pool: RequestPool, requests: number): void => {
    bundle.requests[pool] += requests;
    meter.spend(pool, requests);
  };

  const http = options.http;

  /* ---- the HN thread -------------------------------------------------- */

  const threadUrl = hnThreadUrl(candidate);
  if (threadUrl === null) {
    bundle.unknowns.push({
      key: "hn.thread",
      reason: `candidate was not sourced from an HN post with an item id`,
    });
  } else {
    const record = await fetchEvidence(threadUrl, "hn_item", { ...http });
    // One request, and a retry does not change that this pool is ungated.
    charge("hn", 1);
    keep([record]);
    if (record.type === "fetch_failed") {
      bundle.failures.push({
        pool: "hn",
        url: threadUrl,
        status: record.status,
        reason: record.text,
      });
    }
  }

  /* ---- which site, which account --------------------------------------- */

  const candidateRef = parseGithubRef(candidate.url);
  let siteTarget: BundleJoin["site"] =
    siteUrlFromCandidate(candidate.url, candidateRef) === null
      ? null
      : { url: candidate.url, from: "candidate_url" };
  let githubTarget: BundleJoin["github"] =
    candidateRef === null ? null : { ref: candidateRef, from: "candidate_url" };

  const readSite = async (target: NonNullable<BundleJoin["site"]>): Promise<SiteResult> => {
    if (meter.exhausted("site")) {
      bundle.unknowns.push({
        key: "site",
        reason: `run site request budget spent (${meter.spent("site")} of ${meter.limits.site})`,
      });
      return {
        url: target.url,
        final_url: null,
        pages: [],
        evidence: [],
        signals: [],
        unknowns: [],
        people: [],
        rejected_people: [],
        links: [],
        requests: 0,
        failures: [],
      };
    }
    bundle.join.site = target;
    const result = await gatherSite(target.url, {
      budget: plan.sitePages,
      ...(http ? { http } : {}),
    });
    charge("site", result.requests);
    keep(result.evidence);
    bundle.signals.push(...result.signals);
    bundle.unknowns.push(...result.unknowns);
    bundle.people.push(...result.people);
    for (const failure of result.failures) {
      bundle.failures.push({
        pool: "site",
        url: failure.url,
        status: failure.status,
        reason: failure.reason,
      });
    }
    return result;
  };

  const readGithub = async (
    target: NonNullable<BundleJoin["github"]>,
  ): Promise<GithubResult | null> => {
    if (meter.exhausted("github")) {
      // The wall, not the plan. Skipping costs coverage; issuing the request
      // costs a 403 and the retries behind it, and still costs the coverage.
      bundle.unknowns.push({
        key: "github",
        reason: `run GitHub request budget spent (${meter.spent("github")} of ${meter.limits.github})`,
      });
      return null;
    }
    bundle.join.github = target;
    const githubOptions: GatherGithubOptions = {
      auth,
      calls: plan.github,
      ...(http ? { http } : {}),
    };
    const result = await gatherGithub(target.ref, githubOptions);
    charge("github", result.requests);
    keep(result.evidence);
    bundle.signals.push(...result.signals);
    bundle.unknowns.push(...result.unknowns);
    for (const failure of result.failures) {
      bundle.failures.push({
        pool: "github",
        url: failure.url,
        status: failure.status,
        reason: failure.reason,
      });
    }
    return result;
  };

  /* ---- the join, in whichever direction this candidate allows ---------- */

  // Exactly one of these two branches runs, always: `siteUrlFromCandidate`
  // returns the url unchanged unless the candidate is a `github.com` or gist
  // account, and in that case there is an account to read. There is no third
  // case to handle and no third message to write.
  if (siteTarget === null && githubTarget !== null) {
    // Sourced as a repository. `repo.homepage` is the only field that reaches
    // the company site (TICKET-0015 narrowed it there deliberately: the
    // account's own `blog` is a personal link as often as a company one).
    const github = await readGithub(githubTarget);
    if (github?.homepage) {
      siteTarget = { url: github.homepage.url, from: "github_homepage" };
      await readSite(siteTarget);
    } else {
      bundle.unknowns.push({
        key: "site",
        reason:
          githubTarget.ref.repo === null
            ? "candidate is a GitHub account url with no repository to read a homepage from"
            : "candidate is a GitHub url and its repository declares no homepage",
      });
    }
  } else if (siteTarget !== null) {
    const site = await readSite(siteTarget);
    if (githubTarget === null) {
      const discovered = githubRefFromSite(site);
      if (discovered !== null) githubTarget = { ref: discovered, from: "site_link" };
    }
    if (githubTarget === null) {
      bundle.unknowns.push({
        key: "github",
        reason: "candidate url is not a GitHub account and the site links to no code host",
      });
    } else {
      await readGithub(githubTarget);
    }
  }

  return bundle;
}

/* -------------------------------------------------------------------------- */
/* Gathering a run                                                             */
/* -------------------------------------------------------------------------- */

export interface GatherRunOptions extends Omit<GatherOptions, "plan" | "meter"> {
  /** Overrides `planRun(candidates.length, mode)`. */
  plan?: RunPlan;
  /** Overrides `GATHER_CONCURRENCY`. */
  concurrency?: number;
  /**
   * Overrides `meterLimits(mode)` — the walls, not the plan. A run that knows
   * the hour is already partly spent can hand over a smaller one, and a test
   * can hand over one small enough to hit.
   */
  limits?: Record<RequestPool, number | null>;
}

export interface RunGather {
  plan: RunPlan;
  /** In candidate order, whatever order they finished in. */
  bundles: Bundle[];
  /** What the run actually spent, per pool, against its limits. */
  requests: ReturnType<RequestMeter["report"]>;
}

/**
 * Gather every candidate in a run, `GATHER_CONCURRENCY` at a time, against one
 * shared budget.
 *
 * The plan is computed once from the candidate count before any of them is
 * touched — that is what makes the allowance uniform rather than
 * first-come-first-served, and it is the whole answer to inconsistencies 60
 * and 66.
 */
export async function gatherRun(
  candidates: readonly Candidate[],
  options: GatherRunOptions = {},
): Promise<RunGather> {
  const auth = options.auth ?? githubAuth();
  const plan = options.plan ?? planRun(candidates.length, auth.mode);
  const meter = requestMeter(options.limits ?? meterLimits(auth.mode));

  const bundles = await mapWithConcurrency(
    candidates,
    options.concurrency ?? GATHER_CONCURRENCY,
    (candidate) =>
      gatherCandidate(candidate, {
        ...options,
        auth,
        plan,
        meter,
      }),
  );

  return { plan, bundles, requests: meter.report() };
}
