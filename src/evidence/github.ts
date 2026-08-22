import { z } from "zod";
import type { GithubAuth, GithubMode } from "../config.js";
import { githubAuth } from "../config.js";
import type { Evidence } from "../contracts/index.js";
import { fetchFailedEvidence, type HttpOptions, httpGet } from "./fetch.js";
import { makeEvidence } from "./store.js";

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

/* -------------------------------------------------------------------------- */
/* Signals                                                                     */
/* -------------------------------------------------------------------------- */

/** Atoms, like `Fact.value`: a metric is a number, a name or a flag. */
export type SignalValue = string | number | boolean;

/**
 * One dated, citable metric. Not a `Fact` — a fact is the model's output
 * surface and carries a statement and a confidence (`src/contracts/fact.ts`).
 * This is the mechanical layer underneath: read off an API payload or computed
 * from one by arithmetic, with no model involved and nothing to be confident
 * about. TICKET-0021's rubric is what turns these into a score.
 */
export interface Signal {
  /** What the rubric switches on, e.g. `github.stars`. */
  key: string;
  value: SignalValue;
  /**
   * When this was true. Rule 1: SPEC D3 scores an undated claim at 0, so every
   * metric leaves here pinned to a moment. For an observation — a star count —
   * that is the moment it was retrieved, which is also what makes a re-run over
   * a warm cache reproduce the same numbers rather than drifting.
   */
  as_of: string;
  /** The record this was read off. Every signal resolves to a citation. */
  evidence_id: string;
  /** Set when the number was computed rather than read. */
  derived_from?: string;
}

/** A metric that could not be produced, and why. Never a zero (invariant 4). */
export interface UnknownSignal {
  key: string;
  reason: string;
}

export interface SignalSet {
  signals: Signal[];
  unknowns: UnknownSignal[];
}

/**
 * Collect signals for one evidence record. `add` is the only way a metric gets
 * out of this module, which is how rule 1 stays structural rather than
 * remembered: a value that is null, blank or not a finite number becomes an
 * `unknown` with a reason instead of a signal.
 */
function collector(evidenceId: string, at: string) {
  const signals: Signal[] = [];
  const unknowns: UnknownSignal[] = [];

  const add = (
    key: string,
    value: SignalValue | null | undefined,
    missing: string,
    derivedFrom?: string,
  ): void => {
    const empty =
      value === null ||
      value === undefined ||
      value === "" ||
      (typeof value === "number" && !Number.isFinite(value));
    if (empty) {
      unknowns.push({ key, reason: missing });
      return;
    }
    signals.push({
      key,
      value,
      as_of: at,
      evidence_id: evidenceId,
      ...(derivedFrom ? { derived_from: derivedFrom } : {}),
    });
  };

  return { signals, unknowns, add };
}

/** Whole days between two timestamps, or null when either is unreadable. */
export function daysBetween(from: string | null, to: string): number | null {
  if (from === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.floor((end - start) / 86_400_000);
}

/**
 * A url out of a field that may be a bare host. GitHub's `homepage` and `blog`
 * are free text: `coroot.com`, `https://coroot.com` and `""` all occur.
 */
export function toUrl(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.hostname.includes(".") ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function repoSignals(repo: GithubRepo, evidenceId: string, at: string): SignalSet {
  const { signals, unknowns, add } = collector(evidenceId, at);
  const ageDays = daysBetween(repo.created_at, at);
  const stars = repo.stargazers_count;

  add("github.repo", repo.full_name, "no repository");
  add("github.stars", stars, "GitHub did not report a star count");
  add("github.forks", repo.forks_count, "GitHub did not report a fork count");
  add("github.watchers", repo.subscribers_count, "GitHub did not report a watcher count");
  add("github.open_issues", repo.open_issues_count, "GitHub did not report an issue count");
  add("github.created_at", repo.created_at, "GitHub did not report a creation date");
  add("github.age_days", ageDays, "the repository has no creation date", "created_at → retrieval");
  add("github.pushed_at", repo.pushed_at, "GitHub did not report a last push");
  add(
    "github.days_since_push",
    daysBetween(repo.pushed_at, at),
    "the repository has no last-push date",
    "pushed_at → retrieval",
  );
  // A lifetime average, and named as one: real star velocity needs two
  // observations and GitHub charges for the second (the stargazer timestamps
  // endpoint is paginated per star). A single run cannot measure a rate, and a
  // number called `velocity` that is not one would be scored as though it were.
  add(
    "github.stars_per_day_lifetime",
    stars !== null && ageDays !== null && ageDays > 0
      ? Math.round((stars / ageDays) * 100) / 100
      : null,
    "needs both a star count and a creation date",
    "stars ÷ age_days — a lifetime average, not a current rate",
  );
  add(
    "github.license",
    repo.license?.spdx_id === "NOASSERTION" ? null : repo.license?.spdx_id,
    "GitHub could not identify a licence in the repository",
  );
  add(
    "github.topics",
    repo.topics && repo.topics.length > 0 ? repo.topics.join(", ") : null,
    "the repository declares no topics",
  );
  add("github.language", repo.language, "GitHub reported no primary language");
  add("github.archived", repo.archived, "GitHub did not say whether the repository is archived");
  add("github.is_fork", repo.fork, "GitHub did not say whether the repository is a fork");
  add(
    "github.homepage",
    toUrl(repo.homepage),
    "the repository declares no homepage — the repo ↔ site join has to come from elsewhere",
  );
  add("github.owner", repo.owner.login, "the repository names no owner");

  return { signals, unknowns };
}

export function ownerSignals(owner: GithubOwner, evidenceId: string, at: string): SignalSet {
  const { signals, unknowns, add } = collector(evidenceId, at);

  // The gate's inconsistency 22: this one field separated all ten open-source
  // projects from every real company in its 48 candidates. It is reported here
  // and judged in the rubric — never used to filter, which would be exactly the
  // widening-yes-narrowing-no violation (CLAUDE.md invariant 1).
  add("github.owner_type", owner.type, "GitHub did not report an account type");
  add("github.owner_name", owner.name, "the account has no display name");
  add("github.owner_company", owner.company, "the account names no company");
  add("github.owner_location", owner.location, "the account gives no location");
  add("github.owner_public_repos", owner.public_repos, "GitHub reported no repository count");
  add("github.owner_followers", owner.followers, "GitHub reported no follower count");
  add("github.owner_created_at", owner.created_at, "the account has no creation date");
  add(
    "github.owner_age_days",
    daysBetween(owner.created_at, at),
    "the account has no creation date",
    "account created_at → retrieval",
  );
  add(
    "github.owner_site",
    toUrl(owner.blog),
    "the account declares no website",
    "the account's own `blog` field — the repository's `homepage` is the stronger route",
  );

  return { signals, unknowns };
}

export function contributorSignals(
  summary: ContributorSummary,
  evidenceId: string,
  at: string,
): SignalSet {
  const { signals, unknowns, add } = collector(evidenceId, at);
  const floor = summary.capped ? ` (a floor: the page was full at ${CONTRIBUTORS_PER_PAGE})` : "";

  add("github.contributors", summary.count, "no contributor list", `one page${floor}`);
  add("github.human_contributors", summary.humans, "no contributor list", `bots excluded${floor}`);
  add("github.bot_contributors", summary.bots, "no contributor list");
  add("github.top_contributor", summary.top[0]?.login, "the page named no human contributor");
  add(
    "github.top_contributor_commits",
    summary.top[0]?.contributions,
    "the top contributor has no commit count",
  );
  add(
    "github.contributor_count_is_floor",
    summary.capped,
    "no contributor list",
    "the page was full, so the real count is higher",
  );

  return { signals, unknowns };
}

export function cadenceSignals(summary: CadenceSummary, evidenceId: string, at: string): SignalSet {
  const { signals, unknowns, add } = collector(evidenceId, at);
  const window = `${summary.weeks} weeks of stats/commit_activity`;

  add("github.commits_last_year", summary.commits_total, "no commit activity", window);
  add(
    `github.commits_last_${RECENT_WEEKS}_weeks`,
    summary.commits_last_12_weeks,
    "no commit activity",
    `the last ${RECENT_WEEKS} weeks of ${window}`,
  );
  add("github.active_weeks", summary.active_weeks, "no commit activity", window);
  add(
    "github.last_commit_week",
    summary.last_active_week,
    `no commit landed in the ${summary.weeks} weeks GitHub reported`,
    "the week boundary GitHub stamped, not a commit timestamp",
  );

  return { signals, unknowns };
}

/* -------------------------------------------------------------------------- */
/* The calls                                                                   */
/* -------------------------------------------------------------------------- */

export type GithubCall = "repo" | "owner" | "readme" | "contributors" | "commit_activity";

/** Everything this adapter knows how to read, in the order it reads it. */
export const ALL_CALLS: readonly GithubCall[] = [
  "repo",
  "owner",
  "readme",
  "contributors",
  "commit_activity",
];

/**
 * The two calls that carry the fields the gate handed forward — `owner.type`
 * and `homepage` — and nothing else.
 */
export const CHEAP_CALLS: readonly GithubCall[] = ["repo", "owner"];

/**
 * **Degraded mode is a smaller request budget, not a footnote.** Unauthenticated
 * GitHub allows 60 requests an hour. A `--limit 12` run at five calls a
 * candidate is exactly 60, so the last candidate would be rate-limited by the
 * run's own earlier candidates and the retry budget would be spent discovering
 * it. Without a token the adapter therefore reads two endpoints per candidate
 * (24 requests, with room for the retries a real network needs) and records
 * every metric it did not fetch as an `unknown` with the reason.
 *
 * The alternative — always make five calls and let the fourth candidate start
 * failing — produces a run whose coverage depends on where in the list a
 * company happened to sit, which is worse than a run that is uniformly thinner
 * and says so. ADR-0004 keeps a token optional; this is what optional costs.
 */
export function defaultCalls(mode: GithubMode): readonly GithubCall[] {
  return mode === "authenticated" ? ALL_CALLS : CHEAP_CALLS;
}

/** A call that did not produce evidence, and why. Data, never a throw (rule 3). */
export interface GithubFailure {
  call: GithubCall;
  url: string;
  /** HTTP status, or 0 when the request never got one. */
  status: number;
  reason: string;
}

export interface GithubResult {
  ref: RepoRef;
  /** As configured. Recorded so a thin run says why it was thin. */
  mode: GithubMode;
  /** The calls this run was willing to make, before any of them failed. */
  planned: readonly GithubCall[];
  /** Requests actually issued. A cache hit still counts as a call, not a request. */
  requests: number;
  evidence: Evidence[];
  signals: Signal[];
  unknowns: UnknownSignal[];
  /**
   * The company site this repository points at — STATE inconsistency 45, the
   * join stage 1 structurally cannot make. TICKET-0016 fetches it.
   *
   * **Only `repo.homepage` reaches this field.** The account's own `blog` is a
   * signal (`github.owner_site`) and never a join: it describes the *account*,
   * and on a personal account it is routinely somewhere else entirely. The
   * first live run of this adapter found the gate's own 404 candidate
   * (`anilatambharii/argus-ai`, STATE inconsistency 39) whose `blog` is a
   * LinkedIn profile — which stage 1's classifier would have rejected as a
   * social host had it been posted directly. Promoting that to "the company
   * site" would send TICKET-0016 to extract founders from a personal profile
   * page, and a wrong founder is worse than a missing one (SCOPE cut corner 1).
   * A missing join costs coverage; a wrong one is not recoverable downstream.
   */
  homepage: { url: string; source: "repo" } | null;
  failures: GithubFailure[];
}

export interface GatherGithubOptions {
  /** Defaults to `githubAuth()`. Injected in tests so no environment is read. */
  auth?: GithubAuth;
  /** Overrides `defaultCalls(mode)`. TICKET-0017 may trim this per run. */
  calls?: readonly GithubCall[];
  /** Passed through to `httpGet` — transport, cache dir, clock, retry policy. */
  http?: HttpOptions;
}

/**
 * Read one GitHub account, and the repository under it when the url named one.
 *
 * Best-effort throughout: the return value is the same shape whether every call
 * succeeded, some failed, or the account does not exist. A candidate with no
 * GitHub presence is not an error — it is most candidates.
 *
 * The repository's failure stops the three calls that live under it, because a
 * repo that 404s makes `…/readme`, `…/contributors` and `…/stats` three more
 * 404s. The owner call survives it: an account whose repo was renamed is still
 * an account, and `type` is the field worth the most on a thin candidate.
 */
export async function gatherGithub(
  ref: RepoRef,
  options: GatherGithubOptions = {},
): Promise<GithubResult> {
  const auth = options.auth ?? githubAuth();
  const planned = options.calls ?? defaultCalls(auth.mode);
  const http: HttpOptions = {
    ...options.http,
    headers: {
      ...GITHUB_API_HEADERS,
      // The token never reaches an evidence record: `makeEvidence` is given
      // `meta` explicitly below and request headers are not in it.
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...options.http?.headers,
    },
  };

  const result: GithubResult = {
    ref,
    mode: auth.mode,
    planned,
    requests: 0,
    evidence: [],
    signals: [],
    unknowns: [],
    homepage: null,
    failures: [],
  };

  const skipped = (call: GithubCall, reason: string): void => {
    result.unknowns.push({ key: `github.${call}`, reason });
  };

  /** One request, with the outcomes rule 3 requires: nothing here throws. */
  const read = async (
    call: GithubCall,
    url: string,
  ): Promise<{ body: unknown; at: string; evidenceOf: (p: Projection) => Evidence } | null> => {
    const response = await httpGet(url, http);
    result.requests += response.attempts;

    if (!response.ok) {
      result.failures.push({ call, url, status: response.status, reason: response.reason });
      // A failed fetch is a record, not an absence (ARCHITECTURE §5): a repo
      // that 404s is citable evidence that it 404s.
      result.evidence.push(fetchFailedEvidence(response));
      skipped(call, `${url} — ${response.reason}`);
      return null;
    }

    // 202 is `stats/commit_activity` saying GitHub has not finished computing;
    // 204 is an endpoint saying the answer is empty. Both are 2xx with no
    // usable body, and neither is a failure of this run.
    if (response.status === 202) {
      result.failures.push({
        call,
        url,
        status: 202,
        reason: "GitHub is still computing these statistics; a later run gets them",
      });
      skipped(call, "GitHub answered 202 — the statistics were not ready");
      return null;
    }

    let body: unknown;
    try {
      body = response.status === 204 ? [] : JSON.parse(response.body);
    } catch (error) {
      result.failures.push({
        call,
        url,
        status: response.status,
        reason: `unreadable response: ${error instanceof Error ? error.message : String(error)}`,
      });
      skipped(call, `${url} returned ${response.status} and a body that is not JSON`);
      return null;
    }

    const evidenceOf = (projection: Projection): Evidence =>
      makeEvidence({
        url,
        type: call === "owner" ? "github_user" : "github_repo",
        retrieved_at: response.retrieved_at,
        status: response.status,
        title: projection.title,
        text: projection.text,
        meta: {
          call,
          from_cache: response.from_cache,
          attempts: response.attempts,
          ...projection.meta,
        },
      });

    return { body, at: response.retrieved_at, evidenceOf };
  };

  /** A 200 whose body is not the shape this adapter reads. */
  const malformed = (call: GithubCall, url: string, error: unknown): void => {
    const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
    result.failures.push({ call, url, status: 200, reason: `unexpected payload: ${detail}` });
    skipped(call, `${url} returned a payload this adapter does not recognise`);
  };

  const collect = (set: SignalSet): void => {
    result.signals.push(...set.signals);
    result.unknowns.push(...set.unknowns);
  };

  const wanted = (call: GithubCall): boolean => planned.includes(call);
  for (const call of ALL_CALLS) {
    if (!wanted(call)) skipped(call, `not read: ${auth.note}`);
  }

  /* -- the repository ----------------------------------------------------- */

  let repo: GithubRepo | null = null;
  const repoUrl = repoApiUrl(ref);
  if (repoUrl === null) {
    for (const call of ["repo", "readme", "contributors", "commit_activity"] as GithubCall[]) {
      if (wanted(call)) skipped(call, `${ref.owner} was named without a repository`);
    }
  } else if (wanted("repo")) {
    const response = await read("repo", repoUrl);
    if (response !== null) {
      const parsed = GithubRepo.safeParse(response.body);
      if (!parsed.success) {
        malformed("repo", repoUrl, parsed.error);
      } else {
        repo = parsed.data;
        const evidence = response.evidenceOf(projectRepo(repo));
        result.evidence.push(evidence);
        collect(repoSignals(repo, evidence.id, response.at));
        const homepage = toUrl(repo.homepage);
        if (homepage !== null) result.homepage = { url: homepage, source: "repo" };
      }
    }
  }

  /** The three calls under the repository, live only if the repository did. */
  const repoIsReadable = repo !== null;
  const under = (call: GithubCall): boolean => {
    if (!wanted(call) || repoUrl === null) return false;
    if (repoIsReadable) return true;
    skipped(call, "the repository could not be read, so what is under it was not asked for");
    return false;
  };

  /* -- the account -------------------------------------------------------- */

  if (wanted("owner")) {
    const url = ownerApiUrl(ref);
    const response = await read("owner", url);
    if (response !== null) {
      const parsed = GithubOwner.safeParse(response.body);
      if (!parsed.success) {
        malformed("owner", url, parsed.error);
      } else {
        const owner = parsed.data;
        const evidence = response.evidenceOf(projectOwner(owner));
        result.evidence.push(evidence);
        collect(ownerSignals(owner, evidence.id, response.at));
      }
    }
  }

  /* -- the README --------------------------------------------------------- */

  if (under("readme")) {
    const url = readmeApiUrl(ref) as string;
    const response = await read("readme", url);
    if (response !== null) {
      const parsed = GithubReadme.safeParse(response.body);
      if (!parsed.success) {
        malformed("readme", url, parsed.error);
      } else {
        const markdown = decodeReadme(parsed.data);
        if (markdown === null) {
          skipped("readme", `${url} returned a README this adapter could not decode`);
        } else {
          result.evidence.push(response.evidenceOf(projectReadme(parsed.data, markdown)));
        }
      }
    }
  }

  /* -- the contributors --------------------------------------------------- */

  if (under("contributors")) {
    const url = contributorsApiUrl(ref) as string;
    const response = await read("contributors", url);
    if (response !== null) {
      const parsed = GithubContributors.safeParse(response.body);
      if (!parsed.success) {
        malformed("contributors", url, parsed.error);
      } else {
        const summary = summariseContributors(parsed.data);
        const evidence = response.evidenceOf(projectContributors(summary));
        result.evidence.push(evidence);
        collect(contributorSignals(summary, evidence.id, response.at));
      }
    }
  }

  /* -- the commit cadence ------------------------------------------------- */

  if (under("commit_activity")) {
    const url = commitActivityApiUrl(ref) as string;
    const response = await read("commit_activity", url);
    if (response !== null) {
      const parsed = CommitActivity.safeParse(response.body);
      if (!parsed.success) {
        malformed("commit_activity", url, parsed.error);
      } else {
        const summary = summariseCadence(parsed.data);
        const evidence = response.evidenceOf(projectCadence(summary));
        result.evidence.push(evidence);
        collect(cadenceSignals(summary, evidence.id, response.at));
      }
    }
  }

  return result;
}
