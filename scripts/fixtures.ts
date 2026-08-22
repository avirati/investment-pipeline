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

/* -------------------------------------------------------------------------- */
/* Authored: model outputs                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A file this script writes from a table rather than fetching. Model output is
 * not a response anyone can capture on demand — the interesting ones are the
 * shapes a model produces on a bad day — so they are authored, and the table is
 * the fixture's own documentation.
 */
export interface AuthoredFixture {
  path: string;
  note: string;
  content: string;
}

/**
 * Evidence ids as the store would mint them: `sha256(url + retrieved_at)`
 * truncated to 16 hex (ADR-0003). These four are the real ids of four fixtures
 * in this directory, so a reader can follow a citation to the page it came from
 * instead of to a placeholder.
 */
const EV = {
  about: "bce0ab514b07a85c",
  home: "a55c35a284bc355c",
  repo: "4a8752310d71146d",
  org: "16c5fcf829243a3b",
} as const;

/**
 * The extraction output a good day produces. Facts about Coroot, drawn from the
 * two site pages and two GitHub payloads committed beside this file, so the
 * whole set is internally consistent: every id here resolves to a fixture.
 *
 * The *envelope* — whether stage 2 asks for a bare array or an object with a
 * `facts` key — is TICKET-0019's to decide, and is deliberately not pinned here.
 * These files hold the array; the schema around it is the prompt's business.
 */
const VALID_FACTS: unknown[] = [
  {
    schema_version: 1,
    key: "founder.prior_exit",
    statement: "Co-founder Peter Zaitsev previously built Percona and FerretDB.",
    value: true,
    evidence_ids: [EV.about],
    confidence: "high",
  },
  {
    schema_version: 1,
    key: "team.size_visible",
    statement:
      "Three people are named on the about page: a CEO, an advisor and a marketing manager.",
    value: 3,
    evidence_ids: [EV.about],
    confidence: "medium",
  },
  {
    schema_version: 1,
    key: "product.one_liner",
    statement: "eBPF-powered observability platform that needs no code changes.",
    value: "Full-stack observability in minutes",
    evidence_ids: [EV.home],
    confidence: "high",
  },
  {
    schema_version: 1,
    key: "traction.github_stars",
    statement: "The main repository has 7,884 stars.",
    value: 7884,
    evidence_ids: [EV.repo],
    confidence: "high",
  },
  {
    schema_version: 1,
    key: "org.github_account_type",
    statement: "The GitHub owner is an organisation, not a personal account.",
    value: "Organization",
    evidence_ids: [EV.org, EV.repo],
    confidence: "high",
  },
];

export interface FactDefect {
  /** Index in the malformed array. */
  index: number;
  defect: string;
  /** What the parse must do with it. Asserted in `tests/model-fixtures.test.ts`. */
  expected: "dropped" | "kept";
  /** Why it matters, in one line. */
  because: string;
  fact: unknown;
}

/**
 * One defect per item, in order — the same convention as `HN_DEFECTS`. Seven of
 * the eight are dropped at parse time; the eighth is the one that matters most,
 * because it is well-formed and still wrong.
 */
export const FACT_DEFECTS: readonly FactDefect[] = [
  {
    index: 0,
    defect: "`evidence_ids` absent",
    expected: "dropped",
    because:
      "The load-bearing one. An uncited fact is dropped at parse time, and that drop *is* the citation guarantee (ADR-0003, CLAUDE.md invariant 2).",
    fact: {
      schema_version: 1,
      key: "market.size_usd",
      statement: "The observability market is worth $17B.",
      value: 17_000_000_000,
      confidence: "high",
    },
  },
  {
    index: 1,
    defect: "`evidence_ids` present but empty",
    expected: "dropped",
    because:
      "`.min(1)`, so an empty array is not a weaker citation than none — it is the same thing spelled differently.",
    fact: {
      schema_version: 1,
      key: "founder.count",
      statement: "The company has two founders.",
      value: 2,
      evidence_ids: [],
      confidence: "medium",
    },
  },
  {
    index: 2,
    defect: "an `evidence_ids` entry that resolves to nothing",
    expected: "kept",
    because:
      "Well-formed and still wrong: the id is the right shape and no record has it. The parser cannot catch this — the memo validator must (TICKET-0025), and this fixture is why that ticket exists.",
    fact: {
      schema_version: 1,
      key: "funding.raised_usd",
      statement: "The company raised a $5M seed round.",
      value: 5_000_000,
      evidence_ids: ["0000000000000000"],
      confidence: "high",
    },
  },
  {
    index: 3,
    defect: "`value` is an object",
    expected: "dropped",
    because:
      "Facts are atoms. A nested document here is the model inventing its own schema, and the rubric would have to parse English to score it.",
    fact: {
      schema_version: 1,
      key: "team.founders",
      statement: "Two founders, both technical.",
      value: { count: 2, technical: true },
      evidence_ids: [EV.about],
      confidence: "medium",
    },
  },
  {
    index: 4,
    defect: "`confidence` outside the enum",
    expected: "dropped",
    because:
      "A model asked for three levels will occasionally invent a fourth. Accepting it would put an unranked value in front of the rubric.",
    fact: {
      schema_version: 1,
      key: "product.open_source",
      statement: "The product is open source under Apache-2.0.",
      value: true,
      evidence_ids: [EV.repo],
      confidence: "very high",
    },
  },
  {
    index: 5,
    defect: "`schema_version` from a future contract",
    expected: "dropped",
    because:
      "A literal, not a number. A cached response written under a newer schema must fail loudly rather than be read as if the fields still meant the same thing (CLAUDE.md invariant 6).",
    fact: {
      schema_version: 2,
      key: "product.one_liner",
      statement: "Observability without code changes.",
      value: "Observability without code changes",
      evidence_ids: [EV.home],
      confidence: "high",
    },
  },
  {
    index: 6,
    defect: "`statement` is empty",
    expected: "dropped",
    because:
      "The statement is the sentence a partner reads. An empty one renders as a citation attached to nothing.",
    fact: {
      schema_version: 1,
      key: "traction.customers_named",
      statement: "",
      value: null,
      evidence_ids: [EV.home],
      confidence: "low",
    },
  },
  {
    index: 7,
    defect: "`key` absent",
    expected: "dropped",
    because:
      "The rubric switches on `key`. Without one the fact is prose, and scoring prose is not deterministic scoring (ADR-0002).",
    fact: {
      schema_version: 1,
      statement: "The founders met at a previous company.",
      value: true,
      evidence_ids: [EV.about],
      confidence: "low",
    },
  },
];

/**
 * The missing-data case TESTING §6 asks for by name: valid JSON where the model
 * found nothing. Every value is null, every confidence is low, and every fact is
 * still cited — because "we looked and could not tell" is a finding about the
 * page, and it must reach the rubric as reduced coverage rather than as a zero
 * or an absence (CLAUDE.md invariant 4).
 */
const UNKNOWN_FACTS: unknown[] = [
  {
    schema_version: 1,
    key: "founder.prior_exit",
    statement: "No prior exit is stated anywhere on the site.",
    value: null,
    evidence_ids: [EV.about],
    confidence: "low",
  },
  {
    schema_version: 1,
    key: "funding.raised_usd",
    statement: "No funding is mentioned on the site or in the repository.",
    value: null,
    evidence_ids: [EV.home, EV.repo],
    confidence: "low",
  },
  {
    schema_version: 1,
    key: "team.size_visible",
    statement: "No team or about section names anyone.",
    value: null,
    evidence_ids: [EV.home],
    confidence: "low",
  },
];

/** The model that answered the question instead of filling in the schema. */
const PROSE_ANSWER = `I looked at the pages you gave me and I'm afraid there isn't
enough here to say much. The site is a marketing page and the repository README
is mostly installation instructions. If you can give me the team page or a
funding announcement I can try again.

Let me know how you'd like to proceed!
`;

export function modelFixtures(): AuthoredFixture[] {
  return [
    {
      path: "model/facts-valid.json",
      note: "The extraction output a good day produces. Every evidence id resolves to a fixture in this directory.",
      content: `${JSON.stringify(VALID_FACTS, null, 2)}\n`,
    },
    {
      path: "model/facts-malformed.json",
      note: "One deliberate defect per item, in order (`FACT_DEFECTS`). Seven are dropped at parse time; item 2 is well-formed and still wrong, which is the memo validator's job.",
      content: `${JSON.stringify(
        FACT_DEFECTS.map((defect) => defect.fact),
        null,
        2,
      )}\n`,
    },
    {
      path: "model/facts-unknown.json",
      note: "TESTING §6: valid JSON where the model found nothing. Every value null, every fact still cited — coverage drops, nothing becomes a zero.",
      content: `${JSON.stringify(UNKNOWN_FACTS, null, 2)}\n`,
    },
    {
      path: "model/not-json.txt",
      note: "The model answered the question instead of filling in the schema. Structured output should make this unreachable; the parse path is not allowed to assume so.",
      content: PROSE_ANSWER,
    },
  ];
}
