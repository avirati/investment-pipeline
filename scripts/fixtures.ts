import { createHash } from "node:crypto";

/**
 * The pure half of `pnpm capture-fixtures` (TICKET-0014): everything the script
 * does to a response *after* it arrives, and everything it writes that never came
 * from the network at all.
 *
 * It lives apart from the runner for one reason — the runner needs a network
 * and the suite is not allowed one (CLAUDE.md, TESTING). Splitting the decisions
 * out from the I/O means the parts that can be wrong quietly — the secret scan,
 * the defect table, the normaliser — are tested offline, and the part that
 * cannot be tested offline is a `for` loop over a list.
 *
 * Three rules hold here:
 *
 * 1. **An allowlist decides what is written; a denylist decides what fails.**
 *    Only headers named in `HEADER_ALLOWLIST` reach a file. The scan is the
 *    second lock, not the first: it exists to catch a credential arriving
 *    somewhere nobody thought to look, which is always a response *body*.
 *
 * 2. **A finding never prints what it found.** `findSecrets` reports the rule
 *    that fired and a fingerprint. A capture script that echoes a live key into
 *    a terminal, a CI log or a worklog has moved the leak rather than stopped
 *    it.
 *
 * 3. **A fixture that is not a capture says so in code.** The malformed page and
 *    the malformed model outputs are *derived*, and their defect tables are
 *    right here — so "what is wrong with hit 3" is a line of code and not a
 *    claim in a README that drifted.
 */

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

export interface SecretPattern {
  /** Named, because the report says which rule fired and never the match. */
  name: string;
  pattern: RegExp;
}

/**
 * Deliberately biased towards false positives. The cost of one is an operator
 * dropping a page from the capture list; the cost of a false negative is a
 * credential in git history, which is not recoverable by editing a file.
 *
 * The last rule is the loose one and the one most likely to fire on a real
 * marketing page, whose inline bundle often carries a publishable Firebase or
 * analytics key. That is still the right answer: this script cannot tell a
 * publishable key from a private one, and the operator can.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi },
  { name: "credential-header", pattern: /^[ \t]*(authorization|set-cookie|cookie)[ \t]*:/gim },
  {
    name: "assigned-secret",
    pattern:
      /\b(api[_-]?key|secret|password|passwd|access[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/gi,
  },
];

export interface SecretFinding {
  /** Which rule fired. */
  rule: string;
  /** Character offset, so a human can go and look. */
  index: number;
  /**
   * A fingerprint of the match: its length and the first eight hex of its
   * sha256. Enough to tell two findings apart and to confirm a fix; not enough
   * to use. Rule 2 above.
   */
  fingerprint: string;
}

export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    // Each rule carries /g, so reset before reuse: lastIndex is per-RegExp and
    // these objects are module-level constants shared across calls.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({
        rule: name,
        index: match.index,
        fingerprint: `${match[0].length}b/${createHash("sha256").update(match[0]).digest("hex").slice(0, 8)}`,
      });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

/**
 * The only response headers that reach a file. Everything a fixture is for —
 * is it JSON, did it change — is in these three; nothing else is worth the risk
 * of writing a header this project has never read.
 */
export const HEADER_ALLOWLIST: readonly string[] = ["content-type", "etag", "last-modified"];

export function pickHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!HEADER_ALLOWLIST.includes(name)) continue;
    // An allowlisted header is still scanned: `etag` is opaque server output.
    if (findSecrets(value).length > 0) continue;
    picked[name] = value;
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Re-indent JSON so a fixture is diffable, and leave everything else alone.
 * Keys keep the order the server sent them in — `JSON.parse` preserves
 * insertion order for non-numeric keys, and re-sorting them would make the
 * fixture a tidied-up account of the response rather than the response.
 *
 * Throws on a body that is not JSON, which is the correct outcome: a fixture
 * named `.json` that holds an error page is worse than a failed capture.
 */
export function normaliseJson(body: string): string {
  return `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
}

/** Verbatim, plus the trailing newline every other file in the repo has. */
export function normaliseHtml(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Derived: the malformed Algolia page                                         */
/* -------------------------------------------------------------------------- */

export interface Defect {
  /** Index into `hits`. */
  hit: number;
  defect: string;
  /** What the parser must do with it. The table in the fixtures README. */
  expected: string;
  mutate: (hit: Record<string, unknown>) => void;
}

/**
 * The API does not serve broken records on demand, so `search-malformed.json`
 * is `search-page-0.json` with five deliberate defects — one per hit, in order.
 * They were applied by hand for TICKET-0009; this table is that edit written
 * down, and re-running the capture reproduces the committed file byte for byte.
 *
 * The mix is the point: four of the five are *survivable*, and a parser that
 * treats malformed as fatal throws away four usable posts to reject one.
 */
export const HN_DEFECTS: readonly Defect[] = [
  {
    hit: 0,
    defect: "`created_at` is prose, `created_at_i` intact",
    expected: "dated from the unix field",
    mutate: (hit) => {
      hit.created_at = "yesterday-ish";
    },
  },
  {
    hit: 1,
    defect: "`created_at` null, `created_at_i` absent",
    expected: "`created_at: null`, hit kept",
    mutate: (hit) => {
      hit.created_at = null;
      delete hit.created_at_i;
    },
  },
  {
    hit: 2,
    defect: "`created_at_i` is a string, `created_at` intact",
    expected: "dated from the ISO field",
    mutate: (hit) => {
      hit.created_at_i = String(hit.created_at_i);
    },
  },
  {
    hit: 3,
    defect: "`points` absent, `num_comments` null",
    expected: "both `null` — never `0`",
    mutate: (hit) => {
      delete hit.points;
      hit.num_comments = null;
    },
  },
  {
    hit: 4,
    defect: "`objectID` absent",
    expected: "dropped, with a reason",
    mutate: (hit) => {
      delete hit.objectID;
    },
  },
];

/**
 * Apply `HN_DEFECTS` to a captured page. Refuses a page with too few hits
 * rather than silently producing a fixture with fewer defects than its README
 * documents.
 */
export function deriveMalformedPage(
  page: unknown,
  defects: readonly Defect[] = HN_DEFECTS,
): unknown {
  const clone = structuredClone(page) as { hits?: unknown };
  const hits = clone.hits;
  if (!Array.isArray(hits)) throw new TypeError("not a search response: no `hits` array");
  for (const defect of defects) {
    const hit = hits[defect.hit];
    if (typeof hit !== "object" || hit === null) {
      throw new RangeError(
        `source page has no hit ${defect.hit}; ${defects.length} hits are needed to carry every defect`,
      );
    }
    defect.mutate(hit as Record<string, unknown>);
  }
  return clone;
}
