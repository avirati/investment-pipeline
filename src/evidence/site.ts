import { load } from "cheerio";
import type { ExtractedHtml } from "./fetch.js";

/**
 * The company-site adapter (TICKET-0016). SCOPE in-scope #2 puts team/about
 * extraction here, and SPEC's D-4 disqualifier — "no self-serve or open-source
 * path by which a developer can adopt it without a contract" — turns on
 * whether such a path exists on the site *at all*, which is a question about
 * links before it is a question about prose.
 *
 * Four rules hold in this file, three of them inherited from
 * `src/evidence/github.ts` because stage 2's two adapters should fail the same
 * way:
 *
 * 1. **A wrong founder is worse than a missing one** (SCOPE cut corner 1).
 *    This is the one rule that is specific to this module, and it is the
 *    reason `extractPeople` requires a *corroborating role* next to every name
 *    it emits rather than emitting everything that looks like a name. A page
 *    of testimonials, a list of investors and a blog author byline all look
 *    exactly like a founder list to a name-shaped regex. Under-extracting
 *    costs coverage, which the memo is required to say out loud; over-
 *    extracting puts a stranger's name in an investment memo.
 *
 * 2. **This module concludes nothing.** It records that a `/pricing` link
 *    exists, not that the company is self-serve. D-4 is scored in
 *    `src/analyse/score.ts` and nowhere else (CLAUDE.md invariant 7).
 *
 * 3. **Failure is data.** A 404, a timeout and a client-rendered empty shell
 *    are three recorded outcomes, never a thrown one (ARCHITECTURE §5,
 *    TESTING §6). A company whose site is a Framer page with no server-
 *    rendered text is a real company; the run says so and loses coverage.
 *
 * 4. **English only, and say so** (SCOPE cut corner 4). A page that declares a
 *    non-English language, or that is written in a non-Latin script, is kept
 *    as evidence and excluded from people extraction, because a name-shape
 *    heuristic tuned on English produces confident nonsense elsewhere.
 *
 * The pure half of the module is everything down to `extractPeople`: markup in,
 * data out, no transport. That is deliberate — every judgement call here is a
 * hand-written word list or a threshold, and each one is worth a test against a
 * committed fixture rather than a live page.
 */

/* -------------------------------------------------------------------------- */
/* Where a link points                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a link on a company's home page is *for*. Not a taxonomy of the web —
 * just the roles the rubric has a use for:
 *
 * - `team` — where founders are named (D1).
 * - `pricing`, `docs`, `signup`, `repo` — the four public shapes of a
 *   self-serve or open-source adoption path (D-4).
 * - `contact` — the counterweight: "book a demo" as the *only* call to action
 *   is what D-4 describes. Recorded so the absence of the others means
 *   something.
 * - `other` — everything else, which is most of a page and is dropped.
 */
export type LinkRole = "team" | "pricing" | "docs" | "signup" | "contact" | "repo" | "other";

/**
 * Rules read in order; the first match wins. `path` matches the url's path,
 * `text` the anchor's own words. Both are needed: `/editions` is coroot's
 * pricing page and says so only in the path, while a "Get started" button
 * routinely points at a hashed app url that says nothing at all.
 *
 * This is a hand-written word list, the same class of guess as
 * `RESERVED_OWNERS` in the GitHub adapter, and it fails in the cheap
 * direction: an unmatched link costs one page this run did not read, and the
 * home page's own text usually still carries the signal.
 */
interface LinkRule {
  role: LinkRole;
  name: string;
  path?: RegExp;
  text?: RegExp;
  /** `docs.acme.com` and the like: matched on the host, not the path. */
  host?: RegExp;
}

export const LINK_RULES: readonly LinkRule[] = [
  // Ordered by how specific the evidence is, not alphabetically. `signup`
  // precedes `pricing` because "/pricing#start" is a sign-up path and the
  // stronger of the two claims.
  {
    role: "repo",
    name: "code host",
    host: /^(www\.)?(github\.com|gitlab\.com|codeberg\.org|git\.sr\.ht)$/i,
  },
  {
    role: "signup",
    name: "sign-up path",
    path: /(^|\/)(sign[-_]?up|signin|sign[-_]?in|register|get[-_]?started|start[-_]?free|try([-_]?it)?([-_]?free)?|free[-_]?trial|download|install|app|account\/signup)(\/|$)/i,
    text: /\b(sign\s?up|get\s?started|start\s?(free|now|building)|try\s?(it\s?)?(free|now)?|free\s?trial|download|install)\b/i,
  },
  {
    role: "pricing",
    name: "pricing page",
    path: /(^|\/)(pricing|plans?|editions?|subscribe)(\/|$)/i,
    text: /\b(pricing|plans|editions)\b/i,
  },
  {
    role: "docs",
    name: "documentation",
    host: /^docs?\./i,
    path: /(^|\/)(docs?|documentation|guides?|quickstart|getting[-_]?started|reference|api[-_]?reference)(\/|$)/i,
    text: /\b(docs|documentation|quickstart|api reference)\b/i,
  },
  {
    role: "team",
    name: "team or about page",
    path: /(^|\/)(team|about([-_]us)?|company|founders?|our[-_]?story|who[-_]?we[-_]?are|people|leadership|meet[-_]?the[-_]?team)(\/|$)/i,
    text: /\b(our team|meet the team|about us|about|company|founders?|leadership|who we are)\b/i,
  },
  {
    role: "contact",
    name: "sales or demo path",
    path: /(^|\/)(contact([-_]us)?|(get[-_]?|book[-_]?|request[-_]?|schedule[-_]?)?demo|sales|talk[-_]?to[-_]?us|enterprise)(\/|$)/i,
    text: /\b(contact( us)?|(book|get|request|schedule) a? ?demo|talk to (us|sales)|contact sales)\b/i,
  },
];

/** Absolute, http(s), no fragment, no trailing `index.html`. Null when unusable. */
export function absoluteLink(href: string, base: string): string | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return null;
  // `mailto:`, `tel:` and `javascript:` are links a person follows, not pages.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url.toString();
}

/** Hostname without `www.`, lowercased. The unit `sameSite` compares. */
export function siteHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Whether a link stays on the company's own site. Equal hosts, or one a
 * subdomain of the other — `docs.coroot.com` belongs to `coroot.com` and is
 * exactly the page D-4 wants read.
 *
 * Deliberately *not* `siteKey` from `src/source/resolve.ts`: that is stage 1's
 * internals and CLAUDE.md invariant 5 keeps stages out of each other. The
 * suffix test is also the safer of the two here, because it needs no public
 * suffix list to be right about the case it meets — a company and its own
 * subdomain. Where it is wrong is `a.github.io` vs `b.github.io`, and it is
 * wrong in the direction of *rejecting* the link, which costs a page.
 */
export function sameSite(url: string, base: string): boolean {
  const host = siteHost(url);
  const baseHost = siteHost(base);
  if (host === null || baseHost === null) return false;
  return host === baseHost || host.endsWith(`.${baseHost}`) || baseHost.endsWith(`.${host}`);
}

/** How much anchor text is kept. Long enough to read, short enough for a log. */
const LINK_TEXT_LIMIT = 120;

export interface DiscoveredLink {
  /** Absolute and fragment-free, so two links to the same page dedup. */
  url: string;
  role: LinkRole;
  /** The anchor's own words, normalised and capped. */
  text: string;
  /** Which rule fired, and on what. Recorded so a wrong guess is readable. */
  matched: string;
  /** False for a code host, which is the one off-site role worth keeping. */
  same_site: boolean;
}

function classify(url: string, text: string): { role: LinkRole; matched: string } {
  let host: string;
  let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } catch {
    return { role: "other", matched: "unparseable url" };
  }
  for (const rule of LINK_RULES) {
    if (rule.host?.test(host)) return { role: rule.role, matched: `${rule.name} (host)` };
    if (rule.path?.test(path)) return { role: rule.role, matched: `${rule.name} (path)` };
    if (rule.text?.test(text)) return { role: rule.role, matched: `${rule.name} (link text)` };
  }
  return { role: "other", matched: "no rule matched" };
}

/**
 * Every link on a page that has a role, in document order, deduplicated by url.
 *
 * Document order is load-bearing rather than incidental: a site's primary
 * navigation comes before its footer, so the first `/pricing` on the page is
 * the one a visitor would click. Keeping the first occurrence therefore keeps
 * the better link, and it makes the output stable across runs, which a
 * committed manifest needs.
 */
export function discoverLinks(html: string, base: string): DiscoveredLink[] {
  const $ = load(html);
  const seen = new Set<string>();
  const links: DiscoveredLink[] = [];

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const url = absoluteLink(anchor.attr("href") ?? "", base);
    if (url === null || seen.has(url)) return;

    const text = anchor
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, LINK_TEXT_LIMIT)
      // An icon-only link has no words; its `aria-label` is what it says.
      .trim();
    const label = text || (anchor.attr("aria-label") ?? "").replace(/\s+/g, " ").trim();

    const { role, matched } = classify(url, label);
    if (role === "other") {
      seen.add(url);
      return;
    }
    const onSite = sameSite(url, base);
    // A code host is the only role worth following off-site, because the
    // open-source adoption path D-4 asks about is by definition not hosted by
    // the company. Everything else off-site is somebody else's page.
    if (!onSite && role !== "repo") {
      seen.add(url);
      return;
    }
    seen.add(url);
    links.push({ url, role, text: label, matched, same_site: onSite });
  });

  return links;
}

/**
 * The pages worth spending a request on, in the order they are read. Team
 * first: it is the only one of the three that carries facts nothing else in
 * the pipeline can supply, and a run that runs out of budget should run out
 * of it on `docs` rather than on founders.
 *
 * `signup`, `contact` and `repo` are deliberately absent. A sign-up page is a
 * form, a demo-request page is a form, and the repository is the GitHub
 * adapter's job — all three are worth *recording as links* and none is worth
 * fetching for prose.
 */
export const FETCHED_ROLES: readonly LinkRole[] = ["team", "pricing", "docs"];

/**
 * Requests this adapter will spend on one company beyond its home page. Three
 * is one per fetched role, so the ceiling is four pages a company: enough for
 * the two dimensions this module feeds, and small enough that a `--limit 20`
 * run is 80 requests rather than a crawl. A crawler is out of scope (SCOPE:
 * agentic browsing) and this constant is where that stays true.
 */
export const SITE_PAGE_BUDGET = 3;

/**
 * One link per fetched role, best first. "Best" is document order within a
 * role, which `discoverLinks` has already applied.
 */
export function pickPages(
  links: readonly DiscoveredLink[],
  budget = SITE_PAGE_BUDGET,
): DiscoveredLink[] {
  const picked: DiscoveredLink[] = [];
  for (const role of FETCHED_ROLES) {
    if (picked.length >= budget) break;
    const link = links.find((candidate) => candidate.role === role && candidate.same_site);
    if (link) picked.push(link);
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Is there a page here at all                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Below this a 200 is treated as a shell rather than a page. TESTING §6 names
 * the empty JS shell as a failure shape to handle, and it is the one that
 * looks like success: the request worked, the status is 200, and the record
 * would carry forty characters of a cookie banner.
 *
 * 300 characters is roughly a paragraph. `extractHtml` already falls back from
 * an empty `<main>` to `<body>` (its `MAIN_MIN_CHARS`), so a page reaching
 * this check with less than a paragraph really has nothing server-rendered.
 */
export const SHELL_MAX_CHARS = 300;

export interface ShellVerdict {
  /** True when the response was a 200 with nothing in it worth reading. */
  empty: boolean;
  chars: number;
  /** Non-null when `empty`: one line, written into the record's own text. */
  reason: string | null;
}

/**
 * Distinguish "the page has little to say" from "the page is rendered by
 * JavaScript we do not run". Both are recorded as `empty`, because the
 * consequence is identical — no prose reaches extraction — but the reason
 * separates them, and the reason is what a reviewer reads when coverage on a
 * company is low.
 *
 * SCOPE rules out a headless browser (agentic browsing, and the cost is
 * dependency weight for a minority of sites). This function is that cut made
 * visible rather than silent.
 */
export function detectEmptyShell(page: ExtractedHtml, html: string): ShellVerdict {
  const chars = page.text.trim().length;
  if (chars > SHELL_MAX_CHARS) return { empty: false, chars, reason: null };

  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const clientRendered =
    scripts > 0 && /<div[^>]+id=["'](root|app|__next|___gatsby)["']/i.test(html);
  const reason = clientRendered
    ? `the page returned 200 with ${chars} characters of text and renders client-side ` +
      `(${scripts} script tags, an empty mount element); this pipeline does not run a browser`
    : `the page returned 200 with ${chars} characters of extractable text`;
  return { empty: true, chars, reason };
}

/* -------------------------------------------------------------------------- */
/* English only                                                                */
/* -------------------------------------------------------------------------- */

export type LanguageVerdict = "english" | "not_english" | "unknown";

export interface LanguageCheck {
  verdict: LanguageVerdict;
  /** `<html lang>` or `og:locale`, as written. Null when the page declares none. */
  declared: string | null;
  /** A non-Latin script, when one dominates: `cyrillic`, `cjk`, `arabic`, … */
  script: string | null;
  /** Share of tokens that are common English words. Null on too little text. */
  english_ratio: number | null;
  /** One line naming which of the three tests decided it. */
  reason: string;
}

/**
 * Ranges that settle the question without a language model. A page that is
 * mostly Han, Cyrillic or Arabic characters is not English whatever its `lang`
 * attribute says, and unlike a stopword ratio this test cannot be fooled by a
 * short page.
 */
const SCRIPTS: readonly [string, RegExp][] = [
  ["cjk", /[぀-ヿ㐀-䶿一-鿿가-힯]/g],
  ["cyrillic", /[Ѐ-ӿ]/g],
  ["arabic", /[؀-ۿݐ-ݿ]/g],
  ["devanagari", /[ऀ-ॿ]/g],
  ["hebrew", /[֐-׿]/g],
  ["greek", /[Ͱ-Ͽ]/g],
  ["thai", /[฀-๿]/g],
];

/** A fifth of the letters in one script is well past incidental. */
const SCRIPT_SHARE = 0.2;

/**
 * The hundred-odd words that carry no meaning and appear in every English
 * sentence. A ratio over a Latin-script page separates English from Spanish,
 * German and French, which the script test cannot.
 */
const ENGLISH_STOPWORDS = new Set(
  (
    "the of and to a in is it you that he was for on are as with his they i at be this have from " +
    "or one had by word but not what all were we when your can said there use an each which she do " +
    "how their if will up other about out many then them these so some her would make like him into " +
    "time has look two more write go see number no way could people my than first been call who its " +
    "now find long down day did get come made may our"
  ).split(" "),
);

/** Below this the ratio is noise: a hero line is four words and no verdict. */
const LANGUAGE_MIN_TOKENS = 40;
/** Under this share of stopwords, Latin-script prose is not English prose. */
const ENGLISH_MIN_RATIO = 0.1;

/** Share of tokens that are English stopwords, or null on too little text. */
export function englishRatio(text: string): number | null {
  const tokens = text.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? [];
  if (tokens.length < LANGUAGE_MIN_TOKENS) return null;
  const hits = tokens.filter((token) => ENGLISH_STOPWORDS.has(token)).length;
  return hits / tokens.length;
}

/**
 * SCOPE cut corner 4 made operational: decide whether a page is English, and
 * when it is not, say which test decided and stop rather than extract.
 *
 * The three tests are read in order of how hard they are to fool. A declared
 * language is the page's own claim about itself and is usually right; a
 * dominant non-Latin script overrules it, because `lang="en"` on a Japanese
 * page is a template default and the characters are not; a stopword ratio is
 * the last resort and only speaks when there is enough text to speak about.
 *
 * `unknown` is a real verdict and is *not* treated as "not English" by the
 * caller: most company sites declare nothing, and refusing to read them would
 * cut the pipeline's coverage to nearly nothing for a hazard that in practice
 * hardly occurs on this source. That is a stated assumption, not a measurement.
 */
export function detectLanguage(html: string, text: string): LanguageCheck {
  const $ = load(html);
  const declared =
    $("html").attr("lang")?.trim() ||
    $('meta[property="og:locale"]').first().attr("content")?.trim() ||
    null;

  const letters = (text.match(/\p{L}/gu) ?? []).length;
  let script: string | null = null;
  if (letters > 0) {
    for (const [name, pattern] of SCRIPTS) {
      const count = (text.match(pattern) ?? []).length;
      if (count / letters >= SCRIPT_SHARE) {
        script = name;
        break;
      }
    }
  }
  const ratio = englishRatio(text);

  if (script !== null) {
    return {
      verdict: "not_english",
      declared,
      script,
      english_ratio: ratio,
      reason: `the page is predominantly ${script} script`,
    };
  }
  if (declared !== null && !/^en\b/i.test(declared)) {
    return {
      verdict: "not_english",
      declared,
      script,
      english_ratio: ratio,
      reason: `the page declares lang="${declared}"`,
    };
  }
  if (ratio !== null && ratio < ENGLISH_MIN_RATIO) {
    return {
      verdict: "not_english",
      declared,
      script,
      english_ratio: ratio,
      reason:
        `only ${(ratio * 100).toFixed(0)}% of words are common English words, ` +
        `below the ${(ENGLISH_MIN_RATIO * 100).toFixed(0)}% floor`,
    };
  }
  if (declared !== null) {
    return {
      verdict: "english",
      declared,
      script,
      english_ratio: ratio,
      reason: `the page declares lang="${declared}"`,
    };
  }
  if (ratio !== null) {
    return {
      verdict: "english",
      declared,
      script,
      english_ratio: ratio,
      reason: `${(ratio * 100).toFixed(0)}% of words are common English words`,
    };
  }
  return {
    verdict: "unknown",
    declared,
    script,
    english_ratio: ratio,
    reason: "the page declares no language and has too little text to judge",
  };
}

/* -------------------------------------------------------------------------- */
/* Named people                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One person named on a company's own page, with the words that say who they
 * are. Never "a founder" — the role is quoted verbatim and this module does not
 * decide what it means (rule 2). `Alexander Lamberton — Marketing Manager` is
 * as much an output of this function as the CEO is; SPEC D1 is what separates
 * them, and it lives in the rubric.
 */
export interface Person {
  /** As written on the page, whitespace-normalised. Never composed or corrected. */
  name: string;
  /** The corroborating text: a job title, a prior role, verbatim and capped. */
  role: string;
  /** Which pattern found this, so a wrong extraction is traceable to a rule. */
  matched: "role element after name" | "name and role on one line";
  /** The surrounding block, capped — the reviewer's check on the extraction. */
  context: string;
}

/**
 * A name that looked like a person and was not emitted, and why. Rule 1's
 * "fail loudly" half: a run that under-extracts should be able to say what it
 * threw away, because the alternative is a silent zero that looks like a site
 * with no team page.
 */
export interface RejectedPerson {
  name: string;
  reason: string;
}

export interface PeopleResult {
  people: Person[];
  rejected: RejectedPerson[];
  /** Non-null when nothing was scanned at all, naming why. */
  skipped: string | null;
}

/**
 * Words that make a nearby line a *statement about a person's job*. The
 * corroboration rule 1 requires: without one of these next to it, a
 * name-shaped string is not emitted, whatever else the page says.
 *
 * The list is deliberately broad — it includes `Marketing Manager` and
 * `Advisor`, not just the founder titles — because narrowing it here would be
 * this module deciding who counts, which is the rubric's job (rule 2). What it
 * must not include is anything that fires on ordinary marketing prose.
 */
export const ROLE_CUES =
  /\b(co[-\s]?founder|founder|founded|founding|ceo|cto|coo|cfo|cpo|cro|chief\s+\w+\s+officer|president|partner|principal|chair(man|woman|person)?|board\s+member|advis[oe]r|investor|head\s+of\b|vp\b|vice\s+president|director|manager|lead\b|engineer(ing)?|developer|architect|scientist|researcher|designer|sre\b|ex-|previously|formerly|prior\s+to)\b/i;

/**
 * Title-cased words that turn up in headings and calls to action and never in
 * a person's name. The shape test alone accepts "Why We Built Coroot"; the
 * role-cue requirement usually rejects it afterwards, and this list is the
 * second lock on the same door — cheap, and the failure it prevents is the
 * expensive one.
 */
const NAME_STOPWORDS = new Set(
  (
    "about all and are ask book built by can case company contact cookie demo docs " +
    "download engineering enterprise every for free get github how join learn log " +
    "login made make meet more news now our out platform policy pricing privacy " +
    "product ready read request see settings sign start started stories story team " +
    "teams terms the their they this to try up us use want was way we what when " +
    "where who why with work you your zero"
  ).split(" "),
);

/** Lowercase particles that are part of a surname rather than a new word. */
const NAME_PARTICLES = new Set(
  "van von de del della den der di da du la le los bin ibn al ter dos".split(" "),
);

/** Longest a person's name may be. Past this it is a sentence, not a name. */
const NAME_MAX_CHARS = 60;
/** People emitted from one page. A team page lists a team, not a directory. */
export const MAX_PEOPLE = 12;
/** How much surrounding text is kept as the reviewer's check. */
const CONTEXT_LIMIT = 240;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether a string has the shape of a person's name in English. Shape only —
 * on its own this is *not* enough to emit anything, and the two callers below
 * both require a role beside it.
 *
 * Two to four tokens, each either a capitalised word, an initial, or a
 * lowercase particle; at least two real capitalised words, so "J. R." is not a
 * person; no digits, no stopwords, and no role cue inside the name itself,
 * which is what stops "Head Of Engineering" from being read as somebody called
 * Head.
 */
export function looksLikeName(value: string): boolean {
  const name = squash(value);
  if (name.length === 0 || name.length > NAME_MAX_CHARS) return false;
  if (/[0-9@#|/\\()[\]{}<>]/.test(name)) return false;
  if (ROLE_CUES.test(name)) return false;

  const tokens = name.split(" ");
  if (tokens.length < 2 || tokens.length > 4) return false;

  let words = 0;
  for (const token of tokens) {
    const bare = token.replace(/[.,]$/, "");
    if (NAME_STOPWORDS.has(bare.toLowerCase())) return false;
    if (NAME_PARTICLES.has(bare.toLowerCase())) continue;
    // An initial: "M." arrives here as "M", the trailing stop already gone.
    if (/^\p{Lu}$/u.test(bare)) continue;
    if (!/^\p{Lu}[\p{L}'’-]+$/u.test(bare)) return false;
    words += 1;
  }
  return words >= 2;
}

/** Headings that mean "the people are below this". */
const TEAM_HEADING =
  /\b(team|founders?|who\s+we\s+are|leadership|about\s+us|meet\s+the|our\s+people|the\s+people)\b/i;

/**
 * A quoted sentence next to a name is a testimonial, and a testimonial is a
 * *customer*. This is the false-positive class that would otherwise put a
 * stranger's name in a memo as though they worked here, so a name whose
 * surrounding block quotes forty or more characters is rejected with a reason
 * rather than emitted.
 */
const TESTIMONIAL = /["“”][^"“”]{40,}["“”]/;

/** How far a name element's siblings are searched for the role beside it. */
const ROLE_LOOKAHEAD = 2;

/**
 * Named people on one page, best-effort and biased towards missing them.
 *
 * `pageRole` decides what is scanned, and it is the cheapest guard in the
 * module. On a page fetched *because* it is the team page, the whole page is
 * the team. On a home page the scan is confined to the subtree under a heading
 * that says "team" — which is what keeps a wall of customer logos and a
 * quote-carousel out of the founder list, since neither sits under that
 * heading. A home page with no such heading yields nothing and says so.
 *
 * Two patterns produce a person, and both need a role beside the name:
 *
 * - **role element after name** — `<h3>Nikolay Sivko</h3><p>Co-founder, CEO</p>`,
 *   which is what a team-card component compiles to.
 * - **name and role on one line** — `Priya Raghavan — previously staff SRE at
 *   Fathom Logistics`, which is what a hand-written team list looks like.
 */
export function extractPeople(html: string, pageRole: "home" | "team"): PeopleResult {
  const $ = load(html);
  $("script,style,noscript,template,svg,nav,footer").remove();

  let scope = $("body");
  if (pageRole === "home") {
    const heading = $("h1,h2,h3,h4,h5,h6,legend").filter((_, element) =>
      TEAM_HEADING.test(squash($(element).text())),
    );
    if (heading.length === 0) {
      return { people: [], rejected: [], skipped: "the page names no team section" };
    }
    // The heading's own container, not the whole page: a "Team" heading and
    // the cards under it share a parent, and stopping there is what confines
    // the scan. `.parent()` is right for the common case and one level too
    // narrow for a flat layout, which costs people and never invents them.
    scope = heading.first().parent();
  }

  const people: Person[] = [];
  const rejected: RejectedPerson[] = [];
  const seen = new Set<string>();

  const accept = (name: string, role: string, matched: Person["matched"], block: string): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (TESTIMONIAL.test(block)) {
      rejected.push({ name, reason: "the surrounding block is a quotation — probably a customer" });
      return;
    }
    if (people.length >= MAX_PEOPLE) {
      rejected.push({ name, reason: `more than ${MAX_PEOPLE} names on one page` });
      return;
    }
    people.push({
      name,
      role: squash(role).slice(0, CONTEXT_LIMIT),
      matched,
      context: squash(block).slice(0, CONTEXT_LIMIT),
    });
  };

  scope.find("*").each((_, element) => {
    const node = $(element);
    // Leaves only. A name lives in its own element; a wrapper's text is the
    // name plus everything beside it, which no shape test should be asked to
    // read.
    if (node.children().length > 0) return;
    const text = squash(node.text());
    if (text === "") return;

    // Pattern A: this element is the name, the next one is the role.
    if (looksLikeName(text)) {
      let sibling = node.next();
      for (let step = 0; step < ROLE_LOOKAHEAD && sibling.length > 0; step += 1) {
        const beside = squash(sibling.text());
        if (beside !== "" && ROLE_CUES.test(beside)) {
          accept(text, beside, "role element after name", squash(node.parent().text()));
          return;
        }
        if (beside !== "") break;
        sibling = sibling.next();
      }
      rejected.push({ name: text, reason: "no role or prior position stated beside the name" });
      return;
    }

    // Pattern B: name and role share a line, split by a dash, a comma or a pipe.
    const split = text.match(/^(.{2,60}?)\s*[—–\-–|,:]\s+(.{3,})$/);
    if (split) {
      const [, head, tail] = split;
      if (head !== undefined && tail !== undefined && looksLikeName(head) && ROLE_CUES.test(tail)) {
        accept(head.trim(), tail, "name and role on one line", text);
      }
    }
  });

  return { people, rejected, skipped: null };
}
