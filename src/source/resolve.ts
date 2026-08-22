import { classifyHit, type HitKind, type HnHit, type SourcedHit } from "./hn.js";

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
 * The linkage this cannot see is a company posted once as `acme.dev` and once
 * as `github.com/acme/acme`. Nothing in either url says they are the same
 * thing. The GitHub adapter (TICKET-0015) reads a repo's homepage field, which
 * is where that join belongs.
 */
export function siteKey(host: string, path: string): string {
  const domain = registrableDomain(host);
  if (REPO_HOSTS.includes(domain)) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return domain;
    return [domain, ...segments.slice(0, 2)].join("/").toLowerCase();
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

  const params = [...url.searchParams.entries()]
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
 */
function strongerPost(a: SitePost, b: SitePost): number {
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
