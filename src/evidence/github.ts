import { z } from "zod";

/**
 * The GitHub adapter (TICKET-0015). ADR-0004 makes GitHub the enrichment
 * surface, and SPEC §2 puts it behind three of the five dimensions: technical
 * depth (D1), pull (D3) and the accumulating-asset read (D5). It is also where
 * the two defects the TICKET-0013 gate handed forward get fixed — `owner.type`
 * separates a weekend project from a company (inconsistency 22) and `homepage`
 * is the repo ↔ company-site join stage 1 structurally cannot make
 * (inconsistency 45).
 *
 * Four rules hold in this file:
 *
 * 1. **Everything the rubric reads carries a date.** SPEC D3 scores an undated
 *    claim at 0, so an undated metric is not merely useless, it is a trap: it
 *    looks like a signal and scores like a lie. Every metric is emitted with
 *    the moment it was observed, and a metric that cannot be dated or computed
 *    is not emitted at all — it goes to `unknowns` with a reason (CLAUDE.md
 *    invariant 4).
 *
 * 2. **The evidence text is a projection, not the response.** `GET /repos/…`
 *    is 7 KB of API urls the model has no use for and `…/contributors` is 36 KB
 *    of avatar links; both would blow past `EVIDENCE_TEXT_LIMIT` and be
 *    truncated at an arbitrary byte. So each payload is rendered to a compact
 *    `key: value` block and `meta.projection` names the renderer that produced
 *    it. This is the same departure `extractHtml` already makes for a web page
 *    (STATE inconsistency 18): the record still holds exactly what the model
 *    saw, and says how it was made.
 *
 * 3. **Failure is not an error.** ARCHITECTURE §5: a repo that 404s, an owner
 *    that no longer exists, a statistics endpoint that answers 202 because
 *    GitHub has not finished computing — each is a recorded outcome, never a
 *    thrown one. A candidate with no GitHub presence is the ordinary case.
 *
 * 4. **This module concludes nothing.** It reads fields and computes
 *    arithmetic over them. It has no keyword list, no threshold and no opinion
 *    about what a good repo looks like: the thesis lives in exactly one place
 *    (CLAUDE.md invariant 7) and it is not here.
 */

/* -------------------------------------------------------------------------- */
/* Which repository                                                            */
/* -------------------------------------------------------------------------- */

export const GITHUB_API = "https://api.github.com";

/** GitHub's documented pinning headers — the same pair the capture script sends. */
export const GITHUB_API_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

/**
 * Path segments that are GitHub's own, not an account's. A candidate url of
 * `github.com/topics/ebpf` would otherwise resolve to an owner called
 * "topics".
 *
 * The ninth hand-written list in this codebase and the same class of guess as
 * `REPO_SUBPATHS` and `SHARED_SUFFIXES` in `src/source/resolve.ts`. It fails
 * safe in the cheap direction: an unlisted reserved word costs one request that
 * 404s and yields no evidence, which is exactly what a candidate with no GitHub
 * presence already costs.
 */
export const RESERVED_OWNERS = [
  "about",
  "account",
  "apps",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "settings",
  "sessions",
  "signup",
  "site",
  "sponsors",
  "stars",
  "topics",
  "trending",
];

/**
 * An owner, and the repository under it when the url named one.
 *
 * `repo` is nullable because a bare `github.com/acme` is a real candidate url
 * and an owner on its own is still worth a `GET /users/acme` — that one call
 * carries `type`, which is the discriminator inconsistency 22 is about.
 */
export interface RepoRef {
  owner: string;
  repo: string | null;
  /** Which url shape this came from. Recorded so a reviewer can see the guess. */
  from: "github.com" | "github.io" | "gist";
}

/**
 * A candidate url reduced to the account behind it, or null when there is no
 * GitHub account behind it.
 *
 * Deliberately *not* imported from `src/source/resolve.ts`, which does the same
 * kind of work for stage 1: that module is stage 1's internals and CLAUDE.md
 * invariant 5 keeps stages from reaching into each other. The cost is a second
 * small path parser; the benefit is that stage 2 keeps working if stage 1's
 * canonicalisation changes under it.
 *
 * Anything past the first two segments is ignored rather than rejected —
 * `github.com/HelixDB/helix-db/tree/main` is a real company and `/tree/main` is
 * just how a repo link gets pasted (the argument is written out at
 * `REPO_SUBPATHS`, and stage 1 has usually truncated it already).
 */
export function parseGithubRef(url: string): RepoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  const clean = (name: string | undefined): string | null => {
    if (name === undefined) return null;
    const trimmed = name.replace(/\.git$/i, "").trim();
    // GitHub's own rule for both accounts and repositories, minus the length
    // cap: a segment that cannot be a name is a page, not an account.
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) ? trimmed : null;
  };

  if (host === "github.com") {
    const owner = clean(segments[0]);
    if (owner === null || RESERVED_OWNERS.includes(owner.toLowerCase())) return null;
    return { owner, repo: clean(segments[1]), from: "github.com" };
  }

  if (host === "gist.github.com") {
    const owner = clean(segments[0]);
    // A gist has no repository worth reading, but its author is still an
    // account, and `type` is the field that matters most on a thin candidate.
    return owner === null ? null : { owner, repo: null, from: "gist" };
  }

  if (host.endsWith(".github.io")) {
    const owner = clean(host.slice(0, -".github.io".length));
    if (owner === null) return null;
    // `acme.github.io/thing` is published from `acme/thing`; `acme.github.io`
    // itself is published from the repo named after the host.
    return { owner, repo: clean(segments[0]) ?? host, from: "github.io" };
  }

  return null;
}

export function repoApiUrl(ref: RepoRef): string | null {
  return ref.repo === null ? null : `${GITHUB_API}/repos/${ref.owner}/${ref.repo}`;
}

export function ownerApiUrl(ref: RepoRef): string {
  return `${GITHUB_API}/users/${ref.owner}`;
}

export function readmeApiUrl(ref: RepoRef): string | null {
  const base = repoApiUrl(ref);
  return base === null ? null : `${base}/readme`;
}

/** One page. Its length is the count when short of the page size, a floor when not. */
export const CONTRIBUTORS_PER_PAGE = 100;

export function contributorsApiUrl(ref: RepoRef): string | null {
  const base = repoApiUrl(ref);
  return base === null ? null : `${base}/contributors?per_page=${CONTRIBUTORS_PER_PAGE}`;
}

export function commitActivityApiUrl(ref: RepoRef): string | null {
  const base = repoApiUrl(ref);
  return base === null ? null : `${base}/stats/commit_activity`;
}

/* -------------------------------------------------------------------------- */
/* What the API returns                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Absent and null are the same answer — "GitHub did not say" — and both must
 * survive the parse, because a schema that rejects a payload for a field this
 * pipeline does not read would throw away the fields it does.
 */
const nullable = <T extends z.ZodType>(inner: T) =>
  inner.nullish().transform((value) => value ?? null);

const GithubLicense = z.object({
  spdx_id: nullable(z.string()),
  name: nullable(z.string()),
});

const GithubOwnerStub = z.object({
  login: z.string().min(1),
  type: nullable(z.string()),
  html_url: nullable(z.string()),
});

export const GithubRepo = z.object({
  full_name: z.string().min(1),
  name: z.string().min(1),
  owner: GithubOwnerStub,
  html_url: nullable(z.string()),
  description: nullable(z.string()),
  /** `""` on a repo that never set one — the missing-data path for the join. */
  homepage: nullable(z.string()),
  language: nullable(z.string()),
  license: nullable(GithubLicense),
  topics: nullable(z.array(z.string())),
  stargazers_count: nullable(z.number()),
  forks_count: nullable(z.number()),
  subscribers_count: nullable(z.number()),
  open_issues_count: nullable(z.number()),
  created_at: nullable(z.string()),
  pushed_at: nullable(z.string()),
  archived: nullable(z.boolean()),
  fork: nullable(z.boolean()),
  default_branch: nullable(z.string()),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

export const GithubOwner = z.object({
  login: z.string().min(1),
  /** `"Organization"` or `"User"`. STATE inconsistency 22's discriminator. */
  type: nullable(z.string()),
  name: nullable(z.string()),
  /** The owner's own site. A second route to the company page. */
  blog: nullable(z.string()),
  company: nullable(z.string()),
  bio: nullable(z.string()),
  location: nullable(z.string()),
  html_url: nullable(z.string()),
  public_repos: nullable(z.number()),
  followers: nullable(z.number()),
  created_at: nullable(z.string()),
});
export type GithubOwner = z.infer<typeof GithubOwner>;

export const GithubReadme = z.object({
  name: nullable(z.string()),
  path: nullable(z.string()),
  html_url: nullable(z.string()),
  size: nullable(z.number()),
  content: nullable(z.string()),
  encoding: nullable(z.string()),
});
export type GithubReadme = z.infer<typeof GithubReadme>;

export const GithubContributor = z.object({
  login: z.string().min(1),
  /** `"User"` or `"Bot"` — `dependabot[bot]` is in a real contributor list. */
  type: nullable(z.string()),
  contributions: nullable(z.number()),
});
export type GithubContributor = z.infer<typeof GithubContributor>;
export const GithubContributors = z.array(GithubContributor);

/** One week of `stats/commit_activity`: a boundary, a total, seven days. */
export const CommitWeek = z.object({
  /** Unix seconds at the start of the week. The date on the cadence signal. */
  week: z.number(),
  total: z.number(),
  days: nullable(z.array(z.number())),
});
export type CommitWeek = z.infer<typeof CommitWeek>;
export const CommitActivity = z.array(CommitWeek);

/* -------------------------------------------------------------------------- */
/* Projections                                                                 */
/* -------------------------------------------------------------------------- */

/** What a record's `text` says when GitHub did not answer (invariant 4). */
export const UNKNOWN = "unknown";

export interface Projection {
  /** The record's title. Null when the payload names nothing. */
  title: string | null;
  /** The record's text: a compact `key: value` block. See rule 2. */
  text: string;
  /** Merged into the record's `meta`, naming the renderer that produced it. */
  meta: Record<string, unknown>;
}

/** `key: value` lines, with the missing ones written out as unknown. */
function block(rows: [string, string | number | boolean | null | undefined][]): string {
  return rows
    .map(([key, value]) => {
      const written =
        value === null || value === undefined || value === "" ? UNKNOWN : String(value);
      return `${key}: ${written}`;
    })
    .join("\n");
}

export function projectRepo(repo: GithubRepo): Projection {
  const text = block([
    ["repository", repo.full_name],
    ["url", repo.html_url],
    ["description", repo.description],
    ["homepage", repo.homepage],
    ["owner", repo.owner.login],
    ["owner type", repo.owner.type],
    ["primary language", repo.language],
    ["license", repo.license?.spdx_id === "NOASSERTION" ? null : repo.license?.spdx_id],
    ["topics", repo.topics && repo.topics.length > 0 ? repo.topics.join(", ") : null],
    ["stars", repo.stargazers_count],
    ["forks", repo.forks_count],
    ["watchers", repo.subscribers_count],
    ["open issues", repo.open_issues_count],
    ["created at", repo.created_at],
    ["last pushed at", repo.pushed_at],
    ["archived", repo.archived],
    ["is a fork", repo.fork],
  ]);
  return {
    title: repo.full_name,
    text,
    meta: { projection: "github_repo.v1", full_name: repo.full_name },
  };
}

export function projectOwner(owner: GithubOwner): Projection {
  const text = block([
    ["account", owner.login],
    ["type", owner.type],
    ["name", owner.name],
    ["bio", owner.bio],
    ["company", owner.company],
    ["location", owner.location],
    ["website", owner.blog],
    ["public repositories", owner.public_repos],
    ["followers", owner.followers],
    ["account created at", owner.created_at],
  ]);
  return {
    title: owner.name ?? owner.login,
    text,
    meta: { projection: "github_user.v1", login: owner.login, account_type: owner.type },
  };
}

/**
 * The README, decoded. GitHub returns it base64-encoded inside a JSON envelope,
 * so storing the response verbatim would store the envelope — and the envelope
 * is the one part of it nothing reads.
 *
 * Returns null rather than throwing on an encoding this does not know: a repo
 * whose README cannot be decoded has no README as far as this pipeline is
 * concerned, and that is a coverage drop with a reason, not a failed run.
 */
export function decodeReadme(readme: GithubReadme): string | null {
  if (readme.content === null) return null;
  if (readme.encoding !== null && readme.encoding !== "base64") return null;
  const decoded = Buffer.from(readme.content, "base64").toString("utf8");
  return decoded.trim().length > 0 ? decoded : null;
}

export function projectReadme(readme: GithubReadme, markdown: string): Projection {
  return {
    title: readme.path ?? readme.name,
    // Verbatim: a README *is* prose, so unlike the metadata payloads there is
    // nothing to project. The store truncates it at EVIDENCE_TEXT_LIMIT.
    text: markdown,
    meta: {
      projection: "github_readme.v1",
      ...(readme.path ? { path: readme.path } : {}),
      ...(readme.html_url ? { html_url: readme.html_url } : {}),
      ...(readme.size === null ? {} : { source_bytes: readme.size }),
    },
  };
}

export interface ContributorSummary {
  /** Entries on the page. A floor when the page came back full. */
  count: number;
  /** True when the page was full, so the real count is at least `count`. */
  capped: boolean;
  /** `type: "Bot"` entries, excluded from `humans`. */
  bots: number;
  humans: number;
  /** Ranked by contributions, as GitHub returns them. */
  top: GithubContributor[];
}

/** How many contributors a projection names. Enough to see a shape, not a list. */
export const TOP_CONTRIBUTORS = 5;

export function summariseContributors(
  contributors: readonly GithubContributor[],
  perPage = CONTRIBUTORS_PER_PAGE,
): ContributorSummary {
  const bots = contributors.filter((c) => c.type === "Bot");
  return {
    count: contributors.length,
    capped: contributors.length >= perPage,
    bots: bots.length,
    humans: contributors.length - bots.length,
    top: contributors.filter((c) => c.type !== "Bot").slice(0, TOP_CONTRIBUTORS),
  };
}

export function projectContributors(summary: ContributorSummary): Projection {
  const named = summary.top
    .map((c) => `${c.login} (${c.contributions ?? UNKNOWN} commits)`)
    .join(", ");
  const text = block([
    ["contributors on the first page", summary.capped ? `${summary.count} or more` : summary.count],
    ["human contributors", summary.capped ? `${summary.humans} or more` : summary.humans],
    ["bot accounts", summary.bots],
    ["most active", named === "" ? null : named],
  ]);
  return {
    title: null,
    text,
    meta: {
      projection: "github_contributors.v1",
      contributors: summary.count,
      capped: summary.capped,
    },
  };
}

export interface CadenceSummary {
  /** Weeks the API returned. 52 on a healthy answer. */
  weeks: number;
  commits_total: number;
  commits_last_12_weeks: number;
  /** Weeks with at least one commit — a repo's pulse, not its volume. */
  active_weeks: number;
  /** Start of the most recent week that had a commit, ISO. Null if none did. */
  last_active_week: string | null;
}

/** Twelve weeks of the fifty-two, so "recently" is a stated window, not a mood. */
export const RECENT_WEEKS = 12;

export function summariseCadence(weeks: readonly CommitWeek[]): CadenceSummary {
  // GitHub returns oldest first; the recent window is the tail.
  const recent = weeks.slice(-RECENT_WEEKS);
  const active = weeks.filter((week) => week.total > 0);
  const last = active.at(-1);
  return {
    weeks: weeks.length,
    commits_total: weeks.reduce((sum, week) => sum + week.total, 0),
    commits_last_12_weeks: recent.reduce((sum, week) => sum + week.total, 0),
    active_weeks: active.length,
    last_active_week: last === undefined ? null : new Date(last.week * 1000).toISOString(),
  };
}

export function projectCadence(summary: CadenceSummary): Projection {
  const text = block([
    ["weeks reported", summary.weeks],
    ["commits in those weeks", summary.commits_total],
    [`commits in the last ${RECENT_WEEKS} weeks`, summary.commits_last_12_weeks],
    ["weeks with at least one commit", `${summary.active_weeks} of ${summary.weeks}`],
    ["most recent week with a commit", summary.last_active_week],
  ]);
  return { title: null, text, meta: { projection: "github_commit_activity.v1", ...summary } };
}
