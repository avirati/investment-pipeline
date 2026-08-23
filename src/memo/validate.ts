import type { Analysis, Memo } from "../contracts/index.js";
import type { EvidenceMiss, EvidenceRead } from "../evidence/store.js";
import { EXIT } from "../exit-codes.js";

/**
 * The memo validator (TICKET-0025, ADR-0003). The enforcement end of the
 * citation guarantee.
 *
 * Everything else in this pipeline makes inventing a source *hard*: the model
 * may only cite ids from the bundle it was shown, a fact without ids is dropped
 * at parse time, and the renderer writes an id it cannot resolve as `unknown`
 * rather than dropping the row. This module is what makes inventing a source
 * *fatal*, and it is the only **hard fail** in the whole pipeline — everywhere
 * else missing data lowers coverage (CLAUDE.md invariant 4), because the world
 * being thin is not a bug. A memo citing a record that does not exist is.
 *
 * ## Why it reads the markdown rather than the `Memo`
 *
 * `Memo.citations` is the renderer's own account of what it cited. Checking it
 * would test the renderer against itself: a template that drops a sources row,
 * or a label that never reaches a bullet, leaves `citations` untouched and the
 * memo unciteable. So the ids and the labels are parsed back out of the
 * rendered markdown — the artifact a reader actually gets — and `citations` is
 * then checked *against* that as one more thing that can disagree.
 *
 * ## What it checks
 *
 * 1. **Every id in the sources table resolves on disk.** Not found, unreadable
 *    and not-a-record are three different causes and get three different
 *    messages: an id nobody wrote is a citation bug, a file that will not open
 *    is an environment problem, and a file that is not an evidence record is a
 *    store that has been written to by something else.
 * 2. **The table and the body agree.** Every label a bullet cites has a row,
 *    and every row is cited by a bullet. A row nobody cites reads as a source
 *    somebody used; a label with no row is a citation a reader cannot follow.
 * 3. **The header's score is the sum of the dimensions** (SPEC §4 hard rule 3),
 *    checked against the analysis JSON rather than against itself. A rendering
 *    that disagrees with its own source data is the same class of bug as a
 *    citation that does not resolve, so it fails the same way.
 *
 * ## What it does not check
 *
 * Whether the *right* records were cited, whether a bullet's text is supported
 * by the record behind it, or whether the call is defensible. Those need a
 * reader. This checks that everything the memo points at exists and that the
 * memo agrees with itself, which is the part a machine can be certain about.
 */

/* -------------------------------------------------------------------------- */
/* What can be wrong                                                           */
/* -------------------------------------------------------------------------- */

export type MemoProblemKind =
  /** An id in the sources table with no readable record behind it. */
  | "unresolved_citation"
  /** A bullet cites a label the sources table does not explain. */
  | "missing_source_row"
  /** The sources table carries a row no bullet cites. */
  | "orphan_source_row"
  /** `Memo.citations` disagrees with the table the memo actually printed. */
  | "citation_list_mismatch"
  /** The header's score is not the sum of the analysis's dimensions. */
  | "score_mismatch"
  /** The header could not be read, so its score could not be checked. */
  | "unreadable_header";

export interface MemoProblem {
  kind: MemoProblemKind;
  /** The evidence id or label this is about; `null` when it is about neither. */
  subject: string | null;
  /** Why an id did not resolve. Set only on `unresolved_citation`. */
  miss?: EvidenceMiss;
  /** One line, naming the memo and the subject. Read by an operator. */
  message: string;
}

/** A citation as the memo printed it: a memo-local label and the id beside it. */
export interface MemoCitation {
  label: string;
  id: string;
}

export interface MemoValidation {
  ok: boolean;
  /** What the messages call this memo — a slug, or the path stage 3 wrote. */
  memo: string;
  /** The sources table, in printed order. */
  citations: MemoCitation[];
  /** How many of them resolved to a readable record. */
  resolved: number;
  problems: MemoProblem[];
}

/**
 * The only thing this module needs from the evidence store, so a caller can
 * hand it the run's store and a test can hand it a map. `EvidenceStore`
 * satisfies it structurally.
 */
export interface EvidenceReader {
  read(id: string): EvidenceRead;
}

/* -------------------------------------------------------------------------- */
/* Reading a rendered memo back                                                */
/* -------------------------------------------------------------------------- */

/**
 * A sources row: `| E1 (`a1b2c3d4e5f60001`) | url | retrieved | type |`.
 *
 * The id is captured as whatever sits between the backticks rather than as
 * sixteen hex characters, so a malformed id is reported as a citation that does
 * not resolve — which is what it is — instead of being skipped by the regex and
 * silently disappearing. `store.read` is what judges the shape (rule 2 there).
 */
const SOURCE_ROW = /^\|\s*(\S+)\s+\(`([^`]*)`\)\s*\|/;

/**
 * A citation in a bullet: `[E1]`, or `[a1b2c3d4e5f60001]` when the renderer
 * could not label an id. Anything else in brackets — a markdown link, a bracket
 * inside a quoted statement — is not a citation and is left alone.
 */
const BODY_CITATION = /\[(E\d+|[0-9a-f]{16})\]/g;

/** `# Acme Traces — WATCH · score 69/100 · coverage 100%` */
const HEADER_SCORE = /^#\s.*·\s*score\s+(\d+)\/100\b/;

/** The sources table's rows, in printed order, one entry per row. */
export function parseSourceRows(markdown: string): MemoCitation[] {
  const rows: MemoCitation[] = [];
  for (const line of markdown.split("\n")) {
    const match = SOURCE_ROW.exec(line);
    if (match) rows.push({ label: match[1] as string, id: match[2] as string });
  }
  return rows;
}

/**
 * Every label the body cites, in first-cited order.
 *
 * Table rows are skipped: a row is where a label is *explained*, not where it
 * is used, and counting it would make every row cite itself — which would turn
 * the orphan check into a tautology.
 */
export function parseBodyCitations(markdown: string): string[] {
  const labels: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("|")) continue;
    for (const match of line.matchAll(BODY_CITATION)) {
      const label = match[1] as string;
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

/** The score the header printed, or `null` when the header could not be read. */
export function parseHeaderScore(markdown: string): number | null {
  const first = markdown.split("\n", 1)[0] ?? "";
  const match = HEADER_SCORE.exec(first);
  return match ? Number(match[1]) : null;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** Why an id did not resolve, as a sentence an operator can act on. */
function missReason(miss: EvidenceMiss): string {
  switch (miss) {
    case "not_found":
      return "no record with that id was written by this run";
    case "unreadable":
      return "the record is on disk and could not be opened";
    case "invalid":
      return "the file at that id is not an evidence record";
  }
}

export interface ValidateOptions {
  /** What to call this memo in messages. Defaults to `<slug>.md`. */
  name?: string;
}

/**
 * Check one rendered memo against the run's evidence store and its own
 * analysis. Pure: it reads through the reader it is given and nothing else, so
 * it never touches the network and never needs a key.
 */
export function validateMemo(
  memo: Memo,
  analysis: Analysis,
  store: EvidenceReader,
  options: ValidateOptions = {},
): MemoValidation {
  const name = options.name ?? `${analysis.candidate.slug}.md`;
  const problems: MemoProblem[] = [];
  const add = (problem: MemoProblem): void => {
    problems.push(problem);
  };

  const citations = parseSourceRows(memo.markdown);
  const cited = parseBodyCitations(memo.markdown);

  /* 1 — every id in the table resolves. */
  let resolved = 0;
  for (const citation of citations) {
    const read = store.read(citation.id);
    if (read.ok) {
      resolved += 1;
      continue;
    }
    add({
      kind: "unresolved_citation",
      subject: citation.id,
      miss: read.miss,
      message:
        `${name}: ${citation.label} cites evidence '${citation.id}', which does not ` +
        `resolve — ${missReason(read.miss)} (${read.detail})`,
    });
  }

  /* 2 — the table and the body agree, in both directions. */
  const labels = new Set(citations.map((citation) => citation.label));
  for (const label of cited) {
    if (labels.has(label)) continue;
    add({
      kind: "missing_source_row",
      subject: label,
      message: `${name}: a bullet cites ${label} and the sources table has no row for it`,
    });
  }
  for (const citation of citations) {
    if (cited.includes(citation.label)) continue;
    add({
      kind: "orphan_source_row",
      subject: citation.id,
      message:
        `${name}: the sources table lists ${citation.label} (${citation.id}) and no ` +
        `bullet cites it — a source row nobody cites reads as a source somebody used`,
    });
  }

  /* 2b — and the memo's own citation list agrees with the table it printed. */
  const printed = citations.map((citation) => citation.id);
  if (memo.citations.join("\n") !== printed.join("\n")) {
    add({
      kind: "citation_list_mismatch",
      subject: null,
      message:
        `${name}: Memo.citations is [${memo.citations.join(", ")}] and the rendered ` +
        `sources table is [${printed.join(", ")}]`,
    });
  }

  /* 3 — the header's score is the analysis's own arithmetic. */
  const sum = analysis.dimensions.reduce((total, dimension) => total + dimension.score, 0);
  if (analysis.score !== sum) {
    add({
      kind: "score_mismatch",
      subject: null,
      message:
        `${name}: the analysis records score ${analysis.score} and its dimensions ` +
        `sum to ${sum} (SPEC §4 hard rule 3)`,
    });
  }
  const header = parseHeaderScore(memo.markdown);
  if (header === null) {
    add({
      kind: "unreadable_header",
      subject: null,
      message: `${name}: no 'score <n>/100' in the first line, so the score cannot be checked`,
    });
  } else if (header !== sum) {
    add({
      kind: "score_mismatch",
      subject: null,
      message:
        `${name}: the header prints score ${header} and the analysis's dimensions ` +
        `sum to ${sum} (SPEC §4 hard rule 3)`,
    });
  }

  return { ok: problems.length === 0, memo: name, citations, resolved, problems };
}

/* -------------------------------------------------------------------------- */
/* Failing the run                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A failed validation. Carries its own exit code because ARCHITECTURE §5 gives
 * this failure a different one from everything else in stage 3: `EXIT.INVARIANT`
 * says *this code is wrong*, not *the world was thin*, and an operator reading
 * a 3 should file a bug rather than widen a seed.
 */
export class MemoValidationError extends Error {
  readonly exit = EXIT.INVARIANT;
  readonly problems: MemoProblem[];
  /** Which memos failed, so a multi-memo run names all of them at once. */
  readonly memos: string[];

  constructor(results: readonly MemoValidation[]) {
    const failed = results.filter((result) => !result.ok);
    const problems = failed.flatMap((result) => result.problems);
    super(
      `${problems.length} citation or arithmetic problem(s) in ${failed.length} memo(s):\n` +
        problems.map((problem) => `  - ${problem.message}`).join("\n"),
    );
    this.name = "MemoValidationError";
    this.problems = problems;
    this.memos = failed.map((result) => result.memo);
  }
}

/**
 * Validate and abort. Stage 3's wiring calls this; a run with a bad citation in
 * it stops here rather than writing a memo a reader would trust.
 *
 * Takes the whole set rather than one memo so that a run with three bad memos
 * reports three, once. Fixing them one exit code at a time is not a workflow.
 */
export function assertMemosValid(results: readonly MemoValidation[]): void {
  if (results.some((result) => !result.ok)) throw new MemoValidationError(results);
}
