import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import type { Analysis, Evidence, Memo } from "../contracts/index.js";
import { MEMO_SCHEMA_VERSION, Memo as MemoSchema } from "../contracts/index.js";

/**
 * Stage 3's renderer (TICKET-0024, D-2). `Analysis` in, markdown out.
 *
 * **There is no LLM call in this file and there is no decision in it either**
 * (CLAUDE.md invariant 3). Which sections exist, which bullets survived the
 * caps, which dimension decided the call, what would upgrade a Watch — all of
 * it is on the `Analysis` already, computed by `src/analyse/derive.ts`. What is
 * left here is genuinely presentation, and it is four things:
 *
 * 1. **Labels.** An evidence id is sixteen hex characters, which is unreadable
 *    inline. Each id cited by this memo gets a memo-local label — `E1`, `E2`,
 *    in first-cited order — and the sources table carries the label *and* the
 *    id, so a reader can go from a bullet to the record on disk without a
 *    lookup table in their head. The labels are per memo and mean nothing
 *    outside one.
 * 2. **The sources table**, in first-cited order, one row per record.
 * 3. **Formatting numbers**: coverage as a percentage, a retrieval timestamp as
 *    it was stored.
 * 4. **`Memo.citations`** — the flat list of every id the markdown cites, which
 *    is what `src/memo/validate.ts` (TICKET-0025) resolves against the run's
 *    evidence store.
 *
 * ## Two rules
 *
 * **A record this renderer cannot find is written as unknown, not dropped.**
 * An id that resolves to nothing still gets a label, still appears in the
 * sources table, and its url, timestamp and type read `unknown`. Silently
 * dropping the row would produce a memo that looks complete and cites a record
 * nobody can check; the memo validator is what turns that into a failed run
 * (ADR-0003), and it can only do that if the id is still visible here.
 *
 * **A `fetch_failed` record is a legitimate source.** It is evidence that we
 * looked and could not read — *we did not look* is a different claim, and both
 * belong in a memo rather than in a silence (ARCHITECTURE §5).
 */

/* -------------------------------------------------------------------------- */
/* The template                                                                */
/* -------------------------------------------------------------------------- */

export const MEMO_TEMPLATE = "memo.md.eta";

/** `templates/`, resolved from this file rather than from the process's cwd. */
export function templatesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

/**
 * `autoEscape` is off because this is markdown, not HTML: escaping would turn
 * every `&` in a url and every `<` in a statement into an entity, and a memo is
 * read as text. `autoTrim` is off because whitespace in a markdown document is
 * syntax — a blank line is a paragraph break, and letting a template engine
 * decide where those go is how a heading ends up glued to a bullet.
 */
function engine(dir: string): Eta {
  return new Eta({ views: dir, autoEscape: false, autoTrim: false, rmWhitespace: false });
}

/* -------------------------------------------------------------------------- */
/* Citations                                                                   */
/* -------------------------------------------------------------------------- */

export interface Source {
  /** `E1`, `E2` — memo-local, in first-cited order. Meaningless across memos. */
  label: string;
  /** The evidence id itself, so a bullet leads to a file on disk. */
  id: string;
  url: string;
  retrieved: string;
  type: string;
}

/** Every id this analysis cites, once, in the order the memo will print them. */
export function citedIds(analysis: Analysis): string[] {
  const ids: string[] = [];
  const push = (list: readonly string[]): void => {
    for (const id of list) if (!ids.includes(id)) ids.push(id);
  };

  for (const bullet of analysis.why_this_call) push(bullet.evidence_ids);
  for (const section of analysis.sections) {
    for (const bullet of section.bullets) push(bullet.evidence_ids);
  }
  for (const bullet of analysis.what_would_change_my_mind) push(bullet.evidence_ids);
  return ids;
}

/**
 * The sources table. An id with no record still gets a row — see rule 1 in the
 * module header; the memo validator is what fails the run, and it needs the id
 * to still be visible in order to do it.
 */
export function sourcesOf(analysis: Analysis, evidence: readonly Evidence[]): Source[] {
  const byId = new Map(evidence.map((record) => [record.id, record]));
  return citedIds(analysis).map((id, index) => {
    const record = byId.get(id);
    return {
      label: `E${index + 1}`,
      id,
      url: record?.url ?? "unknown",
      retrieved: record?.retrieved_at ?? "unknown",
      type: record?.type ?? "unknown",
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

export interface RenderOptions {
  /** Where `memo.md.eta` lives. Defaults to the repo's `templates/`. */
  templateDir?: string;
  /** Template file name, for a caller rendering a variant. */
  template?: string;
}

/** What the template sees. Kept small and flat — a template is not a program. */
export interface MemoView {
  analysis: Analysis;
  header: {
    name: string;
    call: string;
    score: number;
    coverage: number;
    url: string;
    /** Empty when stage 1 could not derive one — the template then omits it. */
    one_liner: string;
    /** Stage 2's own sentence about a degraded reading, printed verbatim. */
    status_reason: string | null;
  };
  sources: Source[];
  label: (ids: readonly string[]) => string;
}

export function memoView(analysis: Analysis, evidence: readonly Evidence[]): MemoView {
  const sources = sourcesOf(analysis, evidence);
  const labels = new Map(sources.map((source) => [source.id, source.label]));

  return {
    analysis,
    header: {
      name: analysis.candidate.name,
      call: analysis.call,
      score: analysis.score,
      // A share, printed as a whole percent. The share stays in the JSON.
      coverage: Math.round(analysis.coverage * 100),
      url: analysis.candidate.url,
      one_liner: analysis.candidate.one_liner,
      status_reason: analysis.status_reason,
    },
    sources,
    // An unlabelled id would mean `citedIds` and this disagree, which is a bug
    // rather than a gap — it prints the id so the disagreement is visible.
    label: (ids) => ids.map((id) => `[${labels.get(id) ?? id}]`).join(""),
  };
}

/**
 * Whitespace, normalised: trailing spaces stripped, runs of blank lines
 * collapsed to one, exactly one newline at the end.
 *
 * A markdown template with loops and conditionals in it emits stray blank lines
 * wherever a block ends, and the alternative to normalising them here is `eta`'s
 * `autoTrim` — which decides where paragraph breaks go, and a paragraph break
 * in markdown is syntax rather than whitespace. This is the smaller hammer: the
 * template stays readable, and a stray blank line in it is not a diff in a
 * committed memo.
 */
const tidy = (markdown: string): string =>
  `${markdown
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;

/**
 * One memo. Pure with respect to the world: it reads the template file and
 * nothing else — no network, no model, no clock.
 */
export function renderMemo(
  analysis: Analysis,
  evidence: readonly Evidence[],
  options: RenderOptions = {},
): Memo {
  const dir = options.templateDir ?? templatesDir();
  const name = options.template ?? MEMO_TEMPLATE;
  // Read rather than let eta resolve, so a missing template names the path.
  const template = readFileSync(join(dir, name), "utf8");

  const view = memoView(analysis, evidence);
  const markdown = tidy(engine(dir).renderString(template, view));

  return MemoSchema.parse({
    schema_version: MEMO_SCHEMA_VERSION,
    markdown,
    citations: view.sources.map((source) => source.id),
  });
}
