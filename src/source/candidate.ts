import {
  CANDIDATE_SCHEMA_VERSION,
  Candidate,
  type CandidateSource,
  type Provenance,
} from "../contracts/index.js";
import { slugify } from "../run.js";
import { classifyUrl } from "./hn.js";
import {
  canonicaliseUrl,
  classifySite,
  type ResolvedSite,
  type SiteKind,
  type SitePost,
} from "./resolve.js";

/**
 * `ResolvedSite` → `Candidate` (TICKET-0012).
 *
 * The last pure step of stage 1. Dedup produced groups of posts pointing at one
 * company; this gives each group the three things `candidates.jsonl` needs and
 * the group does not have — a name, a slug and a one-liner — and records every
 * post behind it as provenance.
 *
 * Three rules, and the first is the one that matters:
 *
 * 1. **Nothing here is invented.** A name is either lifted verbatim from the
 *    post title or it is the company's own domain. There is no LLM in this path
 *    and there is no cleverness either: no title-casing a domain into a brand,
 *    no expanding an abbreviation, no guessing that `acmetraces.dev` is called
 *    "Acme Traces". Stage 1 is allowed to *look*, not to conclude (CLAUDE.md
 *    invariant 1), and a name is a small conclusion.
 *
 * 2. **A title is only read as a name when its shape marks one.** HN titles are
 *    two shapes — `Show HN: Acme Traces – tracing for LLM calls` names a
 *    product, `We rewrote our tracer in Rust` does not — and the separator is
 *    what distinguishes them. When the shape does not mark a name, the domain
 *    is used, because a memo headed `acmetraces.dev` is plain where a memo
 *    headed `We Rewrote Our Tracer` is wrong.
 *
 * 3. **The slug is an identity, not a label.** It names the analysis file and
 *    the memo file, so it is derived once here, deduplicated within the run,
 *    and never recomputed downstream from a name that might have changed.
 */

/** `Show HN:`, `Launch HN:`, `Ask HN:`, `Tell HN:` — and the bare-space forms. */
export const HN_TITLE_PREFIX = /^(?:show|launch|tell|ask)\s+hn\b:?\s*/i;

/** A leading separator left behind by a prefix written as `Show HN – …`. */
const LEADING_SEPARATOR = /^[–—\-:|]\s*/;

/**
 * What separates a name from its tagline. The en dash is the HN convention; the
 * hyphen, colon and pipe are what people type instead. A hyphen needs spaces
 * around it or `re-ranking` would split.
 */
export const TITLE_SEPARATOR = /\s+[–—]\s+|\s+-\s+|:\s+|\s+\|\s+/;

/** `(YC W24)`, `(open source)` — a qualifier on a name, never part of it. */
const PARENTHETICAL = /\s*\([^)]*\)/g;

/**
 * A product name is short. Both numbers are budgets rather than measurements:
 * four words and forty characters covers "Acme Traces", "Postgres Language
 * Server" and "Chroma", and excludes a clause. Wrong in the generous
 * direction costs a bad memo heading; wrong in the strict direction costs a
 * plain one, which is why they are not tighter.
 */
export const MAX_NAME_WORDS = 4;
export const MAX_NAME_LENGTH = 40;

/**
 * A head starting with one of these is a sentence with a short beginning, not a
 * name: "We built a tracer", "How we cut latency", "A faster Postgres". Costs
 * the occasional real name that opens with an article — "The Browser Company"
 * falls back to its domain — and that asymmetry is deliberate, per rule 2.
 */
const SENTENCE_OPENERS =
  /^(?:i|we|my|our|us|a|an|the|how|why|what|when|introducing|announcing|building|built|making|made|using|from|after|inside)\b/i;

export type NamedBy = "title" | "domain";

export interface DerivedName {
  name: string;
  /** May be empty: a candidate with nothing to say says nothing (invariant 4). */
  one_liner: string;
  /** Which rule produced the name. Read by the hand-check at TICKET-0013. */
  named_by: NamedBy;
}

/** Whitespace collapsed; the text otherwise exactly as posted. */
export function cleanTitle(title: string | null): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

/** True when the head of a title reads as a product name rather than a clause. */
export function looksLikeName(head: string): boolean {
  if (head.length === 0 || head.length > MAX_NAME_LENGTH) return false;
  if (!/[a-z0-9]/i.test(head)) return false;
  if (head.split(" ").length > MAX_NAME_WORDS) return false;
  if (SENTENCE_OPENERS.test(head)) return false;
  return true;
}

/**
 * Repository slugs that are English words rather than names. TICKET-0013's fix
 * F1: the gate produced `torrix-ai/install` and `betterdb-inc/monitor` as
 * candidate names, and both are worse than plain — `install` and `monitor` read
 * as the product, which is a small invented claim of exactly the kind rule 1
 * forbids. In both the owner is the name.
 *
 * A guess, and labelled as one like the other constants in this file: the list
 * is what a repo gets called when it is *part* of something rather than the
 * thing itself. It is deliberately short. A distinctive slug — `bpfsnitch`,
 * `helix-db`, `autoagents` — is a name and is kept, because dropping it would
 * lose the only word that distinguishes two repos from one owner.
 */
export const GENERIC_REPO_SLUGS = [
  "install",
  "monitor",
  "server",
  "client",
  "docs",
  "doc",
  "documentation",
  "cli",
  "sdk",
  "api",
  "app",
  "web",
  "site",
  "www",
  "core",
  "lib",
  "demo",
  "example",
  "examples",
  "starter",
  "template",
  "tools",
  "utils",
  "config",
  "main",
  "home",
  "dashboard",
  "gateway",
  "proxy",
  "agent",
];

/**
 * The company's own address, used when the title does not name it: the
 * repository path on a code host (`acme/traces`, from a key of
 * `github.com/acme/traces`) and the registrable domain everywhere else. Both
 * are the identity dedup keyed on, so the name and the grouping cannot drift.
 *
 * Two cases drop the repo and keep the owner (F1). Neither invents anything —
 * the owner is part of the same address, so this is still lifting rather than
 * composing:
 *
 * - the slug is a generic word, so the owner carries what meaning there is;
 * - the slug repeats the owner (`Rocketgraph/rocketgraph`), where printing both
 *   says the same thing twice.
 */
export function nameFromKey(key: string, domain: string): string {
  const segments = key.split("/");
  if (segments.length <= 1) return domain;

  const [owner, repo, ...rest] = segments.slice(1);
  if (owner === undefined) return domain;
  if (repo === undefined || rest.length > 0) return segments.slice(1).join("/");

  const slug = repo.toLowerCase();
  if (GENERIC_REPO_SLUGS.includes(slug) || slug === owner.toLowerCase()) return owner;
  return `${owner}/${repo}`;
}

export function fallbackName(site: ResolvedSite): string {
  return nameFromKey(site.key, site.domain);
}

/**
 * A name and a one-liner from the primary post's title, or from the domain.
 *
 * The title is used only when it splits into a short head and a tail. The tail
 * becomes the one-liner; when there is no usable head the *whole* title becomes
 * the one-liner, because a sentence that does not name the company still
 * describes it, and it is the crispest description stage 1 has.
 */
export function deriveName(site: ResolvedSite, post: SitePost): DerivedName {
  const domain = fallbackName(site);
  const title = cleanTitle(post.hit.title);
  if (title.length === 0) return { name: domain, one_liner: "", named_by: "domain" };

  const body = title.replace(HN_TITLE_PREFIX, "").replace(LEADING_SEPARATOR, "").trim();
  if (body.length === 0) return { name: domain, one_liner: "", named_by: "domain" };

  const match = TITLE_SEPARATOR.exec(body);
  if (match === null || match.index === undefined) {
    return { name: domain, one_liner: body, named_by: "domain" };
  }

  const head = body.slice(0, match.index).replace(PARENTHETICAL, "").trim();
  const tail = body.slice(match.index + match[0].length).trim();
  if (!looksLikeName(head)) return { name: domain, one_liner: body, named_by: "domain" };
  return { name: head, one_liner: tail, named_by: "title" };
}

/**
 * The first free filename-safe slug for a name.
 *
 * Falls through name → domain → `candidate`, because a name can be entirely
 * non-ASCII and a slug still has to be a filename (`src/run.ts`). Collisions
 * take a numeric suffix rather than a hash: two candidates called `acme` are
 * `acme` and `acme-2`, which a reviewer can tell apart in a directory listing.
 *
 * `taken` is read and not written: the caller records a slug once the candidate
 * it belongs to has actually parsed, so a site that fails the contract does not
 * push the next real candidate to `-2`.
 */
export function slugFor(name: string, fallback: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || slugify(fallback) || "candidate";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

export interface CandidateContext {
  /** The query as approved in `query_plan.json` — not the raw seed. */
  query: string;
  /** The run clock, ISO. One value for the whole run, so a run is one moment. */
  at: string;
  source?: CandidateSource;
}

function provenanceFor(post: SitePost, context: CandidateContext): Provenance {
  const source = context.source ?? "hn";
  return {
    source,
    query: context.query,
    at: context.at,
    // An HN post has an `objectID`; a url-list entry has no source-native id
    // and says so rather than borrowing one.
    ref: source === "hn" ? post.hit.object_id : null,
    title: post.hit.title,
    posted_url: post.posted_url,
    posted_at: post.hit.created_at,
  };
}

/**
 * Every resolved site as a `Candidate`, in the order they were discovered.
 *
 * Parsed through the contract rather than cast to it: this is the last point
 * where a bad url or an empty name is cheap to see, and `candidates.jsonl` is
 * the artifact the next two stages read (CLAUDE.md invariant 5). A site that
 * cannot become a valid candidate is returned in `dropped` with the reason
 * instead of aborting the run — one malformed site is not a dead run.
 */
export function toCandidates(
  sites: readonly ResolvedSite[],
  context: CandidateContext,
): { candidates: Candidate[]; dropped: { key: string; reason: string }[] } {
  const taken = new Set<string>();
  const candidates: Candidate[] = [];
  const dropped: { key: string; reason: string }[] = [];

  for (const site of sites) {
    const primary = site.posts[0];
    if (primary === undefined) {
      dropped.push({ key: site.key, reason: "no posts — dedup produced an empty group" });
      continue;
    }

    const { name, one_liner } = deriveName(site, primary);
    const slug = slugFor(name, fallbackName(site), taken);
    const parsed = Candidate.safeParse({
      schema_version: CANDIDATE_SCHEMA_VERSION,
      slug,
      name,
      url: site.canonical_url,
      one_liner,
      provenance: site.posts.map((post) => provenanceFor(post, context)),
    });
    if (!parsed.success) {
      dropped.push({ key: site.key, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    taken.add(slug);
    candidates.push(parsed.data);
  }

  return { candidates, dropped };
}

// ---------------------------------------------------------------------------
// The `urls` seed form (SPEC §3.1) — the other survivor of TICKET-0002.
//
// A hand-written list of company urls, one per line. It reuses the classifier
// and the dedup key so a url typed by an operator is held to the same standard
// as one posted to HN, and it makes **no network requests at all**: there is no
// post to rank, so there is nothing for redirect resolution to disambiguate,
// and the site gets fetched in stage 2 as evidence anyway — where a redirect is
// followed, recorded and citable. A shortened url in a hand-written list is
// therefore resolved one stage later than an HN link, which is a real
// difference and a deliberate one.
// ---------------------------------------------------------------------------

/** A line that will not become a candidate, and why. */
export interface RejectedUrl {
  line: number;
  url: string;
  kind: SiteKind;
  reason: string;
}

/** Blank lines and `#` comments are skipped; everything else must be a url. */
export function parseUrlList(text: string): { line: number; url: string }[] {
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, url: raw.trim() }))
    .filter((entry) => entry.url.length > 0 && !entry.url.startsWith("#"));
}

/**
 * Candidates from a url list. Grouped by the same `siteKey` as HN sourcing, so
 * a list naming `acme.dev` and `acme.dev/pricing` produces one candidate whose
 * provenance records both lines.
 *
 * The name is always the domain: a hand-written list has no title to lift from,
 * and inventing one from the domain is the guess rule 1 forbids.
 */
export function candidatesFromUrls(
  entries: readonly { line: number; url: string }[],
  context: CandidateContext,
): { candidates: Candidate[]; rejected: RejectedUrl[] } {
  const groups = new Map<string, { name: string; url: string; provenance: Provenance[] }>();
  const rejected: RejectedUrl[] = [];

  for (const entry of entries) {
    const site = canonicaliseUrl(entry.url);
    if (site === null) {
      rejected.push({ ...entry, kind: "bad_url", reason: `not an http(s) url: ${entry.url}` });
      continue;
    }
    const classification = classifyUrl(site.canonical_url);
    if (!classification.usable) {
      rejected.push({ ...entry, kind: classification.kind, reason: classification.reason });
      continue;
    }
    const verdict = classifySite(site);
    if (!verdict.usable) {
      rejected.push({ ...entry, kind: verdict.kind, reason: verdict.reason });
      continue;
    }

    const provenance: Provenance = {
      source: "url_list",
      query: context.query,
      at: context.at,
      // No source-native id, no title, no post date. Three absences, all
      // written as absences (invariant 4).
      ref: null,
      title: null,
      posted_url: entry.url,
      posted_at: null,
    };
    const existing = groups.get(site.key);
    if (existing) {
      existing.provenance.push(provenance);
      continue;
    }
    groups.set(site.key, {
      name: nameFromKey(site.key, site.domain),
      url: site.canonical_url,
      provenance: [provenance],
    });
  }

  const taken = new Set<string>();
  const candidates: Candidate[] = [];
  for (const group of groups.values()) {
    const slug = slugFor(group.name, group.name, taken);
    const parsed = Candidate.safeParse({
      schema_version: CANDIDATE_SCHEMA_VERSION,
      slug,
      name: group.name,
      url: group.url,
      one_liner: "",
      provenance: group.provenance,
    });
    if (!parsed.success) {
      rejected.push({
        line: 0,
        url: group.url,
        kind: "bad_url",
        reason: parsed.error.issues[0]?.message ?? "invalid",
      });
      continue;
    }
    taken.add(slug);
    candidates.push(parsed.data);
  }
  return { candidates, rejected };
}
