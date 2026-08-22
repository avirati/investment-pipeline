import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTORS_PER_PAGE,
  CommitActivity,
  commitActivityApiUrl,
  contributorsApiUrl,
  decodeReadme,
  GITHUB_API,
  GithubContributors,
  GithubOwner,
  GithubReadme,
  GithubRepo,
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
