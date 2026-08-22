import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_ID_LENGTH,
  EVIDENCE_ID_PATTERN,
  EVIDENCE_SCHEMA_VERSION,
  Evidence,
  type EvidenceType,
} from "../contracts/index.js";
import { RUNS_ROOT } from "../run.js";

/**
 * The evidence store (TICKET-0007, ADR-0003). Retrieval writes one JSON record
 * per fetch; extraction may only cite ids that came from here; the memo
 * validator hard-fails on an id with no file behind it. The citation guarantee
 * is this module and nothing else, so three rules hold:
 *
 * 1. **An id is produced in exactly one place.** `evidenceId` is the only
 *    definition of `sha256(url + retrieved_at)`. `write` recomputes it and
 *    refuses a record whose id does not match its own url and timestamp — a
 *    content-addressed store that trusts the caller's address is not one.
 *
 * 2. **Ids arriving from outside are untrusted.** The validator resolves ids
 *    that appeared in model output, so `read` never joins a path it has not
 *    first checked against `EVIDENCE_ID_PATTERN`.
 *
 * 3. **Truncation is recorded, not silent.** ADR-0003 names bundle length as
 *    the known cost of closed-world citation, so text is cut to one constant
 *    and both the cut and the original length are written into `meta`.
 */

/**
 * Run artifacts live under `runs/<run_id>/` (ARCHITECTURE §4). Defined in
 * `src/run.ts`, which owns the run layout, and re-exported here so this
 * module's existing callers keep one import. Note the two spellings of `root`:
 * `evidenceStore(id, root)` takes the *runs* root, `runPaths(id, root)` takes
 * the repo root.
 */
export { RUNS_ROOT };

/**
 * Per-record text budget. One constant because ADR-0003 identifies bundle
 * length as the cost of showing the model only what was retrieved: an
 * extraction bundle is roughly this times the number of records. It is a guess
 * — ~2k tokens of prose per record — and stays one until a real bundle
 * contradicts it.
 */
export const EVIDENCE_TEXT_LIMIT = 8_000;

/**
 * Written into the text itself rather than only into `meta`, because the model
 * reads the text and not the metadata: a fact drawn from a cut-off page should
 * be visibly drawn from a cut-off page. Counted against the limit, so
 * `text.length <= EVIDENCE_TEXT_LIMIT` always holds.
 */
export const TRUNCATION_MARKER = "\n… [truncated]";

/**
 * `sha256(url + retrieved_at)`, truncated to `EVIDENCE_ID_LENGTH` (ADR-0003).
 *
 * The two inputs are concatenated without a separator, exactly as the ADR
 * writes it. That is only unambiguous because `retrieved_at` is a fixed-width
 * ISO datetime validated by the contract, so the boundary is never in doubt.
 */
export function evidenceId(url: string, retrievedAt: string): string {
  return createHash("sha256")
    .update(url + retrievedAt)
    .digest("hex")
    .slice(0, EVIDENCE_ID_LENGTH);
}

export interface Truncation {
  text: string;
  truncated: boolean;
  original_length: number;
}

/** Cut to `EVIDENCE_TEXT_LIMIT`, marker included in the budget. */
export function truncateText(text: string, limit = EVIDENCE_TEXT_LIMIT): Truncation {
  if (text.length <= limit) return { text, truncated: false, original_length: text.length };
  const room = Math.max(0, limit - TRUNCATION_MARKER.length);
  // The marker is cut too, so a limit smaller than the marker still holds.
  return {
    text: text.slice(0, room) + TRUNCATION_MARKER.slice(0, limit),
    truncated: true,
    original_length: text.length,
  };
}

export interface EvidenceInput {
  url: string;
  type: EvidenceType;
  retrieved_at: string;
  /** HTTP status, or 0 when the request never got one. */
  status: number;
  /** Required, not optional: a record with no title says `null` (invariant 4). */
  title: string | null;
  /** On `fetch_failed`, the reason. Truncated here. */
  text: string;
  /** Adapter extras — stars, points, objectID. The store's own keys win. */
  meta?: Record<string, unknown>;
}

/**
 * Build a valid record: id computed, text cut, truncation recorded. The only
 * constructor — an adapter never assembles an `Evidence` literal, so it cannot
 * skip the id helper or the limit.
 */
export function makeEvidence(input: EvidenceInput): Evidence {
  const cut = truncateText(input.text);
  return Evidence.parse({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: evidenceId(input.url, input.retrieved_at),
    url: input.url,
    type: input.type,
    retrieved_at: input.retrieved_at,
    status: input.status,
    title: input.title,
    text: cut.text,
    meta: {
      ...input.meta,
      text_truncated: cut.truncated,
      text_original_length: cut.original_length,
    },
  });
}

export interface WriteResult {
  path: string;
  /** False when the record was already on disk — a repeat write is a no-op. */
  written: boolean;
}

/** Why an id did not resolve. The validator reports these; it never guesses. */
export type EvidenceMiss =
  /** No file, or an id that could not name one. Nothing was read. */
  | "not_found"
  /** The file exists and could not be opened. An environment problem. */
  | "unreadable"
  /** The file exists and is not an evidence record. A correctness problem. */
  | "invalid";

export type EvidenceRead =
  | { ok: true; evidence: Evidence }
  | { ok: false; miss: EvidenceMiss; detail: string };

export interface EvidenceStore {
  readonly run_id: string;
  readonly dir: string;
  /** Throws on a malformed id — callers with an untrusted id use `read`. */
  path(id: string): string;
  write(evidence: Evidence): WriteResult;
  read(id: string): EvidenceRead;
}

function isEvidenceId(id: string): boolean {
  return EVIDENCE_ID_PATTERN.test(id);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Open the store for one run. Nothing is created until the first `write`. */
export function evidenceStore(runId: string, root = RUNS_ROOT): EvidenceStore {
  const dir = join(root, runId, "evidence");

  const path = (id: string): string => {
    if (!isEvidenceId(id)) throw new Error(`not an evidence id: '${id}'`);
    return join(dir, `${id}.json`);
  };

  const write = (evidence: Evidence): WriteResult => {
    const expected = evidenceId(evidence.url, evidence.retrieved_at);
    if (evidence.id !== expected) {
      throw new Error(
        `evidence id '${evidence.id}' does not address its own content — ` +
          `sha256(url + retrieved_at) is '${expected}'. Build records with makeEvidence.`,
      );
    }

    const file = path(evidence.id);
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    mkdirSync(dir, { recursive: true });

    // The id addresses the content, so a record already on disk is the same
    // record: rewriting it can only turn a good file into a torn one.
    try {
      writeFileSync(file, body, { flag: "wx" });
      return { path: file, written: true };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return { path: file, written: false };
    }
  };

  const read = (id: string): EvidenceRead => {
    // Ids reaching here came from model output via the memo validator, so this
    // check is what keeps `../` out of the join, not a formatting nicety.
    if (!isEvidenceId(id)) {
      return { ok: false, miss: "not_found", detail: `'${id}' is not a 16-character hex id` };
    }

    const file = join(dir, `${id}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { ok: false, miss: "not_found", detail: `no file at ${file}` };
      return { ok: false, miss: "unreadable", detail: `${file}: ${code ?? String(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, miss: "invalid", detail: `${file}: ${(error as Error).message}` };
    }

    const result = Evidence.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, miss: "invalid", detail: `${file}: ${issues}` };
    }
    if (result.data.id !== id) {
      return { ok: false, miss: "invalid", detail: `${file}: holds id '${result.data.id}'` };
    }
    return { ok: true, evidence: result.data };
  };

  return { run_id: runId, dir, path, write, read };
}
