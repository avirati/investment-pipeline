import { z } from "zod";
import { type Dropped, parseOrDrop } from "../contracts/index.js";
import { type HttpOptions, httpGet } from "../evidence/fetch.js";

/**
 * The HN Algolia adapter (TICKET-0009). ADR-0004 makes HN the primary source
 * and is explicit that the deliverable is *depth* on it, not an HN call: date
 * windows, pagination past page 1, expansion across launch phrasings, and the
 * points and comment counts carried through as a dated traction signal rather
 * than dropped as metadata.
 *
 * Three rules hold in this file:
 *
 * 1. **Code chooses filters; the model chooses words.** Every tag, date window
 *    and page number here is derived from a CLI flag by the functions below.
 *    The LLM's only entry point into stage 1 is the *phrasing* of a seed, via
 *    TICKET-0011, and it never reaches this module (ADR-0008, CLAUDE.md
 *    invariant 1).
 *
 * 2. **A missing field stays missing.** `points`, `num_comments` and
 *    `created_at` are nullable all the way through. A post with no score is not
 *    a post that scored zero, and D3 reads these numbers (CLAUDE.md invariant
 *    4).
 *
 * 3. **A hit this module cannot understand is dropped with a reason**, not
 *    silently skipped and not fatal — the same `parseOrDrop` contract used for
 *    model output, for the same reason: one malformed record should not cost
 *    the other forty-nine.
 */

/** Relevance-ranked. The default: launches worth finding are ranked, not recent. */
export const HN_SEARCH_ENDPOINT = "https://hn.algolia.com/api/v1/search";

/** Strictly reverse-chronological. `sort: "date"` selects it. */
export const HN_SEARCH_BY_DATE_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";

/** Algolia's own maximum for this endpoint; asking for more is silently capped. */
export const HN_HITS_PER_PAGE = 50;

/** A thread's canonical home, and the url an `hn_item` evidence record cites. */
export const HN_ITEM_URL_PREFIX = "https://news.ycombinator.com/item?id=";

export function hnItemUrl(objectId: string): string {
  return `${HN_ITEM_URL_PREFIX}${encodeURIComponent(objectId)}`;
}

export type HnSort = "relevance" | "date";

export interface HnQueryOptions {
  /** Full text. Algolia requires every word to match, so long seeds narrow fast. */
  query: string;
  /**
   * Algolia tag syntax, passed through: a comma is AND, parentheses are OR.
   * `story` alone is the useful default — `story,show_hn` is a Show HN, and
   * `(show_hn,ask_hn)` is either. Chosen by code, never by a model.
   */
  tags?: string;
  /** `--since`. Omit for no window at all. */
  sinceDays?: number;
  page?: number;
  hitsPerPage?: number;
  sort?: HnSort;
}

/**
 * The window boundary is floored to the start of a UTC day rather than taken
 * from the clock. Two runs on the same day then build the *same* url, which
 * means the fetch cache can serve the second one — and a cache hit replays its
 * original `retrieved_at`, so evidence ids stay stable across a re-run
 * (`fetch.ts` rule 2). A boundary computed to the second would produce a new
 * url on every invocation and quietly defeat both.
 */
export function windowStartUnix(sinceDays: number, now: Date): number {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor(startOfDay / 1000) - sinceDays * 24 * 60 * 60;
}

/** Deterministic in its inputs, so it is safe to use as a cache key. */
export function hnSearchUrl(options: HnQueryOptions, now: Date): string {
  const {
    query,
    tags = "story",
    sinceDays,
    page = 0,
    hitsPerPage = HN_HITS_PER_PAGE,
    sort = "relevance",
  } = options;

  const endpoint = sort === "date" ? HN_SEARCH_BY_DATE_ENDPOINT : HN_SEARCH_ENDPOINT;
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("tags", tags);
  params.set("hitsPerPage", String(Math.min(hitsPerPage, HN_HITS_PER_PAGE)));
  params.set("page", String(page));
  if (sinceDays !== undefined) {
    params.set("numericFilters", `created_at_i>${windowStartUnix(sinceDays, now)}`);
  }
  return `${endpoint}?${params.toString()}`;
}

/**
 * Hand-written and fixed, per ADR-0004's "expansion across Show HN / launch /
 * funding phrasings". Two of the three are phrasings; `show_hn` is a **tag
 * filter** instead, because HN spells that concept in a field rather than in
 * prose and a filter cannot mistake a post that merely says "show" for a
 * launch. Both halves are still code choosing, which is the part that matters.
 *
 * `label` travels with every hit so `candidates.jsonl` records which arm of the
 * expansion found a company — the cheapest way to learn, at TICKET-0013, that
 * an arm earns nothing and should be cut.
 */
export interface QueryExpansion {
  label: string;
  query: string;
  tags: string;
}

export function expandQuery(seed: string): QueryExpansion[] {
  const trimmed = seed.trim();
  return [
    { label: "raw", query: trimmed, tags: "story" },
    { label: "show_hn", query: trimmed, tags: "story,show_hn" },
    { label: "launch", query: `${trimmed} launch`, tags: "story" },
    { label: "funding", query: `${trimmed} raises seed funding`, tags: "story" },
  ];
}

/**
 * Only `objectID` is required, because it is the only field the pipeline cannot
 * work around: without it there is no thread url and no way to dedup. Every
 * other field is `.nullish().catch(null)` — a value arriving as `null`, as the
 * wrong type, or not at all costs *that field* and nothing more.
 *
 * The `.catch(null)` is the load-bearing half. Without it a single mistyped
 * field fails the whole object and `parseOrDrop` discards an otherwise perfectly
 * good post over, say, a timestamp that arrived as a string — which is exactly
 * the trade the fixture's malformed hits are there to pin down.
 *
 * Unknown keys — Algolia ships `_highlightResult` and a dozen timing fields —
 * are ignored by default.
 */
const optional = <T extends z.ZodType>(schema: T) => schema.nullish().catch(null);

const RawHit = z.object({
  objectID: z.string().min(1),
  title: optional(z.string()),
  url: optional(z.string()),
  author: optional(z.string()),
  points: optional(z.number()),
  num_comments: optional(z.number()),
  created_at: optional(z.string()),
  created_at_i: optional(z.number()),
  story_text: optional(z.string()),
  _tags: optional(z.array(z.string())),
});

const RawSearchResponse = z.object({
  hits: z.array(z.unknown()).nullish(),
  nbHits: optional(z.number()),
  page: optional(z.number()),
  nbPages: optional(z.number()),
});

/**
 * One HN post, normalised. `null` means the source did not say — never a
 * substituted zero (rule 2 above).
 */
export interface HnHit {
  object_id: string;
  /** The HN thread. Always present: it is derived from `object_id`. */
  hn_url: string;
  title: string | null;
  /** The submitted link. Null for Ask HN and text posts. */
  url: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  /** ISO 8601, or null when the payload carried no usable timestamp. */
  created_at: string | null;
  /** Self-post body, when the submission was text rather than a link. */
  story_text: string | null;
  tags: string[];
}

/**
 * `created_at_i` is preferred over `created_at`: it is a unix integer and
 * cannot be half-parseable, whereas the ISO string is the field that arrives
 * malformed. Both unusable is `null` — the post is still a real post, it just
 * cannot carry a date, and dropping it would lose a candidate over a field the
 * classifier does not read.
 */
export function hitTimestamp(
  createdAtI: number | null | undefined,
  createdAt: string | null | undefined,
): string | null {
  if (typeof createdAtI === "number" && Number.isFinite(createdAtI) && createdAtI > 0) {
    const fromUnix = new Date(createdAtI * 1000);
    if (!Number.isNaN(fromUnix.getTime())) return fromUnix.toISOString();
  }
  if (typeof createdAt === "string") {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function normalise(raw: z.infer<typeof RawHit>): HnHit {
  return {
    object_id: raw.objectID,
    hn_url: hnItemUrl(raw.objectID),
    title: raw.title?.trim() || null,
    url: raw.url?.trim() || null,
    author: raw.author?.trim() || null,
    points: typeof raw.points === "number" && Number.isFinite(raw.points) ? raw.points : null,
    num_comments:
      typeof raw.num_comments === "number" && Number.isFinite(raw.num_comments)
        ? raw.num_comments
        : null,
    created_at: hitTimestamp(raw.created_at_i, raw.created_at),
    story_text: raw.story_text?.trim() || null,
    tags: raw._tags ?? [],
  };
}

export interface HnPage {
  hits: HnHit[];
  /** Zero-based, as Algolia reports it. */
  page: number;
  /** Total pages available for this query — what pagination stops against. */
  nb_pages: number;
  /** Total matches, which may be far larger than what a run will read. */
  nb_hits: number;
  /** Hits that failed the parse, with the reason. Audited, not swallowed. */
  dropped: Dropped[];
}

/**
 * An empty result set is `hits: []` and not an error: "nobody has posted about
 * this topic" is the answer the probe in TICKET-0011 is asking for, and a throw
 * would turn a thin seed into a failed run.
 *
 * A payload that is not a search response at all — an HTML error page parsed as
 * JSON, say — throws, because that is a broken caller or a broken endpoint
 * rather than a fact about the query.
 */
export function parseSearchResponse(payload: unknown): HnPage {
  const parsed = RawSearchResponse.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`not an HN Algolia search response: ${parsed.error.issues[0]?.message}`);
  }
  const { kept, dropped } = parseOrDrop(RawHit, parsed.data.hits ?? []);
  return {
    hits: kept.map(normalise),
    page: parsed.data.page ?? 0,
    nb_pages: parsed.data.nbPages ?? 0,
    nb_hits: parsed.data.nbHits ?? 0,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// The usable-vs-unusable classifier.
//
// ADR-0004 states the cost of choosing HN plainly: *"HN returns projects and
// blog posts alongside companies. Filtering is heuristic and will have both
// false positives and false negatives. Rejections are recorded with a reason so
// the filter is auditable."* This is that filter, and three things about it are
// deliberate:
//
// 1. **It reads the url, not the page.** TICKET-0011's probe counts usable hits
//    before a run is allowed to start, so classification must cost nothing. The
//    ticket's phrase is "resolves to a company site" — actually following the
//    link, canonicalising it and deduping is TICKET-0010's job, and it can
//    overturn a verdict made here with better information.
//
// 2. **It errs towards accepting.** A wrong reject is invisible — the company
//    is never looked at again and nothing in the output says it existed. A wrong
//    accept costs one analysis and shows up in a memo a human reads. So the
//    unusable side is a set of narrow, nameable rules and everything else is
//    usable, rather than the reverse.
//
// 3. **Every verdict carries a `kind` and a prose `reason`.** The kind is what
//    the manifest counts and what TICKET-0013 hand-checks; the reason is what a
//    human reads when they disagree with a rejection.
// ---------------------------------------------------------------------------

/**
 * What the link points at, as far as a url can say. Only `company_site` and
 * `code_repo` are usable — see `classifyHit` for why a repo counts.
 */
export type HitKind =
  | "company_site"
  | "code_repo"
  | "content"
  | "paper"
  | "aggregator"
  | "no_url"
  | "bad_url";

export interface HitClassification {
  usable: boolean;
  kind: HitKind;
  /** One line, written into the run's audit trail beside the rejection. */
  reason: string;
  /** Lowercased, `www.` stripped. Null when there was no usable url. */
  host: string | null;
}

/**
 * Publishing platforms and trade press. A post pointing here is *about* a
 * company at best; it is never the company's own surface. Hand-written, seeded
 * from what actually appears in the fixtures, and expected to grow at
 * TICKET-0013 when a real result set is hand-checked.
 */
export const CONTENT_HOSTS = [
  "medium.com",
  "substack.com",
  "dev.to",
  "hashnode.dev",
  "blogspot.com",
  "wordpress.com",
  "ghost.io",
  "bearblog.dev",
  "tumblr.com",
  "infoq.com",
  "techcrunch.com",
  "venturebeat.com",
  "thenewstack.io",
  "theverge.com",
  "wired.com",
  "arstechnica.com",
  "zdnet.com",
];

/** Preprints, journals and anything served as a PDF. Research, not a company. */
export const PAPER_HOSTS = [
  "arxiv.org",
  "doi.org",
  "biorxiv.org",
  "ssrn.com",
  "openreview.net",
  "researchgate.net",
  "semanticscholar.org",
  "acm.org",
  "ieee.org",
];

/** Someone else's discussion of a thing, including HN's own threads. */
export const AGGREGATOR_HOSTS = [
  "news.ycombinator.com",
  "reddit.com",
  "lobste.rs",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "youtube.com",
  "youtu.be",
  "wikipedia.org",
  "docs.google.com",
];

/**
 * Where a dev-tools launch actually lands. Kept **usable**: for this thesis —
 * "adopted before it is sold" — a repo is the product surface, not a consolation
 * prize, and GitHub is already the secondary enrichment source (ADR-0004). What
 * the company site is, if there is one, is TICKET-0010's problem.
 */
export const CODE_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];

/** Project pages: a repo with a domain, so classified as one. */
export const PROJECT_PAGE_SUFFIXES = [".github.io", ".gitlab.io"];

/**
 * Path prefixes that mean "an article on someone's site". This is what catches
 * a company blogging about the topic — `signoz.io/blog/...` is a real company
 * and still the wrong url for a candidate, because the post is content
 * marketing rather than a launch.
 */
export const ARTICLE_PATH = /^\/(blog|blogs|post|posts|article|articles|news|story|stories)(\/|$)/;

/** `/2026/08/some-title` — the other common shape of the same thing. */
export const DATED_PATH = /^\/(19|20)\d{2}\/\d{1,2}\//;

function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Classify one url. The order of the rules is the point: a PDF hosted on a
 * company domain is still a paper, and an article path on a code host is still
 * a repo, so the narrow rules run before the broad ones.
 *
 * Split out from `classifyHit` so TICKET-0010 can re-run the same verdict on
 * the url a redirect actually landed on — a shortener that resolves to
 * `medium.com` has to be rejected by the same rules that would have rejected it
 * had it been posted directly.
 */
export function classifyUrl(url: string | null): HitClassification {
  if (url === null) {
    return {
      usable: false,
      kind: "no_url",
      // Ask HN and text posts. They are not candidates, but the thread itself
      // may still be worth reading as evidence about a company found elsewhere.
      reason: "text post with no link — nothing to resolve to a company",
      host: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { usable: false, kind: "bad_url", reason: `unparseable url: ${url}`, host: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      usable: false,
      kind: "bad_url",
      reason: `not an http url: ${parsed.protocol.replace(":", "")}`,
      host: null,
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname;

  if (path.toLowerCase().endsWith(".pdf")) {
    return { usable: false, kind: "paper", reason: "links to a PDF, not a product", host };
  }
  if (hostMatches(host, PAPER_HOSTS)) {
    return { usable: false, kind: "paper", reason: `${host} is a paper or preprint host`, host };
  }
  if (hostMatches(host, AGGREGATOR_HOSTS)) {
    return {
      usable: false,
      kind: "aggregator",
      reason: `${host} is a discussion or social platform, not a company site`,
      host,
    };
  }
  if (hostMatches(host, CODE_HOSTS)) {
    return { usable: true, kind: "code_repo", reason: `repository on ${host}`, host };
  }
  if (PROJECT_PAGE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { usable: true, kind: "code_repo", reason: `project page on ${host}`, host };
  }
  if (hostMatches(host, CONTENT_HOSTS)) {
    return {
      usable: false,
      kind: "content",
      reason: `${host} is a publishing platform or trade publication`,
      host,
    };
  }
  if (ARTICLE_PATH.test(path) || DATED_PATH.test(path)) {
    return {
      usable: false,
      kind: "content",
      reason: `${host}${path} is an article, not the company's own surface`,
      host,
    };
  }

  return { usable: true, kind: "company_site", reason: `${host} looks like a company site`, host };
}

/** One hit, classified by its submitted link. Null url is an Ask HN or text post. */
export function classifyHit(hit: HnHit): HitClassification {
  return classifyUrl(hit.url);
}

export interface ClassifiedHit {
  hit: HnHit;
  classification: HitClassification;
}

/**
 * Split a result set the way TICKET-0011's probe needs it: `usable.length` is
 * what `--min-hits` is compared against (D-6), and `rejected` is kept rather
 * than discarded so the run can record *why* a thin probe was thin.
 */
export function classifyHits(hits: readonly HnHit[]): {
  usable: ClassifiedHit[];
  rejected: ClassifiedHit[];
} {
  const usable: ClassifiedHit[] = [];
  const rejected: ClassifiedHit[] = [];
  for (const hit of hits) {
    const classification = classifyHit(hit);
    (classification.usable ? usable : rejected).push({ hit, classification });
  }
  return { usable, rejected };
}

// ---------------------------------------------------------------------------
// The fetch half.
//
// Everything above is pure. This is the part that reaches the network, and it
// does so through `httpGet` and nothing else (CLAUDE.md: "Never call `fetch`
// directly from a stage") — which is why the injection point below is
// `HttpOptions` rather than a function that could replace the choke point. A
// test drives a stub transport, exactly as `fetch.ts`'s own suite does, and the
// url building and pagination under test are the real ones.
//
// ARCHITECTURE §5 says a source API failure fails the *run*. It does not say
// the adapter throws, and it must not: four expansion arms over several pages
// is up to a dozen requests, and one 500 on the funding arm's second page is
// not a reason to lose the three arms that worked. So a failure is returned as
// data — `failures[]`, one entry per page that did not come back — and
// TICKET-0012 decides whether what survived is enough to keep going. An adapter
// that throws takes that decision away from the layer that can make it.
// ---------------------------------------------------------------------------

/** One page that did not come back, kept so a thin result set can explain itself. */
export interface HnSearchFailure {
  /** Which expansion arm was being fetched. */
  label: string;
  /** Zero-based page, as requested. */
  page: number;
  url: string;
  /** HTTP status, or 0 when the request never got one. */
  status: number;
  reason: string;
}

/**
 * A hit and the arms that found it. Plural because dedup is across arms: a
 * Show HN about a funding round appears on three of the four, and crediting
 * only the first would make the other two look like they earned nothing.
 * TICKET-0013 reads this to decide whether an arm is worth keeping.
 */
export interface SourcedHit {
  hit: HnHit;
  found_by: string[];
}

/** Per-arm accounting, for the run manifest and for the gate at TICKET-0013. */
export interface HnArmSummary {
  label: string;
  query: string;
  tags: string;
  pages_fetched: number;
  /** Hits this arm returned, including ones another arm had already found. */
  hits: number;
  /** Of those, the ones no earlier arm had seen. An arm's actual contribution. */
  new_hits: number;
}

export interface HnSearchResult {
  /** Deduped by `object_id`, in discovery order: arm order, then page order. */
  hits: SourcedHit[];
  arms: HnArmSummary[];
  /** Pages that failed. Empty on a clean run; never a thrown error. */
  failures: HnSearchFailure[];
  /** Hits that failed the parse across every page, with reasons. */
  dropped: Dropped[];
  pages_fetched: number;
}

/**
 * Two pages an arm, which with four arms is at most eight requests and 400
 * hits for one seed. It is a budget, not a measurement: page 2 of a relevance
 * ranking is already well past the posts a human would have read, and the run
 * limit (`--limit`) cuts far below this anyway. TICKET-0012 may lower it from
 * the CLI; nothing yet raises it.
 */
export const HN_MAX_PAGES_PER_ARM = 2;

export interface SearchHnOptions {
  sinceDays?: number;
  sort?: HnSort;
  hitsPerPage?: number;
  maxPagesPerArm?: number;
  /** Defaults to `expandQuery(seed)`. Overridden in tests and by nothing else. */
  expansions?: QueryExpansion[];
  /** Passed through to `httpGet` — transport, cache dir, clock, retry policy. */
  http?: HttpOptions;
  /** The clock the `--since` window is floored against. */
  now?: () => Date;
}

/**
 * Run the expansion over HN Algolia and return every distinct post it found.
 *
 * Pagination stops on the first of: the page count Algolia reported, the
 * per-arm cap, a short page (fewer hits than asked for, which is the last page
 * whatever `nbPages` claimed), or a failure. Stopping an arm on its first
 * failure is deliberate — a 500 on page 1 usually means page 2 is a 500 too,
 * and spending the retry budget to learn that costs the arms that still work.
 */
export async function searchHn(
  seed: string,
  options: SearchHnOptions = {},
): Promise<HnSearchResult> {
  const {
    sinceDays,
    sort,
    hitsPerPage = HN_HITS_PER_PAGE,
    maxPagesPerArm = HN_MAX_PAGES_PER_ARM,
    expansions = expandQuery(seed),
    http = {},
    now = () => new Date(),
  } = options;

  const byId = new Map<string, SourcedHit>();
  const arms: HnArmSummary[] = [];
  const failures: HnSearchFailure[] = [];
  const dropped: Dropped[] = [];
  let pagesFetched = 0;

  for (const expansion of expansions) {
    const summary: HnArmSummary = {
      label: expansion.label,
      query: expansion.query,
      tags: expansion.tags,
      pages_fetched: 0,
      hits: 0,
      new_hits: 0,
    };
    arms.push(summary);

    for (let page = 0; page < maxPagesPerArm; page += 1) {
      const query: HnQueryOptions = {
        query: expansion.query,
        tags: expansion.tags,
        page,
        hitsPerPage,
        ...(sinceDays === undefined ? {} : { sinceDays }),
        ...(sort === undefined ? {} : { sort }),
      };
      const url = hnSearchUrl(query, now());
      const result = await httpGet(url, http);
      if (!result.ok) {
        failures.push({
          label: expansion.label,
          page,
          url,
          status: result.status,
          reason: result.reason,
        });
        break;
      }

      pagesFetched += 1;
      summary.pages_fetched += 1;

      let parsed: HnPage;
      try {
        parsed = parseSearchResponse(JSON.parse(result.body));
      } catch (error) {
        // A 200 that is not a search response: an error page, a proxy's HTML,
        // a truncated body. Same class of problem as a 500, recorded the same
        // way — the status says 200 because that is what the server said.
        failures.push({
          label: expansion.label,
          page,
          url,
          status: result.status,
          reason: `unreadable response: ${error instanceof Error ? error.message : String(error)}`,
        });
        break;
      }

      dropped.push(...parsed.dropped);
      summary.hits += parsed.hits.length;
      for (const hit of parsed.hits) {
        const seen = byId.get(hit.object_id);
        if (seen) {
          if (!seen.found_by.includes(expansion.label)) seen.found_by.push(expansion.label);
          continue;
        }
        byId.set(hit.object_id, { hit, found_by: [expansion.label] });
        summary.new_hits += 1;
      }

      // `nb_pages` is the authority; a short page is the belt-and-braces case
      // for a payload that under-reports it.
      if (page + 1 >= parsed.nb_pages || parsed.hits.length < hitsPerPage) break;
    }
  }

  return { hits: [...byId.values()], arms, failures, dropped, pages_fetched: pagesFetched };
}
