import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planRun, SITE_RUN_CEILING } from "../src/analyse/budget.js";
import {
  type Bundle,
  bundleIds,
  bundleItems,
  type GatherOptions,
  gatherCandidate,
  gatherRun,
  githubRefFromSite,
  hnThreadUrl,
  siteUrlFromCandidate,
  usableEvidence,
} from "../src/analyse/gather.js";
import type { GithubAuth, GithubMode } from "../src/config.js";
import { CANDIDATE_SCHEMA_VERSION, Candidate, Evidence } from "../src/contracts/index.js";
import { GITHUB_API, parseGithubRef } from "../src/evidence/github.js";
import { gatherSite } from "../src/evidence/site.js";
import { evidenceStore } from "../src/evidence/store.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const corootHome = fixture("sites/coroot-home.html");
const corootAbout = fixture("sites/coroot-about.html");

const AT = new Date("2026-08-22T10:00:00.000Z");

const AUTH: Record<GithubMode, GithubAuth> = {
  unauthenticated: {
    token: null,
    mode: "unauthenticated",
    note: "",
    toJSON: () => ({ mode: "unauthenticated", note: "" }),
  },
  authenticated: {
    token: "ghp_notarealtokenatall0000",
    mode: "authenticated",
    note: "",
    toJSON: () => ({ mode: "authenticated", note: "" }),
  },
};

interface Route {
  status?: number;
  body?: string;
  contentType?: string;
}

/** Everything the two adapters and the HN fetch might ask for, in one table. */
function web(routes: Record<string, Route>) {
  const calls: string[] = [];
  const transport = async (url: string): Promise<Response> => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) {
      return new Response("<html><body>Not found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
    });
  };
  const to = (host: string): string[] => calls.filter((url) => url.includes(host));
  return { transport, calls, to };
}

const json = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", "github", name), "utf8");

const THREAD = "https://news.ycombinator.com/item?id=41000001";

const ROUTES: Record<string, Route> = {
  [THREAD]: {
    body:
      "<html><head><title>Show HN: Coroot</title></head><body>" +
      "<span class='titleline'>Show HN: Coroot — eBPF observability</span>" +
      "<div class='comment'>We have been running this in production for months. </div>".repeat(5) +
      "</body></html>",
  },
  "https://coroot.com/": { body: corootHome },
  "https://coroot.com/about": { body: corootAbout },
  [`${GITHUB_API}/repos/coroot/coroot`]: {
    body: json("repo-with-homepage.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/users/coroot`]: {
    body: json("user-organization.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/repos/coroot/coroot/readme`]: {
    body: json("readme-coroot.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/repos/coroot/coroot/contributors?per_page=100`]: {
    body: json("contributors-coroot.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/repos/coroot/coroot/stats/commit_activity`]: {
    body: json("commit-activity-coroot.json"),
    contentType: "application/json",
  },
};

function candidate(over: Partial<Candidate> = {}, ref: string | null = "41000001"): Candidate {
  return Candidate.parse({
    schema_version: CANDIDATE_SCHEMA_VERSION,
    slug: "coroot",
    name: "Coroot",
    url: "https://coroot.com/",
    one_liner: "eBPF observability",
    provenance: [
      {
        source: "hn",
        query: "eBPF observability",
        at: AT.toISOString(),
        ref,
        title: "Show HN: Coroot — eBPF observability",
        posted_url: "https://coroot.com/",
        posted_at: "2026-08-01T09:00:00.000Z",
      },
    ],
    ...over,
  });
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gather-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(routes: Record<string, Route> = ROUTES, over: Partial<GatherOptions> = {}) {
  const stub = web(routes);
  const options: GatherOptions = {
    auth: AUTH.authenticated,
    ...over,
    http: {
      transport: stub.transport,
      cacheDir: "",
      now: () => AT,
      sleep: async () => {},
      retry: { retries: 0 },
      ...over.http,
    },
  };
  return { stub, options };
}

const unknownFor = (bundle: Bundle, key: string): string | undefined =>
  bundle.unknowns.find((unknown) => unknown.key === key)?.reason;

/* -------------------------------------------------------------------------- */
/* Resolving what to fetch                                                     */
/* -------------------------------------------------------------------------- */

describe("siteUrlFromCandidate", () => {
  it("reads a plain url as the company's own page", () => {
    expect(siteUrlFromCandidate("https://coroot.com/", null)).toBe("https://coroot.com/");
  });

  it("does not read a repository url as a company page", () => {
    const url = "https://github.com/coroot/coroot";
    expect(siteUrlFromCandidate(url, parseGithubRef(url))).toBeNull();
  });

  it("does not read a gist as a company page", () => {
    const url = "https://gist.github.com/nullswan/abc123";
    expect(siteUrlFromCandidate(url, parseGithubRef(url))).toBeNull();
  });

  it("reads a Pages host as both an account and a page", () => {
    // On a small company `acme.github.io` is routinely the only page there is.
    const url = "https://acme.github.io/tracer";
    expect(siteUrlFromCandidate(url, parseGithubRef(url))).toBe(url);
  });
});

describe("githubRefFromSite", () => {
  it("finds the code-host link the site adapter already discovered", async () => {
    const stub = web(ROUTES);
    const site = await gatherSite("https://coroot.com/", {
      http: { transport: stub.transport, cacheDir: "", now: () => AT, retry: { retries: 0 } },
    });
    expect(githubRefFromSite(site)).toEqual({
      owner: "coroot",
      repo: "coroot",
      from: "github.com",
    });
  });

  it("is null when nothing on the page points at a code host", async () => {
    const stub = web({
      "https://acme.com/": { body: "<html><body><a href='/pricing'>Pricing</a></body></html>" },
    });
    const site = await gatherSite("https://acme.com/", {
      http: { transport: stub.transport, cacheDir: "", now: () => AT, retry: { retries: 0 } },
    });
    expect(githubRefFromSite(site)).toBeNull();
  });
});

describe("hnThreadUrl", () => {
  it("takes the primary post's item id and nothing else", () => {
    const two = candidate({
      provenance: [
        candidate().provenance[0],
        { ...candidate().provenance[0], ref: "41000999", title: "Coroot again" },
      ],
    });
    expect(hnThreadUrl(two)).toBe(THREAD);
  });

  it("is null for a candidate that did not come from HN", () => {
    const seeded = candidate({
      provenance: [{ ...candidate().provenance[0], source: "url_list", ref: null }],
    });
    expect(hnThreadUrl(seeded)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* gatherCandidate                                                             */
/* -------------------------------------------------------------------------- */

describe("gatherCandidate", () => {
  it("writes every record to the store, and the bundle's ids are the files on disk", async () => {
    // The acceptance test: closed-world citation is only real if the ids the
    // model is handed resolve to records a reviewer can open (ADR-0003).
    const root = scratch();
    const store = evidenceStore("run-2026-08-22", root);
    const { options } = harness(ROUTES, { store });
    const bundle = await gatherCandidate(candidate(), options);

    expect(bundle.evidence.length).toBeGreaterThan(5);
    for (const id of bundleIds(bundle)) {
      const path = store.path(id);
      expect(existsSync(path), path).toBe(true);
      const read = store.read(id);
      expect(read.ok, id).toBe(true);
      if (read.ok) expect(Evidence.parse(read.evidence).id).toBe(id);
    }
  });

  it("hands the extractor ids alongside text, and nothing it cannot cite", async () => {
    const { options } = harness();
    const bundle = await gatherCandidate(candidate(), options);
    const items = bundleItems(bundle);

    expect(items.length).toBe(bundle.evidence.length);
    for (const item of items) {
      expect(item.id).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof item.text).toBe("string");
    }
    // Transport detail is for the store, not for the model.
    expect(JSON.stringify(items)).not.toContain("from_cache");
  });

  it("reads the HN thread the candidate came from", async () => {
    const { stub, options } = harness();
    const bundle = await gatherCandidate(candidate(), options);

    expect(stub.to("news.ycombinator.com")).toEqual([THREAD]);
    expect(bundle.requests.hn).toBe(1);
    const thread = bundle.evidence.find((record) => record.type === "hn_item");
    expect(thread?.url).toBe(THREAD);
    expect(thread?.title).toBe("Show HN: Coroot");
  });

  it("says why there is no thread rather than pretending there is one", async () => {
    const { stub, options } = harness();
    const seeded = candidate({
      url: "https://coroot.com/",
      provenance: [{ ...candidate().provenance[0], source: "url_list", ref: null }],
    });
    const bundle = await gatherCandidate(seeded, options);

    expect(stub.to("news.ycombinator.com")).toEqual([]);
    expect(unknownFor(bundle, "hn.thread")).toContain("not sourced from an HN post");
  });

  it("joins a site candidate to its repository through the link on its page", async () => {
    const { stub, options } = harness();
    const bundle = await gatherCandidate(candidate(), options);

    expect(bundle.join.site).toEqual({ url: "https://coroot.com/", from: "candidate_url" });
    expect(bundle.join.github).toEqual({
      ref: { owner: "coroot", repo: "coroot", from: "github.com" },
      from: "site_link",
    });
    expect(stub.to("api.github.com").length).toBeGreaterThan(0);
  });

  it("joins a repository candidate to its site through `repo.homepage`", async () => {
    // The other direction of STATE inconsistency 45, and the field TICKET-0015
    // narrowed to `repo.homepage` on purpose.
    const { stub, options } = harness();
    const repoCandidate = candidate({
      slug: "coroot-repo",
      url: "https://github.com/coroot/coroot",
    });
    const bundle = await gatherCandidate(repoCandidate, options);

    expect(bundle.join.github).toEqual({
      ref: { owner: "coroot", repo: "coroot", from: "github.com" },
      from: "candidate_url",
    });
    expect(bundle.join.site).toEqual({ url: "https://coroot.com/", from: "github_homepage" });
    // The repo url itself is never fetched as if it were a company page.
    expect(stub.calls).not.toContain("https://github.com/coroot/coroot");
    expect(stub.to("coroot.com").length).toBeGreaterThan(0);
  });

  it("says so when a repository candidate declares no homepage", async () => {
    const routes: Record<string, Route> = {
      ...ROUTES,
      [`${GITHUB_API}/repos/nalgeon/redka`]: {
        body: json("repo-hobby.json"),
        contentType: "application/json",
      },
      [`${GITHUB_API}/users/nalgeon`]: {
        body: json("user-person.json"),
        contentType: "application/json",
      },
    };
    const { stub, options } = harness(routes);
    const bundle = await gatherCandidate(
      candidate({ slug: "redka", url: "https://github.com/nalgeon/redka" }, null),
      options,
    );

    expect(bundle.join.site).toBeNull();
    expect(unknownFor(bundle, "site")).toContain("declares no homepage");
    expect(stub.to("coroot.com")).toEqual([]);
    // And it is still a bundle: the repository was read.
    expect(usableEvidence(bundle).length).toBeGreaterThan(0);
  });

  it("produces a bundle when the site and GitHub both fail, and does not throw", async () => {
    // ARCHITECTURE §5 and TICKET-0017's own acceptance: a candidate with
    // nothing behind it is a low-coverage analysis, not a crash.
    const { options } = harness({});
    const bundle = await gatherCandidate(candidate(), options);

    expect(bundle.slug).toBe("coroot");
    expect(bundle.evidence.length).toBeGreaterThan(0);
    expect(bundle.evidence.every((record) => record.type === "fetch_failed")).toBe(true);
    expect(usableEvidence(bundle)).toEqual([]);
    expect(bundle.failures.map((failure) => failure.pool)).toContain("site");
    for (const failure of bundle.failures) expect(failure.reason.length).toBeGreaterThan(0);
    // A failed fetch is still citable — that is the point of the record type.
    expect(bundleIds(bundle).size).toBe(bundle.evidence.length);
  });

  it("reads the account behind a gist, and reports that there is no company page", async () => {
    // A gist is not a company page, but its author is a GitHub account — and
    // `GET /users/<owner>` carries `type`, the field that separated every
    // hobby project from every real company in the gate's 48 (inconsistency
    // 22). So the account is read and the missing page is stated.
    const routes: Record<string, Route> = {
      ...ROUTES,
      [`${GITHUB_API}/users/nullswan`]: {
        body: json("user-person.json"),
        contentType: "application/json",
      },
    };
    const { stub, options } = harness(routes);
    const bundle = await gatherCandidate(
      candidate({ slug: "gist", url: "https://gist.github.com/nullswan/abc123" }),
      options,
    );

    expect(bundle.join.site).toBeNull();
    expect(bundle.join.github?.ref.from).toBe("gist");
    expect(unknownFor(bundle, "site")).toContain("no repository to read a homepage from");
    expect(stub.to("api.github.com")).toEqual([`${GITHUB_API}/users/nullswan`]);
  });

  it("carries the adapters' signals, unknowns and people through unchanged", async () => {
    const { options } = harness();
    const bundle = await gatherCandidate(candidate(), options);
    const keys = new Set(bundle.signals.map((signal) => signal.key));
    const ids = bundleIds(bundle);

    expect(keys.has("github.stars")).toBe(true);
    expect(keys.has("github.owner_type")).toBe(true);
    // Every signal still resolves to a record in this bundle — the gather step
    // must not widen the closed world it hands on.
    for (const signal of bundle.signals) expect(ids.has(signal.evidence_id), signal.key).toBe(true);
    for (const unknown of bundle.unknowns) expect(unknown.reason.length).toBeGreaterThan(0);
    expect(bundle.people.length).toBeGreaterThan(0);
  });

  it("spends the plan it was given rather than the adapters' own defaults", async () => {
    const thin = planRun(40, "unauthenticated");
    const { stub, options } = harness();
    const bundle = await gatherCandidate(candidate(), { ...options, plan: thin });

    // A 40-candidate unauthenticated run is one GitHub call each, not two.
    expect(stub.to("api.github.com")).toEqual([`${GITHUB_API}/repos/coroot/coroot`]);
    expect(bundle.requests.github).toBe(1);
    expect(bundle.requests.site).toBeLessThanOrEqual(1 + thin.sitePages);
  });

  it("thins the site page budget too, once the run is large enough to need it", async () => {
    // 40 candidates does not thin it — 240 requests still divide into four
    // apiece. 120 does, and one page past the home page is what is left.
    expect(planRun(40, "unauthenticated").sitePages).toBe(3);
    const thin = planRun(120, "unauthenticated");
    expect(thin.sitePages).toBe(1);

    const { options } = harness();
    const bundle = await gatherCandidate(candidate(), { ...options, plan: thin });
    expect(bundle.requests.site).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* gatherRun                                                                   */
/* -------------------------------------------------------------------------- */

describe("gatherRun", () => {
  const many = (count: number): Candidate[] =>
    Array.from({ length: count }, (_, index) =>
      candidate({ slug: `coroot-${index}`, name: `Coroot ${index}` }, `4100${index}`),
    );

  it("returns bundles in candidate order, whatever order they finished in", async () => {
    const { stub, options } = harness();
    const candidates = many(9);
    const result = await gatherRun(candidates, { ...options, concurrency: 4 });

    expect(result.bundles.map((bundle) => bundle.slug)).toEqual(candidates.map((one) => one.slug));
    expect(stub.calls.length).toBeGreaterThan(9);
  });

  it("plans one budget for the whole run, so position in the list buys nothing", async () => {
    const { options } = harness();
    const result = await gatherRun(many(40), { ...options, auth: AUTH.unauthenticated });

    expect(result.plan.candidates).toBe(40);
    expect(result.plan.github).toEqual(["repo"]);
    // Inconsistency 60's arithmetic, now the other way round: 40 requests
    // against a 60/hour limit rather than 80.
    expect(result.requests.github.spent).toBeLessThanOrEqual(60);
    const spend = result.bundles.map((bundle) => bundle.requests.github);
    expect(new Set(spend).size).toBe(1);
  });

  it("counts what every candidate spent against one shared meter", async () => {
    const { options } = harness();
    const result = await gatherRun(many(5), options);
    const summed = result.bundles.reduce((total, bundle) => total + bundle.requests.site, 0);
    expect(result.requests.site.spent).toBe(summed);
    expect(result.requests.hn.spent).toBe(5);
    expect(result.requests.hn.limit).toBeNull();
  });

  it("stops calling GitHub at the wall and says why, instead of being rate-limited", async () => {
    const { stub, options } = harness();
    // Three requests for four candidates: the first three read their repo and
    // the fourth is refused. The plan cannot know how many retries a real
    // network will add, so the meter is the wall and the plan is not.
    const result = await gatherRun(many(4), {
      ...options,
      auth: AUTH.unauthenticated,
      concurrency: 1,
      plan: { ...planRun(4, "unauthenticated"), github: ["repo"] },
      limits: { github: 3, site: SITE_RUN_CEILING, hn: null },
    });

    expect(result.requests.github.spent).toBe(3);
    expect(stub.to("api.github.com")).toHaveLength(3);

    const refused = result.bundles.filter((bundle) =>
      bundle.unknowns.some((unknown) => unknown.reason.includes("run GitHub request budget spent")),
    );
    expect(refused).toHaveLength(1);
    // A refused candidate is still a bundle, with its site and its thread in
    // it — the budget costs coverage on one axis, not the whole candidate.
    const last = refused[0] as Bundle;
    expect(last.slug).toBe("coroot-3");
    expect(usableEvidence(last).length).toBeGreaterThan(0);
    expect(last.join.github).toBeNull();
  });

  it("survives a run of candidates with nothing behind any of them", async () => {
    const { options } = harness({});
    const result = await gatherRun(many(3), options);
    expect(result.bundles).toHaveLength(3);
    for (const bundle of result.bundles) expect(usableEvidence(bundle)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* No model in 2a                                                              */
/* -------------------------------------------------------------------------- */

describe("stage 2a contains no LLM call", () => {
  /** Every local module reachable from an entry point, transitively. */
  function importGraph(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(entry)];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const specifier = match[1] as string;
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      }
    }
    return [...seen];
  }

  it("cannot reach `src/llm/` from the gather module at all", () => {
    // Stated as a property of the import graph rather than as a comment: 2a is
    // a separate module from 2b precisely so this is checkable. A stub that
    // fails when called would pass just as well if the stub were wrong.
    const graph = importGraph(join(import.meta.dirname, "..", "src", "analyse", "gather.ts"));
    expect(graph.length).toBeGreaterThan(5);
    expect(graph.filter((file) => file.includes(`${"src"}/llm/`))).toEqual([]);
    expect(graph.some((file) => file.endsWith("evidence/github.ts"))).toBe(true);
  });

  it("names no prompt and no model role", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "analyse", "gather.ts"),
      "utf8",
    );
    for (const forbidden of ["callModel", "prompts/", "invoke("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
