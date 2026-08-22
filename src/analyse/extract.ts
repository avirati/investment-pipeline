import { z } from "zod";
import type { Candidate, Fact } from "../contracts/index.js";
import { FACT_SCHEMA_VERSION, FactConfidence, FactValue, parseOrDrop } from "../contracts/index.js";
import type { LlmCache, LlmUsage } from "../llm/cache.js";
import type { PromptId } from "../llm/prompt.js";
import { loadPrompt, PROMPTS } from "../llm/prompt.js";
import type { LlmModel } from "../llm/provider.js";
import { callModel, LlmCallError } from "../llm/provider.js";
import type { Bundle, BundleItem } from "./gather.js";
import { bundleItems, usableEvidence } from "./gather.js";
import { FactKeyEnum, renderKeys } from "./keys.js";

/**
 * Stage 2b — fact extraction (TICKET-0020). ARCHITECTURE §1's second and last
 * LLM boundary, and the only one whose output reaches an artifact: *evidence
 * bundle → facts, each bound to an evidence id.*
 *
 * Everything here is built around one asymmetry. A widening mistake in stage 1
 * costs a wasted fetch; a narrowing mistake here puts a sentence a partner
 * believes, with a citation beside it, in front of them. So the model is given
 * a closed world, a closed vocabulary and one job, and every route by which
 * something unchecked could leave this module is shut at the boundary rather
 * than argued with downstream.
 *
 * Five rules:
 *
 * 1. **The closed world is what was *shown*, not what was fetched.**
 *    `bundleIds` includes `fetch_failed` records — a page that 404'd is
 *    evidence of absence and the memo may cite it (ARCHITECTURE §5). It is not
 *    something to extract facts *from*, so it is not rendered, and an id the
 *    model was never shown is rejected exactly like an invented one. Rendering
 *    and validation therefore read one function, `shownItems`, and never two
 *    lists that could drift.
 *
 * 2. **Dropping is per fact, and it is recorded.** One malformed fact must not
 *    cost the other seven, so the schema handed to the provider is permissive
 *    at the item level and the strict one is applied here, item by item,
 *    through `parseOrDrop` (ADR-0003, TICKET-0005). Every drop keeps its index,
 *    its key and the reason, because a run where the model produced twelve
 *    facts and eleven were thrown away is a run a reviewer has to be able to
 *    see. Nothing is repaired: a fact with a bad citation is not a fact with
 *    its citation removed.
 *
 * 3. **Facts only.** No score, no call, no ranking, no prose beyond the
 *    statement itself. If a field ever appears in `ExtractResult` that the
 *    rubric would not have to compute for itself, the invariant is broken
 *    (CLAUDE.md invariant 1, ADR-0002).
 *
 * 4. **A bad answer degrades the candidate, never the run.** Invalid structure
 *    is retried once with the parse error appended, then the candidate is
 *    `partial` with zero facts and the run continues (ARCHITECTURE §5). A
 *    bundle with nothing readable in it does not call the model at all — it is
 *    `no_evidence`, which costs nothing and is not a failure.
 *
 * 5. **Evidence text is data, never instruction.** Records are fenced with a
 *    marker that is neutralised if the fetched page contains it. `prompt.ts`
 *    already refuses to re-scan a substituted value for placeholders; this is
 *    the same concern one layer up, and the text comes off the open internet.
 *
 * Size is bounded by construction: `EVIDENCE_TEXT_LIMIT` is 8 KB a record
 * (`src/evidence/store.ts`) and a bundle holds at most one HN thread, four site
 * pages and five GitHub payloads, so the worst prompt is ~80 KB of evidence.
 * There is deliberately no second truncation here — a record the model sees
 * half of is a record it can misquote, and the one cut should stay where the
 * store's is.
 *
 * Not here: writing anything to disk, and looping over a run. Stage 2's wiring
 * is TICKET-0022; this module takes one bundle and answers about it.
 */

/* -------------------------------------------------------------------------- */
/* The output surface                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Version of the *response* schema, in the cache key (CLAUDE.md invariant 6).
 *
 * The key vocabulary is not versioned separately: `renderKeys()` is
 * interpolated into the rendered prompt, which is hashed whole, so adding or
 * rewording a key moves every cache key on its own. Bump this when the response
 * *shape* changes — including removing a key, which can make a stored answer
 * fail to parse rather than simply miss.
 */
export const EXTRACTION_SCHEMA_VERSION = 1;

/**
 * What the provider is asked for. Permissive on purpose (rule 2): every field
 * is optional, so a single defective fact arrives to be dropped here with a
 * reason instead of failing the whole response and costing a retry. The
 * descriptions are the ask — they reach the provider as the JSON schema's
 * documentation, and the prompt says the same things at length.
 */
const RequestedFact = z
  .object({
    key: z.string().describe("One of the keys listed in the prompt. Anything else is discarded."),
    statement: z.string().describe("One observation, one sentence, true to the record it cites."),
    value: FactValue.describe(
      "The same observation as a scalar — number, boolean, short string or ISO date — or null when it has none.",
    ),
    evidence_ids: z
      .array(z.string())
      .describe("At least one id, each one an id shown in the evidence section."),
    confidence: z.string().describe("high, medium or low — about the evidence, not the company."),
  })
  .partial();

export const ExtractionResponse = z.object({
  facts: z
    .array(RequestedFact)
    .describe("Every fact the evidence supports. An empty list is a valid answer."),
});
export type ExtractionResponse = z.infer<typeof ExtractionResponse>;

/**
 * What a fact must be to survive. Stricter than `Fact` in two ways, both
 * deliberate: `key` is the enumerated vocabulary (`keys.ts`), and
 * `schema_version` — which the model is never asked for — is rejected if
 * present and wrong, so a stored answer from a future contract fails loudly
 * rather than being read as if the fields still meant the same thing.
 */
export const ExtractedFact = z.object({
  schema_version: z.literal(FACT_SCHEMA_VERSION).optional(),
  key: FactKeyEnum,
  statement: z.string().min(1),
  value: FactValue,
  evidence_ids: z.array(z.string().min(1)).min(1),
  confidence: FactConfidence,
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

/** Why a fact did not become a `Fact`. Both kinds are the model's error. */
export type DropKind =
  /** Failed `ExtractedFact` — uncited, unkeyed, unranked, or not a scalar. */
  | "schema"
  /** Cited an id that was not in the evidence it was shown. Rule 1. */
  | "unknown_evidence_id";

export interface DroppedFact {
  /** Index in the response's `facts` array, so a reviewer can point at it. */
  index: number;
  kind: DropKind;
  /** The key it claimed, when it claimed one a reader would recognise. */
  key: string | null;
  reason: string;
}

/**
 * One call that came back. A call whose answer could not be read is **not**
 * here: `callModel` throws before it can report a digest or a token count, so
 * there is nothing truthful to record beyond that it happened — which is what
 * `attempts` says. Two at most; the retry is the second.
 */
export interface ExtractCall {
  attempt: number;
  /** The cache digest, so a manifest entry can point at the file. */
  key: string;
  from_cache: boolean;
  usage: LlmUsage;
}

export type ExtractStatus =
  /** The model answered with a readable structure. Facts may still be zero. */
  | "ok"
  /** Two unreadable answers. Zero facts, the run continues (ARCHITECTURE §5). */
  | "partial"
  /** Nothing readable in the bundle. The model was never called. */
  | "no_evidence";

export interface ExtractResult {
  slug: string;
  status: ExtractStatus;
  facts: Fact[];
  dropped: DroppedFact[];
  /** The closed world this candidate's facts were checked against. */
  shown_ids: string[];
  /**
   * How many times the model was asked — 0, 1 or 2. Larger than `calls.length`
   * when an attempt failed, which is the only place a failed attempt's cost is
   * visible at all.
   */
  attempts: number;
  calls: ExtractCall[];
  /** Set only when `status` is not `ok`. The reason, for the manifest. */
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Rendering the prompt                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The records the model is shown, and therefore the ids it may cite (rule 1).
 * `usableEvidence` owns the definition of "carries something to read"; the
 * empty-text guard is this module's, because a record with no text is a record
 * about which nothing can be said.
 */
export function shownItems(bundle: Bundle): BundleItem[] {
  const usable = new Set(usableEvidence(bundle).map((record) => record.id));
  return bundleItems(bundle).filter((item) => usable.has(item.id) && item.text.trim().length > 0);
}

const RECORD_MARKER = /^---\s*(BEGIN|END) RECORD\b/gm;

/**
 * Rule 5. A page that writes our fence into its own text would otherwise be
 * able to close a record early and address the model outside it. One space in
 * front is enough to break the anchor and keeps the text legible.
 */
function neutraliseMarkers(text: string): string {
  return text.replace(RECORD_MARKER, (match) => ` ${match}`);
}

/**
 * One record, fenced. **The id is the only handle** — no `E1`-style second
 * label, because a model given two names for a record will cite the wrong one
 * and the citation would then have to be translated back, which is one more
 * place to be wrong.
 */
function renderItem(item: BundleItem): string {
  const head = [
    `id: ${item.id}`,
    `url: ${item.url}`,
    `type: ${item.type}`,
    `title: ${item.title ?? "unknown"}`,
    `retrieved_at: ${item.retrieved_at}`,
  ].join("\n");
  return [
    `--- BEGIN RECORD ${item.id} ---`,
    head,
    "",
    neutraliseMarkers(item.text),
    `--- END RECORD ${item.id} ---`,
  ].join("\n");
}

/** The `{{evidence}}` block: every shown record, in the order it was gathered. */
export function renderEvidence(items: readonly BundleItem[]): string {
  return items.map(renderItem).join("\n\n");
}

/**
 * The `{{company}}` block. Deliberately thin: a name, where it lives, and how
 * we found it. Everything else the model is allowed to know is in the records
 * — a one-liner lifted from an HN title is not a source, and a model shown it
 * outside a record can repeat it as a fact with nothing behind it.
 */
export function renderCompany(candidate: Candidate): string {
  const primary = candidate.provenance[0];
  const one = candidate.one_liner.trim();
  return [
    `name: ${candidate.name}`,
    `url: ${candidate.url}`,
    `one_liner: ${one.length > 0 ? one : "unknown"}`,
    `found_via: ${primary.source} — ${primary.title ?? "no title"}` +
      `${primary.posted_at === null ? "" : ` (posted ${primary.posted_at})`}`,
  ].join("\n");
}

/** The rendered prompt, exactly as it is hashed into the cache key. */
export function renderExtractInput(bundle: Bundle, prompt: PromptId, dir?: string): string {
  return loadPrompt(prompt, dir).render({
    company: renderCompany(bundle.candidate),
    keys: renderKeys(),
    evidence: renderEvidence(shownItems(bundle)),
  });
}

/**
 * The second attempt (ARCHITECTURE §5). Appended rather than replacing the
 * prompt, so the model still has the evidence in front of it — and the input
 * differs, so the retry takes its own cache key and a committed run replays
 * both attempts as they happened.
 */
export function retryInput(input: string, complaint: string): string {
  return [
    input,
    "---",
    `The previous answer could not be read: ${complaint}`,
    "",
    "Answer again, same content, as one object with a `facts` array. Each fact " +
      "carries `key`, `statement`, `value`, `evidence_ids` and `confidence`, and " +
      "nothing outside those fields. No text before or after the object.",
  ].join("\n\n");
}

/* -------------------------------------------------------------------------- */
/* Reading the answer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The response's facts, checked twice: against `ExtractedFact`, then against
 * the ids that were actually shown.
 *
 * A fact citing one good id and one phantom is **dropped whole**, not trimmed
 * to the good one. The statement was written from what the model believed it
 * had read, and a citation list we edited is a citation a reviewer would open
 * and find does not support the sentence.
 */
export function parseFacts(
  items: readonly unknown[],
  shownIds: ReadonlySet<string>,
): { facts: Fact[]; dropped: DroppedFact[] } {
  const { kept, dropped } = parseOrDrop(ExtractedFact, items);

  const claimedKey = (index: number): string | null => {
    const item = items[index];
    if (typeof item !== "object" || item === null) return null;
    const key = (item as { key?: unknown }).key;
    return typeof key === "string" && key.length > 0 ? key : null;
  };

  const out: { facts: Fact[]; dropped: DroppedFact[] } = {
    facts: [],
    dropped: dropped.map((entry) => ({
      index: entry.index,
      kind: "schema" as const,
      key: claimedKey(entry.index),
      reason: entry.reason,
    })),
  };

  // `parseOrDrop` reports the index of the item it was given, and the kept
  // items arrive in that same order, so walking the input once keeps every
  // index meaningful without threading one through the contracts layer.
  let cursor = 0;
  items.forEach((_item, index) => {
    const wasDropped = dropped.some((entry) => entry.index === index);
    if (wasDropped) return;
    const fact = kept[cursor++] as ExtractedFact;
    const unknown = fact.evidence_ids.filter((id) => !shownIds.has(id));
    if (unknown.length > 0) {
      out.dropped.push({
        index,
        kind: "unknown_evidence_id",
        key: fact.key,
        reason:
          `cites ${unknown.map((id) => `'${id}'`).join(", ")}, which ` +
          `${unknown.length === 1 ? "was" : "were"} not in the evidence shown ` +
          `(${shownIds.size} record${shownIds.size === 1 ? "" : "s"})`,
      });
      return;
    }
    out.facts.push({
      schema_version: FACT_SCHEMA_VERSION,
      key: fact.key,
      statement: fact.statement,
      value: fact.value,
      evidence_ids: fact.evidence_ids,
      confidence: fact.confidence,
    });
  });

  out.dropped.sort((a, b) => a.index - b.index);
  return out;
}

/* -------------------------------------------------------------------------- */
/* The call                                                                    */
/* -------------------------------------------------------------------------- */

export interface ExtractOptions {
  /** Built by the caller — `createModel("extract")` reads the environment. */
  model: LlmModel;
  cache?: LlmCache;
  /** `--replay`: answer from the committed cache or fail. Never calls a provider. */
  replay?: boolean;
  /** Defaults to `PROMPTS.extract`. Present so a v2 can be tried without an edit here. */
  prompt?: PromptId;
  /** Prompt directory override. Tests only; callers in `src/` never pass it. */
  promptDir?: string;
  now?: () => Date;
}

/** What `withStructuredOutput` names the shape it asks for. A word about the shape. */
const OUTPUT_NAME = "facts";

/**
 * A shape complaint, if this failure is one. Only a shape complaint is worth
 * appending to the retry — telling a model that a socket closed teaches it
 * nothing, and it would go into the committed prompt of the second attempt.
 */
function structureComplaint(error: unknown): string | null {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  const message = error instanceof Error ? error.message : String(error);
  return /parse|schema|json|invalid|expected/i.test(message) ? message : null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Read one bundle into facts.
 *
 * Best-effort in the same sense the two adapters are: the return value has the
 * same shape whether the model answered well, badly, or was never called, and
 * the difference is in `status`, `dropped` and `error` rather than in a throw.
 * The two things that *do* throw are the operator's, not the candidate's — a
 * cold cache under `--replay` and a stale cache entry both mean the run should
 * stop and be re-issued, so `LlmCallError` passes straight through.
 */
export async function extractFacts(
  bundle: Bundle,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const items = shownItems(bundle);
  const shownIds = new Set(items.map((item) => item.id));
  const base: Omit<ExtractResult, "status" | "error"> = {
    slug: bundle.slug,
    facts: [],
    dropped: [],
    shown_ids: [...shownIds],
    attempts: 0,
    calls: [],
  };

  if (items.length === 0) {
    // Rule 4. Every record failed, or every one was empty. Asking a model to
    // extract facts from nothing spends tokens to be told nothing, and the
    // honest output is the low-coverage analysis this already implies.
    return {
      ...base,
      status: "no_evidence",
      error: `no readable evidence: ${bundle.evidence.length} record(s) gathered, none with text`,
    };
  }

  const promptId = options.prompt ?? PROMPTS.extract;
  const prompt = loadPrompt(promptId, options.promptDir);
  const input = prompt.render({
    company: renderCompany(bundle.candidate),
    keys: renderKeys(),
    evidence: renderEvidence(items),
  });

  const attempt = async (text: string, number: number) => {
    base.attempts = number;
    const reply = await callModel<ExtractionResponse>({
      model: options.model,
      prompt: prompt.ref,
      schema: ExtractionResponse,
      schema_version: String(EXTRACTION_SCHEMA_VERSION),
      input: text,
      name: OUTPUT_NAME,
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      ...(options.now ? { now: options.now } : {}),
    });
    base.calls.push({
      attempt: number,
      key: reply.key,
      from_cache: reply.from_cache,
      usage: reply.usage,
    });
    return reply.value;
  };

  let response: ExtractionResponse;
  try {
    response = await attempt(input, 1);
  } catch (first) {
    if (first instanceof LlmCallError) throw first;
    const complaint = structureComplaint(first);
    try {
      response = await attempt(complaint === null ? input : retryInput(input, complaint), 2);
    } catch (second) {
      if (second instanceof LlmCallError) throw second;
      // ARCHITECTURE §5: mark the candidate partial and continue. No facts, and
      // both failures named — one bad candidate does not cost the run.
      return {
        ...base,
        status: "partial",
        error:
          `the model returned no readable answer in two attempts: ` +
          `${messageOf(first)} / then ${messageOf(second)}`,
      };
    }
  }

  const { facts, dropped } = parseFacts(response.facts, shownIds);
  return { ...base, facts, dropped, status: "ok", error: null };
}
