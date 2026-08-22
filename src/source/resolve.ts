import type { HttpOptions } from "../evidence/fetch.js";
import { httpGet } from "../evidence/fetch.js";
import { classifyHit, classifyUrl, type HitKind, type HnHit, type SourcedHit } from "./hn.js";

/**
 * URL canonicalisation and dedup (TICKET-0010). TESTING §3 calls this "classic
 * quiet-bug territory" and it is right: two HN posts about one company silently
 * becoming two candidates costs a duplicate analysis, a duplicate LLM spend and
 * a reviewer's confidence — and nothing in the output would say it happened.
 *
 * Three rules hold in this file:
 *
 * 1. **Canonicalisation decides identity, not display.** Everything here exists
 *    so that two urls naming the same surface produce the same string, and two
 *    urls naming different surfaces never do. `http` and `https`, `www.` and
 *    apex, a trailing slash, `index.html`, `?utm_source=hn` and a fragment are
 *    all the former. A different path on a code host is the latter.
 *
 * 2. **Collapsing is the dangerous direction.** A wrong split costs one
 *    duplicate analysis, which a human sees in the memo list. A wrong collapse
 *    deletes a company, and nothing anywhere records that it existed — the same
 *    asymmetry `classifyHit` is built around. So the dedup key gets *more*
 *    specific whenever a host is shared between unrelated owners.
 *
 * 3. **This half is pure.** Following a redirect needs the network and lands in
 *    the second half of this ticket; everything below is string in, string out,
 *    so the table-driven tests TESTING §3 asks for need no transport at all.
 */

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

/**
 * Dropped from the query string outright. `utm_*` is matched by prefix; the
 * rest are exact names. Hand-written from the campaign parameters that actually
 * appear on links posted to HN, and expected to grow at TICKET-0013.
 *
 * The risk is real and worth naming: a site that gives `ref` a load-bearing
 * meaning would have two distinct pages collapse to one here. Nothing in the
 * fixtures does, and the alternative — keeping `ref` — means the same launch
 * posted twice with different referrer tags becomes two candidates, which is
 * the failure this ticket exists to prevent.
 */
export const TRACKING_PARAM_PREFIXES = ["utm_"];

export const TRACKING_PARAMS = [
  "ref",
  "ref_src",
  "referrer",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "spm",
];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRACKING_PARAMS.includes(lower) ||
    TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/** `index.html` and its friends name the directory they sit in, not a page. */
const DIRECTORY_INDEX = /\/index\.(html?|php|aspx?|jsp)$/i;

/**
 * Hosts where the label to the *left* of the suffix is the owner, so the suffix
 * alone cannot identify anybody. Two kinds of entry, for one reason:
 *
 * - Multi-part public suffixes (`co.uk`), where `acme.co.uk` is the registrable
 *   domain and `co.uk` is nobody's.
 * - Shared deploy hosts (`github.io`, `vercel.app`), where every subdomain is a
 *   different project by a different person. Collapsing those would merge every
 *   project page on GitHub Pages into one candidate.
 *
 * This is a hand-written stand-in for the Mozilla public suffix list, which is
 * a runtime dependency and a megabyte of data for a problem this size (no new
 * dependency without an ADR line — CLAUDE.md). The cost of the shortcut: a
 * ccTLD not listed here — `acme.com.sg`, say — resolves to `com.sg` as its
 * registrable domain, which would collapse two unrelated Singaporean companies
 * into one candidate. That is rule 2's dangerous direction, so the list leans
 * long, and TICKET-0013's hand-check is where a missing entry would show up.
 */
export const SHARED_SUFFIXES = [
  // Multi-part public suffixes.
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.mx",
  "com.ar",
  "com.sg",
  "com.hk",
  "com.tw",
  "com.tr",
  "com.cn",
  "co.in",
  "co.za",
  "co.kr",
  "com.es",
  "co.il",
  // Shared deploy and page hosts: one subdomain, one owner.
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "netlify.com",
  "herokuapp.com",
  "fly.dev",
  "onrender.com",
  "web.app",
  "firebaseapp.com",
  "surge.sh",
  "glitch.me",
  "replit.app",
  "repl.co",
  "notion.site",
  "webflow.io",
  "readthedocs.io",
  "streamlit.app",
  "hf.space",
];

/**
 * The owner-identifying part of a host: `docs.acme.com` → `acme.com`, so a
 * subdomain and its apex dedup together (the ticket's "subdomain vs apex").
 * On a shared suffix one more label is kept, because there the subdomain *is*
 * the owner: `tomhudson.github.io` → `tomhudson.github.io`.
 */
export function registrableDomain(host: string): string {
  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join(".");
  for (const suffix of SHARED_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith(`.${suffix}`)) {
      const depth = suffix.split(".").length + 1;
      return labels.slice(-depth).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

/**
 * Code hosts key on the repository path rather than the domain, or every repo
 * on GitHub would be one candidate. Kept in step with `CODE_HOSTS` in `hn.ts`,
 * where the same hosts are what makes a hit `code_repo`.
 */
const REPO_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "sr.ht"];

/**
 * Package registries, and how many leading path segments name one package.
 *
 * TICKET-0013's fix F5, for STATE inconsistency 36. A registry is a code host
 * that is not in `REPO_HOSTS`, and without this every package on PyPI keys on
 * `pypi.org` — so a run that finds two PyPI launches keeps one and deletes the
 * other with no trace. That is rule 2's dangerous direction.
 *
 * The depths are read off each registry's own url shape and are exact, not
 * guesses: `pypi.org/project/<name>`, `crates.io/crates/<name>`,
 * `hub.docker.com/r/<owner>/<image>`, `huggingface.co/<owner>/<model>`. The two
 * variable shapes are handled in `registryDepth` rather than here.
 *
 * Keyed on the **host** and not the registrable domain, for two reasons:
 * `hub.docker.com` would otherwise reduce to `docker.com`, and a registry's
 * docs or blog subdomain is not a package index and should key on the domain
 * like any other site.
 */
export const REGISTRY_DEPTHS: Record<string, number> = {
  "pypi.org": 2,
  "npmjs.com": 2,
  "crates.io": 2,
  "rubygems.org": 2,
  "nuget.org": 2,
  "packagist.org": 3,
  "hub.docker.com": 3,
  "huggingface.co": 2,
};

/** `huggingface.co/datasets/<owner>/<name>` — one segment deeper than a model. */
const HUGGINGFACE_PREFIXES = ["datasets", "spaces", "models"];

/**
 * How many leading path segments identify the package on `domain`, or null when
 * the host is not a registry. Two hosts vary by url:
 *
 * - npm scopes a name (`/package/@acme/cli`), which is one segment more.
 * - Hugging Face puts datasets and spaces under a prefix, models at the root.
 */
export function registryDepth(host: string, segments: readonly string[]): number | null {
  const base = REGISTRY_DEPTHS[host];
  if (base === undefined) return null;
  if (host === "npmjs.com" && segments[1]?.startsWith("@")) return base + 1;
  if (host === "huggingface.co" && HUGGINGFACE_PREFIXES.includes(segments[0] ?? "")) {
    return base + 1;
  }
  return base;
}

/**
 * Path prefixes on a code host that address something *inside* a repository —
 * a file, a branch listing, an issue — rather than the repository itself.
 *
 * TICKET-0013's fix F3. Three of the gate's five junk candidates were urls of
 * this shape, and the damage is not to the dedup key (`siteKey` already slices
 * to `owner/repo`) but to `canonical_url`: the run would name a candidate after
 * a markdown file and then send stage 2 to fetch it as the company's evidence.
 * `github.com/alibaba/anolisa/blob/main/docs/…/agentsight.md` became a company
 * called "AgentSight"; `…/xarray-sql/blob/claude/…/benchmarks/nn.py` became one
 * Python file on a feature branch.
 *
 * **Truncated, never rejected.** `github.com/HelixDB/helix-db/tree/main` is a
 * real company and `/tree/main` is just how a repo link gets pasted, so a rule
 * that rejected deep paths would delete it. Everything here is a normalisation:
 * the identity is the repo, and the deep url survives as `posted_url` on the
 * post so a reviewer can still see what was submitted.
 */
export const REPO_SUBPATHS = [
  "blob",
  "tree",
  "raw",
  "blame",
  "commit",
  "commits",
  "issues",
  "pull",
  "pulls",
  "merge_requests",
  "releases",
  "tags",
  "branches",
  "compare",
  "wiki",
  "discussions",
  "actions",
  "pipelines",
  "projects",
  "milestones",
  "labels",
  "stargazers",
  "forks",
  "network",
  "watchers",
  "graphs",
  "pkgs",
  "packages",
  "security",
  "settings",
];

/**
 * The identity-bearing prefix of a path, or null when the whole path is
 * identity (an ordinary site, where `siteKey` ignores the path anyway).
 *
 * One function so that `siteKey` and `canonicaliseUrl` cannot drift: the url a
 * run fetches and the key it dedups on are then the same decision made once.
 */
export function identityPath(host: string, path: string): string | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (REPO_HOSTS.includes(registrableDomain(host))) {
    if (segments.length <= 2) return null;
    // Only truncate at a known repo-internal prefix. An unrecognised third
    // segment is left alone rather than guessed at — GitLab nests groups
    // (`gitlab.com/group/subgroup/repo`) and cutting those to two segments
    // would collapse every repo in a group into one candidate.
    if (!REPO_SUBPATHS.includes(segments[2]?.toLowerCase() ?? "")) return null;
    return `/${segments.slice(0, 2).join("/")}`;
  }

  const depth = registryDepth(host, segments);
  if (depth !== null && segments.length > depth) return `/${segments.slice(0, depth).join("/")}`;

  return null;
}

/** One url, reduced to the things that decide whether two urls are the same. */
export interface CanonicalSite {
  /** The url as identity: https, no `www.`, no tracking params, no fragment. */
  canonical_url: string;
  /** Lowercased, `www.` stripped. */
  host: string;
  /** `registrableDomain(host)`. */
  domain: string;
  /** Path after canonicalisation. `""` for a bare domain. */
  path: string;
  /** What two urls are compared on. See `siteKey`. */
  key: string;
}

/**
 * The dedup key. A plain domain for an ordinary site, so `acme.com`,
 * `www.acme.com/`, `http://acme.com/index.html?utm_source=hn` and
 * `docs.acme.com` are one company.
 *
 * On a code host it is `host/owner/repo` — deliberately *repo* and not *owner*,
 * even though an org is usually one company. Rule 2 is why: keying on the owner
 * would collapse two genuinely different products from one org into a single
 * candidate and lose one of them silently, while keying on the repo leaves at
 * worst a visible duplicate in the memo list. The org-level collapse is a
 * judgement TICKET-0013's hand-check can make with real data; this layer does
 * not make it by guessing.
 *
 * On a package registry it is `host/<package>` — TICKET-0013's fix F5. The
 * default would be the bare domain, which makes every package on PyPI one
 * candidate; see `REGISTRY_DEPTHS`.
 *
 * The linkage this cannot see is a company posted once as `acme.dev` and once
 * as `github.com/acme/acme`. Nothing in either url says they are the same
 * thing. The GitHub adapter (TICKET-0015) reads a repo's homepage field, which
 * is where that join belongs — and the gate at TICKET-0013 measured what it
 * costs until then: Coroot took three of twelve slots on one run, as its repo,
 * its `.ai` domain and its demo subdomain (STATE inconsistency 45).
 */
export function siteKey(host: string, path: string): string {
  const domain = registrableDomain(host);
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (REPO_HOSTS.includes(domain)) {
    if (segments.length === 0) return domain;
    return [domain, ...segments.slice(0, 2)].join("/").toLowerCase();
  }

  const depth = registryDepth(host, segments);
  if (depth !== null && segments.length > 0) {
    return [host, ...segments.slice(0, depth)].join("/").toLowerCase();
  }

  return domain;
}

/**
 * Reduce a url to its canonical form, or `null` when it is not an http(s) url
 * at all. Null rather than a throw because the input is *data* — a url a
 * stranger typed into an HN submission form — and a bad one costs that hit and
 * nothing else.
 *
 * Query parameters that survive are sorted, so `?a=1&b=2` and `?b=2&a=1` are
 * one url. The case of the path is left alone: paths are case-sensitive on
 * most servers and lowercasing one would be inventing a different page.
 */
export function canonicaliseUrl(raw: string): CanonicalSite | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (host.length === 0) return null;

  let path = url.pathname.replace(/\/{2,}/g, "/").replace(DIRECTORY_INDEX, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";
  // A url that points *inside* a repo or a package is the repo or the package
  // (F3, F5). This is the one place canonicalisation changes what the run will
  // fetch rather than only how it is spelled, and it is deliberate: fetching a
  // repo's front page is better evidence than fetching a file in it.
  const identity = identityPath(host, path);
  if (identity !== null) path = identity;

  // A query belongs to the page it was on, so truncating the path drops it too
  // — `?plain=1` on a file view means nothing at a repo root.
  const params = (identity !== null ? [] : [...url.searchParams.entries()])
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([name, value]) => `${name}=${value}`).join("&");

  // `URL` already drops a scheme's default port, so anything left is part of
  // the address and is kept — except `:443`, which is the port of the scheme
  // this function normalises to and would otherwise write the address twice.
  const port = url.port === "443" ? "" : url.port;
  const authority = port ? `${host}:${port}` : host;

  // A query on a bare domain still gets its `/`: `https://acme.dev?a=1` parses
  // identically but reads like a typo to anyone reviewing the output.
  const printedPath = path === "" && query ? "/" : path;

  return {
    canonical_url: `https://${authority}${printedPath}${query ? `?${query}` : ""}`,
    host,
    domain: registrableDomain(host),
    path,
    key: siteKey(host, path),
  };
}

// ---------------------------------------------------------------------------
// Reject-with-reason
// ---------------------------------------------------------------------------

/**
 * `HitKind` plus the one verdict this layer can reach that the url classifier
 * in `hn.ts` cannot: a url that parses and is not a known content, paper or
 * aggregator host, but is still nobody's company.
 */
export type SiteKind = HitKind | "personal_site";

/**
 * Personal homepage and link-in-bio services. Narrow on purpose — the general
 * deploy hosts in `SHARED_SUFFIXES` (`vercel.app`, `netlify.app`, `pages.dev`)
 * are deliberately **not** here, because a seed-stage company genuinely does
 * launch from one, and rejecting those would be exactly the invisible loss rule
 * 2 warns about.
 */
export const PERSONAL_HOSTS = [
  "about.me",
  "carrd.co",
  "linktr.ee",
  "bio.link",
  "neocities.org",
  "gravatar.com",
  "myshopify.com",
];

/** `/~alice` — a user directory on a shared or institutional server. */
export const TILDE_PATH = /^\/~[^/]+/;

/** Universities and schools. A department page is not a company's own surface. */
const ACADEMIC_SUFFIXES = [".edu", ".ac.uk", ".edu.au", ".ac.jp", ".ac.in", ".edu.cn"];

/**
 * The verdict on one canonical url, in the same shape `classifyHit` returns so
 * both feed one audit trail. `usable: false` here always carries a reason a
 * human can disagree with.
 */
export interface SiteVerdict {
  usable: boolean;
  kind: SiteKind;
  reason: string;
}

/**
 * Applied *after* `classifyHit` has had its say, so this only ever adds
 * rejections the url classifier could not reach.
 */
export function classifySite(site: CanonicalSite): SiteVerdict {
  if (PERSONAL_HOSTS.some((h) => site.domain === h || site.host.endsWith(`.${h}`))) {
    return {
      usable: false,
      kind: "personal_site",
      reason: `${site.host} is a personal page or link-in-bio service`,
    };
  }
  if (TILDE_PATH.test(site.path)) {
    return {
      usable: false,
      kind: "personal_site",
      reason: `${site.host}${site.path} is a user directory, not a company site`,
    };
  }
  if (ACADEMIC_SUFFIXES.some((suffix) => site.host.endsWith(suffix))) {
    return {
      usable: false,
      kind: "personal_site",
      reason: `${site.host} is an academic host, not a company`,
    };
  }
  return { usable: true, kind: "company_site", reason: `${site.host} looks like a company site` };
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** One HN post that pointed at a site, and what its link canonicalised to. */
export interface SitePost {
  hit: HnHit;
  /** Which expansion arms found this post, carried through from `searchHn`. */
  found_by: string[];
  /** The url exactly as submitted, kept so a reviewer can see what changed. */
  posted_url: string;
  canonical_url: string;
}

/**
 * One company, with every post that pointed at it. This is not a `Candidate` —
 * a candidate needs a name, a slug and a one-liner, which come from evidence
 * this layer has not fetched. TICKET-0012 turns these into candidates.
 */
export interface ResolvedSite {
  key: string;
  /** From the primary post — the one whose link the run will actually fetch. */
  canonical_url: string;
  host: string;
  domain: string;
  kind: SiteKind;
  /** Primary first, then the rest in discovery order. Never empty. */
  posts: SitePost[];
}

/** A hit that will not become a candidate, and the verdict that says why. */
export interface RejectedHit {
  hit: HnHit;
  found_by: string[];
  kind: SiteKind;
  reason: string;
}

/**
 * Which post represents the site.
 *
 * **Highest points wins, earliest post breaks the tie.** Points, not date,
 * because points are the traction signal SPEC §2's D3 actually reads, and the
 * top-scoring thread is also the one with the most discussion to mine later —
 * picking the earliest post instead would routinely make a five-point
 * pre-launch teaser represent a company whose Show HN hit 400. Date breaks ties
 * because among equally-scored posts the first one is the launch and the rest
 * are follow-ups.
 *
 * A post with no score sorts below one with a score. That is a ranking
 * decision, not a substituted zero (CLAUDE.md invariant 4): nothing writes `0`
 * anywhere, and the run reports the primary post's numbers, so a primary with
 * no numbers reports nothing where a sibling could have reported something.
 * `object_id` is the final tie-break, only so the order is deterministic.
 *
 * Exported because TICKET-0012 ranks *sites* by their primary post before
 * `--limit` cuts, and the ranking rule for a company and for a post inside one
 * company should not be two rules that can drift apart.
 */
export function strongerPost(a: SitePost, b: SitePost): number {
  const points = (post: SitePost) => post.hit.points;
  const [pa, pb] = [points(a), points(b)];
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  }
  const [da, db] = [a.hit.created_at, b.hit.created_at];
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  return a.hit.object_id < b.hit.object_id ? -1 : 1;
}

/**
 * Group a search result into one entry per company.
 *
 * Runs `classifyHit` first so the url classifier's verdicts stay the single
 * definition of "unusable" and this layer only adds to them, then canonicalises
 * what survived and groups by `siteKey`.
 *
 * Sites come back in the order their first post was discovered, which is arm
 * order then page order, so the output is deterministic for a given result set.
 */
export function dedupeHits(hits: readonly SourcedHit[]): {
  sites: ResolvedSite[];
  rejected: RejectedHit[];
} {
  const sites = new Map<string, ResolvedSite>();
  const rejected: RejectedHit[] = [];

  for (const { hit, found_by } of hits) {
    const classification = classifyHit(hit);
    if (!classification.usable) {
      rejected.push({ hit, found_by, kind: classification.kind, reason: classification.reason });
      continue;
    }

    // `classifyHit` already parsed this url, so a null here means the two
    // parsers disagree — a bug, but one that costs a hit rather than a run.
    const posted = hit.url;
    const site = posted === null ? null : canonicaliseUrl(posted);
    if (site === null || posted === null) {
      rejected.push({
        hit,
        found_by,
        kind: "bad_url",
        reason: `url did not canonicalise: ${hit.url ?? "(none)"}`,
      });
      continue;
    }

    const verdict = classifySite(site);
    if (!verdict.usable) {
      rejected.push({ hit, found_by, kind: verdict.kind, reason: verdict.reason });
      continue;
    }

    const post: SitePost = {
      hit,
      found_by,
      posted_url: posted,
      canonical_url: site.canonical_url,
    };
    const existing = sites.get(site.key);
    if (existing) {
      existing.posts.push(post);
      continue;
    }
    sites.set(site.key, {
      key: site.key,
      canonical_url: site.canonical_url,
      host: site.host,
      domain: site.domain,
      // The url classifier's kind is the one that says repo-vs-site; this
      // layer's only new verdict is a rejection.
      kind: classification.kind,
      posts: [post],
    });
  }

  for (const site of sites.values()) {
    site.posts.sort(strongerPost);
    // The primary post decides which url the run fetches, so the two must not
    // drift apart when a group's strongest post is not its first.
    const primary = site.posts[0];
    if (primary) site.canonical_url = primary.canonical_url;
  }

  return { sites: [...sites.values()], rejected };
}

// ---------------------------------------------------------------------------
// Redirect resolution.
//
// The half of this ticket that needs the network. It runs on *sites* and not on
// hits, which is the whole reason `dedupeHits` above is pure and cheap: a seed
// can return 200 hits and this makes one request each, so TICKET-0012 dedups
// first, applies `--limit`, and only then resolves what survived.
//
// The request is not wasted work. `httpGet` writes the body to the same cache
// the evidence fetch will read (`fetch.ts` rule 2), so resolving a candidate's
// url and later fetching its page as evidence is one network round trip, and
// the evidence record carries the `retrieved_at` this request minted.
//
// Requests are sequential. One at a time is polite to a stranger's site, and
// the batch here is a run's `--limit`, not a crawl.
// ---------------------------------------------------------------------------

/** What resolving one site's url found. Attached to the site, never discarded. */
export interface SiteResolution {
  /** The canonical url as requested. */
  requested_url: string;
  /** Where it landed, canonicalised. Equal to `requested_url` if nothing moved. */
  resolved_url: string;
  /** HTTP status, or 0 when the request never got one. */
  status: number;
  /** True when the response came from a different url than the one requested. */
  redirected: boolean;
  /**
   * True when the landing url canonicalised to a *different dedup key* — which
   * is the case that can merge two candidates. A redirect within one key
   * (`launch.acme.dev` → `acme.dev`, `/hn` → `/`) is `redirected` but not
   * `rekeyed`, because canonicalisation had already collapsed those.
   */
  rekeyed: boolean;
  /** Set when the request failed. The site keeps its pre-resolution url. */
  reason: string | null;
}

export interface ResolvedSiteWithRedirect extends ResolvedSite {
  resolution: SiteResolution;
}

export interface ResolveSitesOptions {
  /** Passed through to `httpGet` — transport, cache dir, clock, retry policy. */
  http?: HttpOptions;
}

/**
 * Follow each site's url and re-key it on where it landed.
 *
 * Three outcomes, and none of them throws:
 *
 * - **The request failed.** The site is kept, unchanged, with the reason on its
 *   resolution. A company whose site 403s a bot user-agent is still a company,
 *   and ARCHITECTURE §5 already has a place for the failure — the evidence
 *   fetch will record it as `fetch_failed` with a citation.
 * - **It landed somewhere unusable.** A shortener that resolves to `medium.com`
 *   is rejected by `classifyUrl` — the same rules that would have rejected it
 *   had it been posted directly — and every post in the group is rejected with
 *   that reason.
 * - **It moved.** The site takes the landing url as its own. When the landing
 *   url also carries a *different dedup key*, the site takes that key, host,
 *   domain and kind too,
 *   and any two groups that now share a key are merged: their posts are
 *   concatenated and re-ranked, so the strongest post across both becomes the
 *   primary. This is the case the ticket exists for — two vanity domains, or a
 *   `launch.acme.dev` and an `acme.dev`, becoming one candidate.
 */
export async function resolveSites(
  sites: readonly ResolvedSite[],
  options: ResolveSitesOptions = {},
): Promise<{ sites: ResolvedSiteWithRedirect[]; rejected: RejectedHit[] }> {
  const { http = {} } = options;
  const merged = new Map<string, ResolvedSiteWithRedirect>();
  const rejected: RejectedHit[] = [];

  const rejectGroup = (site: ResolvedSite, kind: SiteKind, reason: string) => {
    for (const post of site.posts) {
      rejected.push({ hit: post.hit, found_by: post.found_by, kind, reason });
    }
  };

  const absorb = (site: ResolvedSiteWithRedirect) => {
    const existing = merged.get(site.key);
    if (!existing) {
      merged.set(site.key, site);
      return;
    }
    existing.posts.push(...site.posts);
    existing.posts.sort(strongerPost);
  };

  for (const site of sites) {
    const requested = site.canonical_url;
    const result = await httpGet(requested, http);

    if (!result.ok) {
      absorb({
        ...site,
        resolution: {
          requested_url: requested,
          resolved_url: requested,
          status: result.status,
          redirected: false,
          rekeyed: false,
          reason: result.reason,
        },
      });
      continue;
    }

    // `final_url` is only set when it differs from the url requested, so an
    // absent one means the server answered at the address we asked for.
    const landed = result.final_url ? canonicaliseUrl(result.final_url) : null;
    const resolution: SiteResolution = {
      requested_url: requested,
      resolved_url: landed?.canonical_url ?? requested,
      status: result.status,
      redirected: landed !== null && landed.canonical_url !== requested,
      rekeyed: landed !== null && landed.key !== site.key,
      reason: null,
    };

    if (landed === null) {
      absorb({ ...site, resolution });
      continue;
    }

    // Re-classified only when the key moved. Within one key the landing url is
    // the same surface by construction, and re-running the rules on it would
    // let a company's own `/blog` redirect reject the company.
    if (resolution.rekeyed) {
      const classification = classifyUrl(landed.canonical_url);
      if (!classification.usable) {
        rejectGroup(site, classification.kind, `redirected to ${classification.reason}`);
        continue;
      }
      const verdict = classifySite(landed);
      if (!verdict.usable) {
        rejectGroup(site, verdict.kind, `redirected to ${verdict.reason}`);
        continue;
      }
      absorb({
        ...site,
        key: landed.key,
        canonical_url: landed.canonical_url,
        host: landed.host,
        domain: landed.domain,
        kind: classification.kind,
        resolution,
      });
      continue;
    }

    // Same key, different url: the run fetches where the server actually
    // answered, so the next request is not a second redirect — and the body is
    // already in the cache under the url requested here.
    absorb({ ...site, canonical_url: landed.canonical_url, resolution });
  }

  return { sites: [...merged.values()], rejected };
}
