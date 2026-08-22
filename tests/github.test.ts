import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GithubAuth, GithubMode } from "../src/config.js";
import {
  ALL_CALLS,
  CHEAP_CALLS,
  CONTRIBUTORS_PER_PAGE,
  CommitActivity,
  commitActivityApiUrl,
  contributorsApiUrl,
  decodeReadme,
  defaultCalls,
  type GatherGithubOptions,
  GITHUB_API,
  GithubContributors,
  GithubOwner,
  GithubReadme,
  GithubRepo,
  gatherGithub,
  ownerApiUrl,
  parseGithubRef,
  projectCadence,
  projectContributors,
  projectOwner,
  projectReadme,
  projectRepo,
  RESERVED_OWNERS,
  type RepoRef,
  readmeApiUrl,
  repoApiUrl,
  summariseCadence,
  summariseContributors,
} from "../src/evidence/github.js";
import { EVIDENCE_TEXT_LIMIT, evidenceId } from "../src/evidence/store.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "github", name), "utf8"));

const coroot = GithubRepo.parse(fixture("repo-with-homepage.json"));
const bpfsnitch = GithubRepo.parse(fixture("repo-hobby.json"));
const org = GithubOwner.parse(fixture("user-organization.json"));
const person = GithubOwner.parse(fixture("user-person.json"));
const foundation = GithubOwner.parse(fixture("user-foundation.json"));

const ref = (owner: string, repo: string | null = null): RepoRef => ({
  owner,
  repo,
  from: "github.com",
});

describe("parseGithubRef", () => {
  it.each([
    ["https://github.com/coroot/coroot", "coroot", "coroot"],
    ["https://www.github.com/coroot/coroot/", "coroot", "coroot"],
    ["http://github.com/coroot/coroot", "coroot", "coroot"],
    ["https://github.com/coroot", "coroot", null],
    ["https://github.com/coroot/coroot.git", "coroot", "coroot"],
  ])("%s → %s/%s", (url, owner, repo) => {
    expect(parseGithubRef(url)).toEqual({ owner, repo, from: "github.com" });
  });

  it("ignores anything past owner and repo, rather than rejecting it", () => {
    // The gate's fix F3 truncates these in stage 1; this module must not
    // depend on that having happened, because it does not import stage 1.
    expect(parseGithubRef("https://github.com/HelixDB/helix-db/tree/main")).toEqual({
      owner: "HelixDB",
      repo: "helix-db",
      from: "github.com",
    });
    expect(parseGithubRef("https://github.com/alibaba/anolis/blob/main/docs/x.md")?.repo).toBe(
      "anolis",
    );
  });

  it("keeps the case the url used — GitHub's lookup is case-insensitive", () => {
    expect(parseGithubRef("https://github.com/HelixDB/Helix-DB")?.owner).toBe("HelixDB");
  });

  it("reads a Pages host as the account that publishes it", () => {
    expect(parseGithubRef("https://acme.github.io/tracer")).toEqual({
      owner: "acme",
      repo: "tracer",
      from: "github.io",
    });
    // A bare Pages host is published from the repo named after the host.
    expect(parseGithubRef("https://acme.github.io")).toEqual({
      owner: "acme",
      repo: "acme.github.io",
      from: "github.io",
    });
  });

  it("takes the author of a gist and no repository", () => {
    expect(parseGithubRef("https://gist.github.com/nullswan/abc123")).toEqual({
      owner: "nullswan",
      repo: null,
      from: "gist",
    });
  });

  it.each([
    "https://coroot.com",
    "https://gitlab.com/acme/acme",
    "https://github.com",
    "ftp://github.com/acme/acme",
    "not a url",
  ])("has no account behind %s", (url) => {
    expect(parseGithubRef(url)).toBeNull();
  });

  it.each(RESERVED_OWNERS)("does not read github.com/%s as an account", (reserved) => {
    expect(parseGithubRef(`https://github.com/${reserved}/anything`)).toBeNull();
  });

  it("rejects a path segment that cannot be a GitHub name", () => {
    expect(parseGithubRef("https://github.com/.hidden/x")).toBeNull();
    // A repo segment that cannot be a name leaves the owner standing, because
    // `GET /users/<owner>` is still worth making.
    expect(parseGithubRef("https://github.com/acme/@releases")).toEqual({
      owner: "acme",
      repo: null,
      from: "github.com",
    });
  });
});

describe("api urls", () => {
  it("builds the five calls from one ref", () => {
    const r = ref("coroot", "coroot");
    expect(repoApiUrl(r)).toBe(`${GITHUB_API}/repos/coroot/coroot`);
    expect(ownerApiUrl(r)).toBe(`${GITHUB_API}/users/coroot`);
    expect(readmeApiUrl(r)).toBe(`${GITHUB_API}/repos/coroot/coroot/readme`);
    expect(contributorsApiUrl(r)).toBe(
      `${GITHUB_API}/repos/coroot/coroot/contributors?per_page=${CONTRIBUTORS_PER_PAGE}`,
    );
    expect(commitActivityApiUrl(r)).toBe(`${GITHUB_API}/repos/coroot/coroot/stats/commit_activity`);
  });

  it("has only the owner call for a ref with no repo", () => {
    const r = ref("coroot");
    expect(ownerApiUrl(r)).toBe(`${GITHUB_API}/users/coroot`);
    for (const url of [repoApiUrl(r), readmeApiUrl(r), contributorsApiUrl(r)]) {
      expect(url).toBeNull();
    }
  });

  it("matches the urls the fixtures were captured from", () => {
    const captured = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "capture.json"), "utf8"),
    ) as { fixtures: { path: string; url: string | null }[] };
    const urlOf = (path: string) => captured.fixtures.find((f) => f.path === path)?.url;
    const r = ref("coroot", "coroot");
    expect(urlOf("github/repo-with-homepage.json")).toBe(repoApiUrl(r));
    expect(urlOf("github/user-organization.json")).toBe(ownerApiUrl(r));
    expect(urlOf("github/readme-coroot.json")).toBe(readmeApiUrl(r));
    expect(urlOf("github/contributors-coroot.json")).toBe(contributorsApiUrl(r));
    expect(urlOf("github/commit-activity-coroot.json")).toBe(commitActivityApiUrl(r));
  });
});

describe("response schemas", () => {
  it("reads the fields the rubric is owed off a real repo payload", () => {
    expect(coroot.full_name).toBe("coroot/coroot");
    expect(coroot.homepage).toBe("https://coroot.com");
    expect(coroot.owner.type).toBe("Organization");
    expect(coroot.license?.spdx_id).toBe("Apache-2.0");
    expect(coroot.stargazers_count).toBe(7884);
    expect(coroot.created_at).toBe("2022-08-22T14:59:07Z");
    expect(coroot.topics).toContain("observability");
  });

  it("keeps an empty homepage empty rather than calling it a site", () => {
    // The real payload says `""`, not null. Only a capture teaches that.
    expect(bpfsnitch.homepage).toBe("");
    expect(bpfsnitch.owner.type).toBe("User");
    expect(bpfsnitch.archived).toBe(true);
  });

  it("separates an organisation from a person, and keeps the foundation a fact", () => {
    expect(org.type).toBe("Organization");
    expect(person.type).toBe("User");
    // STATE inconsistency 22: an org that is a foundation, not a company. The
    // adapter reports `type`; deciding what it means is the rubric's job.
    expect(foundation.type).toBe("Organization");
    expect(foundation.name).toBe("CCF Open Source");
  });

  it("survives a payload missing every optional field", () => {
    const thin = GithubRepo.parse({ full_name: "a/b", name: "b", owner: { login: "a" } });
    expect(thin.stargazers_count).toBeNull();
    expect(thin.homepage).toBeNull();
    expect(thin.owner.type).toBeNull();
  });

  it("refuses a payload with no identity at all", () => {
    expect(GithubRepo.safeParse({ name: "b" }).success).toBe(false);
    expect(GithubOwner.safeParse({}).success).toBe(false);
  });
});

describe("projectRepo", () => {
  const projection = projectRepo(coroot);

  it("renders the metadata the model reads, and nothing it does not", () => {
    expect(projection.title).toBe("coroot/coroot");
    expect(projection.text).toContain("stars: 7884");
    expect(projection.text).toContain("homepage: https://coroot.com");
    expect(projection.text).toContain("owner type: Organization");
    expect(projection.text).toContain("license: Apache-2.0");
    // 7 KB of API urls is what a verbatim record would have held.
    expect(projection.text.length).toBeLessThan(1_000);
    expect(projection.text).not.toContain("api.github.com");
  });

  it("names the renderer, so a record says how its text was made", () => {
    expect(projection.meta.projection).toBe("github_repo.v1");
  });

  it("writes a missing field as unknown, never as a zero or a blank", () => {
    const text = projectRepo(bpfsnitch).text;
    expect(text).toContain("homepage: unknown");
    // NOASSERTION is GitHub saying it could not identify the licence.
    expect(text).toContain("license: unknown");
    expect(text).toContain("archived: true");
  });
});

describe("projectOwner", () => {
  it("carries type and website, the two fields the gate handed forward", () => {
    const text = projectOwner(org).text;
    expect(text).toContain("type: Organization");
    expect(text).toContain("website: https://coroot.com");
    expect(projectOwner(org).meta.account_type).toBe("Organization");
  });

  it("falls back to the login when an account has no display name", () => {
    expect(projectOwner(person).title).toBe("nullswan");
    expect(projectOwner(person).text).toContain("name: unknown");
  });
});

describe("readme", () => {
  const payload = GithubReadme.parse(fixture("readme-coroot.json"));

  it("decodes base64 out of the envelope", () => {
    const markdown = decodeReadme(payload);
    expect(markdown).toContain("Coroot");
    expect(markdown?.length).toBe(payload.size);
  });

  it("stores the markdown, not the response", () => {
    const markdown = decodeReadme(payload) ?? "";
    const projection = projectReadme(payload, markdown);
    expect(projection.text).toBe(markdown);
    expect(projection.text).not.toContain('"encoding"');
    expect(projection.meta.source_bytes).toBe(payload.size);
  });

  it("has no README rather than a broken one, on an encoding it does not know", () => {
    expect(decodeReadme(GithubReadme.parse({ content: "x", encoding: "gzip" }))).toBeNull();
    expect(decodeReadme(GithubReadme.parse({}))).toBeNull();
    // An empty file is not a README either.
    expect(
      decodeReadme(GithubReadme.parse({ content: "ICAgCg==", encoding: "base64" })),
    ).toBeNull();
  });
});

describe("contributors", () => {
  const contributors = GithubContributors.parse(fixture("contributors-coroot.json"));

  it("counts the page and separates the bots in it", () => {
    const summary = summariseContributors(contributors);
    expect(summary.count).toBe(33);
    expect(summary.capped).toBe(false);
    // A real list has `dependabot[bot]` in it; a "33 contributors" claim that
    // counts it is a claim about a robot.
    expect(summary.bots).toBe(1);
    expect(summary.humans).toBe(32);
    expect(summary.top[0]?.login).toBe("def");
    expect(summary.top).toHaveLength(5);
  });

  it("says a full page is a floor rather than a count", () => {
    const page = contributors.slice(0, 3);
    const summary = summariseContributors(page, 3);
    expect(summary.capped).toBe(true);
    expect(projectContributors(summary).text).toContain("3 or more");
  });

  it("renders the top contributors and their commit counts", () => {
    const text = projectContributors(summariseContributors(contributors)).text;
    expect(text).toContain("contributors on the first page: 33");
    expect(text).toContain("bot accounts: 1");
    expect(text).toContain("def (782 commits)");
    expect(text).not.toContain("dependabot");
  });
});

describe("commit activity", () => {
  const weeks = CommitActivity.parse(fixture("commit-activity-coroot.json"));

  it("reads 52 dated weeks", () => {
    expect(weeks).toHaveLength(52);
    expect(weeks[0]?.week).toBeGreaterThan(0);
  });

  it("summarises volume, pulse and recency separately", () => {
    const summary = summariseCadence(weeks);
    expect(summary.weeks).toBe(52);
    expect(summary.commits_total).toBe(197);
    expect(summary.active_weeks).toBeGreaterThan(0);
    expect(summary.active_weeks).toBeLessThanOrEqual(52);
    expect(summary.commits_last_12_weeks).toBeLessThanOrEqual(summary.commits_total);
    // The cadence signal is dated by the week GitHub itself stamped.
    expect(summary.last_active_week).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("has no last active week on a repo that committed nothing all year", () => {
    const silent = weeks.map((week) => ({ ...week, total: 0, days: [0, 0, 0, 0, 0, 0, 0] }));
    const summary = summariseCadence(silent);
    expect(summary.active_weeks).toBe(0);
    expect(summary.last_active_week).toBeNull();
    expect(projectCadence(summary).text).toContain("most recent week with a commit: unknown");
  });

  it("refuses the 202 body — an empty object is not an activity list", () => {
    expect(CommitActivity.safeParse({}).success).toBe(false);
    expect(CommitActivity.safeParse([]).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The calls                                                                   */
/* -------------------------------------------------------------------------- */

const AT = new Date("2026-08-22T12:00:00.000Z");
const CANDIDATE = "https://github.com/coroot/coroot";

const raw = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", "github", name), "utf8");

const AUTH: Record<GithubMode, GithubAuth> = {
  unauthenticated: {
    token: null,
    mode: "unauthenticated",
    note: "GITHUB_TOKEN not set — 60 GitHub requests/hour",
    toJSON: () => ({ mode: "unauthenticated", note: "" }),
  },
  authenticated: {
    token: "ghp_notarealtokenatall0000",
    mode: "authenticated",
    note: "GITHUB_TOKEN present — 5000 GitHub requests/hour.",
    toJSON: () => ({ mode: "authenticated", note: "" }),
  },
};

/** Replies from a url → body table; anything not in it is a 404. */
function api(routes: Record<string, { status?: number; body?: string }>) {
  const calls: string[] = [];
  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url);
    headers.push(new Headers(init.headers).get("authorization"));
    const route = routes[url];
    if (route === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    const status = route.status ?? 200;
    // 204 and 205 are null-body statuses; `new Response("")` throws on them,
    // which is the runtime being stricter than a hand-written stub would be.
    return new Response(status === 204 || status === 205 ? null : (route.body ?? ""), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const headers: (string | null)[] = [];
  return { transport, calls, headers };
}

const ALL_ROUTES: Record<string, { status?: number; body?: string }> = {
  [`${GITHUB_API}/repos/coroot/coroot`]: { body: raw("repo-with-homepage.json") },
  [`${GITHUB_API}/users/coroot`]: { body: raw("user-organization.json") },
  [`${GITHUB_API}/repos/coroot/coroot/readme`]: { body: raw("readme-coroot.json") },
  [`${GITHUB_API}/repos/coroot/coroot/contributors?per_page=100`]: {
    body: raw("contributors-coroot.json"),
  },
  [`${GITHUB_API}/repos/coroot/coroot/stats/commit_activity`]: {
    body: raw("commit-activity-coroot.json"),
  },
};

function gather(
  routes: Record<string, { status?: number; body?: string }>,
  over: Partial<GatherGithubOptions> = {},
) {
  const stub = api(routes);
  const refFor = parseGithubRef(CANDIDATE) as RepoRef;
  return {
    stub,
    run: () =>
      gatherGithub(refFor, {
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
      }),
  };
}

describe("defaultCalls", () => {
  it("reads two endpoints without a token and five with one", () => {
    // 12 candidates x 5 calls is exactly the unauthenticated hourly limit, so
    // the last candidate in a run would be rate-limited by the first.
    expect(defaultCalls("unauthenticated")).toEqual(["repo", "owner"]);
    expect(defaultCalls("authenticated")).toEqual(ALL_CALLS);
    expect(CHEAP_CALLS.length * 12).toBeLessThan(60);
    expect(ALL_CALLS.length * 12).toBeGreaterThanOrEqual(60);
  });
});

describe("gatherGithub", () => {
  it("reads all five endpoints and writes one evidence record each", async () => {
    const { stub, run } = gather(ALL_ROUTES);
    const result = await run();

    expect(stub.calls).toHaveLength(5);
    expect(result.requests).toBe(5);
    expect(result.failures).toEqual([]);
    expect(result.evidence).toHaveLength(5);
    expect(result.evidence.map((e) => e.type)).toEqual([
      "github_repo",
      "github_user",
      "github_repo",
      "github_repo",
      "github_repo",
    ]);
    // Every record is addressed by the url it was fetched from and the moment
    // it was fetched — the store's own rule, checked here because this adapter
    // builds records by hand rather than through `fetchEvidence`.
    for (const record of result.evidence) {
      expect(record.id).toBe(evidenceId(record.url, record.retrieved_at));
      expect(record.retrieved_at).toBe(AT.toISOString());
      expect(record.text.length).toBeLessThanOrEqual(EVIDENCE_TEXT_LIMIT);
    }
  });

  it("makes the join stage 1 cannot make", async () => {
    // STATE inconsistency 45: Coroot took three of twelve slots on one gate run
    // and no url said they were one company. This field does.
    const { run } = gather(ALL_ROUTES);
    expect((await run()).homepage).toEqual({ url: "https://coroot.com/", source: "repo" });
  });

  it("dates every signal it emits, and gives a reason for every one it does not", async () => {
    const { run } = gather(ALL_ROUTES);
    const result = await run();
    const ids = new Set(result.evidence.map((e) => e.id));

    expect(result.signals.length).toBeGreaterThan(20);
    for (const signal of result.signals) {
      expect(signal.as_of, signal.key).toBe(AT.toISOString());
      // A signal the memo cannot cite is a signal the memo cannot use.
      expect(ids.has(signal.evidence_id), signal.key).toBe(true);
    }
    for (const unknown of result.unknowns) expect(unknown.reason.length).toBeGreaterThan(0);
  });

  it("carries the fields the gate handed forward", async () => {
    const { run } = gather(ALL_ROUTES);
    const by = new Map((await run()).signals.map((s) => [s.key, s.value]));
    expect(by.get("github.owner_type")).toBe("Organization");
    expect(by.get("github.stars")).toBe(7884);
    expect(by.get("github.license")).toBe("Apache-2.0");
    expect(by.get("github.human_contributors")).toBe(32);
    expect(by.get("github.commits_last_year")).toBe(197);
    expect(by.get("github.age_days")).toBe(1460);
    expect(by.get("github.stars_per_day_lifetime")).toBe(5.4);
  });

  it("sends the token when there is one and never writes it into a record", async () => {
    const { stub, run } = gather(ALL_ROUTES, { auth: AUTH.authenticated });
    const result = await run();
    expect(stub.headers.every((value) => value === "Bearer ghp_notarealtokenatall0000")).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain("ghp_");
  });

  it("reads two endpoints unauthenticated and says what it did not read", async () => {
    const { stub, run } = gather(ALL_ROUTES, { auth: AUTH.unauthenticated });
    const result = await run();

    expect(stub.calls).toHaveLength(2);
    expect(stub.headers).toEqual([null, null]);
    expect(result.mode).toBe("unauthenticated");
    // Degraded mode is visible in the output, not only in a note.
    const missed = new Map(result.unknowns.map((u) => [u.key, u.reason]));
    for (const call of ["github.readme", "github.contributors", "github.commit_activity"]) {
      expect(missed.get(call)).toContain("not read");
    }
  });

  it("keeps the account when the repository 404s, and asks for nothing under it", async () => {
    const { stub, run } = gather({
      [`${GITHUB_API}/users/coroot`]: ALL_ROUTES[`${GITHUB_API}/users/coroot`] as { body: string },
    });
    const result = await run();

    // repo (404) and owner. The three calls under the repo are not attempted.
    expect(stub.calls).toEqual([`${GITHUB_API}/repos/coroot/coroot`, `${GITHUB_API}/users/coroot`]);
    expect(result.failures.map((f) => f.call)).toEqual(["repo"]);
    expect(result.failures[0]?.status).toBe(404);
    // ARCHITECTURE §5: a failed fetch is a record, not an absence.
    expect(result.evidence.map((e) => e.type)).toEqual(["fetch_failed", "github_user"]);
    expect(result.signals.some((s) => s.key === "github.owner_type")).toBe(true);
    const missed = new Map(result.unknowns.map((u) => [u.key, u.reason]));
    expect(missed.get("github.readme")).toContain("the repository could not be read");
  });

  it("does not promote the account's own site to a company site", async () => {
    const stub = api({ [`${GITHUB_API}/users/nullswan`]: { body: raw("user-person.json") } });
    const result = await gatherGithub(
      { owner: "nullswan", repo: null, from: "github.com" },
      {
        auth: AUTH.authenticated,
        http: { transport: stub.transport, cacheDir: "", now: () => AT, retry: { retries: 0 } },
      },
    );
    // `blog: "nullswan.io"` is a real url and a real signal, and it is not this
    // account's product. The first live run met the sharper version of the same
    // thing — a `blog` that is a LinkedIn profile — and TICKET-0016 must not be
    // sent to extract founders from a personal page (SCOPE cut corner 1).
    expect(result.homepage).toBeNull();
    const site = result.signals.find((s) => s.key === "github.owner_site");
    expect(site?.value).toBe("https://nullswan.io/");
    expect(site?.derived_from).toContain("stronger route");
  });

  it("treats a 202 from the statistics endpoint as not-yet, not as a failure", async () => {
    const { run } = gather({
      ...ALL_ROUTES,
      [`${GITHUB_API}/repos/coroot/coroot/stats/commit_activity`]: { status: 202, body: "{}" },
    });
    const result = await run();

    // The one shape that cannot be captured as a fixture: it depends on whether
    // GitHub's cache is warm. It answered 202 twice while the fixture was taken.
    const failure = result.failures.find((f) => f.call === "commit_activity");
    expect(failure?.status).toBe(202);
    expect(failure?.reason).toContain("still computing");
    expect(result.evidence.map((e) => e.type)).not.toContain("fetch_failed");
    expect(result.signals.some((s) => s.key.startsWith("github.commits"))).toBe(false);
    // The other four calls are unaffected.
    expect(result.evidence).toHaveLength(4);
  });

  it("reads a 204 as an empty list rather than an unreadable body", async () => {
    const { run } = gather({
      ...ALL_ROUTES,
      [`${GITHUB_API}/repos/coroot/coroot/contributors?per_page=100`]: { status: 204, body: "" },
    });
    const by = new Map((await run()).signals.map((s) => [s.key, s.value]));
    expect(by.get("github.contributors")).toBe(0);
    expect(by.get("github.human_contributors")).toBe(0);
  });

  it("records a 200 whose body is not the shape it expects, and keeps going", async () => {
    const { run } = gather({
      ...ALL_ROUTES,
      [`${GITHUB_API}/repos/coroot/coroot`]: { body: '{"nope":1}' },
    });
    const result = await run();
    const failure = result.failures.find((f) => f.call === "repo");
    expect(failure?.status).toBe(200);
    expect(failure?.reason).toContain("unexpected payload");
    // Malformed is not the same as unreachable: nothing was cited, and no
    // `fetch_failed` record claims the request failed, because it did not.
    expect(result.evidence.some((e) => e.type === "fetch_failed")).toBe(false);
    expect(result.signals.some((s) => s.key === "github.owner_type")).toBe(true);
  });

  it("asks for nothing under a repository the url never named", async () => {
    const stub = api({
      [`${GITHUB_API}/users/coroot`]: ALL_ROUTES[`${GITHUB_API}/users/coroot`] as { body: string },
    });
    const result = await gatherGithub(
      { owner: "coroot", repo: null, from: "github.com" },
      {
        auth: AUTH.authenticated,
        http: { transport: stub.transport, cacheDir: "", now: () => AT, retry: { retries: 0 } },
      },
    );
    expect(stub.calls).toEqual([`${GITHUB_API}/users/coroot`]);
    const missed = new Map(result.unknowns.map((u) => [u.key, u.reason]));
    expect(missed.get("github.repo")).toContain("without a repository");
  });

  it("has a projection in every record's meta, so a reader can tell text from response", async () => {
    const { run } = gather(ALL_ROUTES);
    for (const record of (await run()).evidence) {
      expect(record.meta.projection, record.url).toBeTypeOf("string");
      expect(record.meta.call, record.url).toBeTypeOf("string");
    }
  });
});
