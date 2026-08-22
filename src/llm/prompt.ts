import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptRef } from "./provider.js";

/**
 * Prompt loading (TICKET-0019). CLAUDE.md: *prompts live in `prompts/` as
 * versioned files with a `CHANGELOG.md` entry per revision. Prompts are not
 * edited inline in TypeScript.* This module is what makes that enforceable
 * rather than aspirational — a prompt reaches a provider by being read off
 * disk, so there is no shape in which a string literal in a stage becomes the
 * thing a model was asked.
 *
 * Four rules:
 *
 * 1. **The filename is the version, and the version is asked for.** There is no
 *    "latest": `loadPrompt` takes an id and a number and reads exactly
 *    `prompts/<id>.v<n>.md`. Cache keys hash that number (CLAUDE.md invariant
 *    6), so a silent bump is a silently stale answer, and an implicit
 *    latest-wins rule is exactly how one happens.
 *
 * 2. **The front matter is checked, not decoration.** `id` and `version` in the
 *    header must match the file that was opened. A v2 copied from a v1 with the
 *    header left behind is the ordinary way this goes wrong, and it produces a
 *    file whose text and whose cache key disagree about which prompt it is.
 *
 * 3. **Interpolation is exact in both directions.** Every `{{placeholder}}` in
 *    the body must be supplied, and every value supplied must be used. A
 *    renamed placeholder that quietly drops the evidence bundle out of an
 *    extraction prompt is a call that costs money and returns nothing citable;
 *    it should fail before the call, loudly, with the name in the message.
 *
 * 4. **Values are inserted, never re-scanned.** A substituted value containing
 *    `{{...}}` is text — evidence text is fetched from the internet and a page
 *    that writes `{{company}}` must not be able to reach into the prompt.
 *
 * Not here: what any particular prompt *says*, and how a bundle becomes the
 * string that fills a placeholder. This module knows about files and braces.
 */

/** A prompt file, addressed the way `callModel` keys it. */
export interface PromptId {
  id: string;
  version: number;
}

/**
 * The versions the pipeline currently renders — one line per prompt file, and
 * the one place to look when asking which revision a run used.
 *
 * A bump is an edit here *and* a new file *and* a `prompts/CHANGELOG.md` entry.
 * Three steps on purpose: with no eval harness in v1 (SCOPE), the changelog is
 * the only record of why a prompt changed, and it is worth nothing written
 * retroactively.
 */
export const PROMPTS = {
  /** Stage 1 query clarification (ADR-0008). Not yet wired — TICKET-0011. */
  clarify_query: { id: "clarify-query", version: 1 },
  /** Stage 2b fact extraction. Rendered by TICKET-0020. */
  extract: { id: "extract", version: 1 },
} as const satisfies Record<string, PromptId>;

/** Where prompt files live, resolved from this module rather than from `cwd`. */
export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** A prompt that could not be loaded or rendered. Never a partial render. */
export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export interface Prompt {
  id: string;
  version: number;
  /** What `callModel` puts in the cache key. Version as a string, as it keys it. */
  ref: PromptRef;
  /** The body, front matter removed. Placeholders still in it. */
  body: string;
  /** Placeholder names, in first appearance order, deduplicated. */
  placeholders: string[];
  /** The declared `inputs:` from the front matter, or null when absent. */
  inputs: string[] | null;
  /** The body with every placeholder replaced. Throws unless the sets match. */
  render(values: Readonly<Record<string, string>>): string;
}

export function promptPath(prompt: PromptId, dir: string = PROMPTS_DIR): string {
  return join(dir, `${prompt.id}.v${prompt.version}.md`);
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Names in `{{braces}}`, first appearance first. */
export function placeholdersIn(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * The front matter block and the body after it. Absent front matter is an
 * error rather than a default: rule 2 has nothing to check without it.
 */
function splitFrontMatter(text: string, path: string): { header: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) {
    throw new PromptError(
      `${path} has no front matter. A prompt file opens with a --- block carrying at ` +
        `least 'id' and 'version'; they are checked against the filename.`,
    );
  }
  return { header: match[1] as string, body: text.slice(match[0].length).trimStart() };
}

/**
 * Three scalar fields off the front matter. **Not a YAML parser** — adding one
 * would be a runtime dependency (CLAUDE.md) for three lines whose shape this
 * repo writes itself. Anything it does not recognise (`purpose: >` blocks,
 * `role:`) is documentation for a human and is left alone.
 */
function headerField(header: string, name: string): string | null {
  const match = new RegExp(`^${name}:[ \\t]*(.+)$`, "m").exec(header);
  return match === null ? null : (match[1] as string).trim();
}

function declaredInputs(header: string, path: string): string[] | null {
  // Absent is allowed; present-but-unparseable is not. A YAML block list
  // (`inputs:` then `  - company`) would otherwise read as absent, which is the
  // one outcome that silently turns the check below off.
  if (!/^inputs:/m.test(header)) return null;
  const raw = headerField(header, "inputs") ?? "";
  const list = /^\[(.*)\]$/.exec(raw);
  if (list === null) {
    throw new PromptError(
      `${path} declares 'inputs: ${raw}'. Write it on one line as a bracketed list, ` +
        `e.g. 'inputs: [company, evidence]' — it is checked against the body's placeholders.`,
    );
  }
  return (list[1] as string)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const sorted = (names: readonly string[]): string => [...names].sort().join(", ") || "(none)";

/**
 * Read `prompts/<id>.v<version>.md`, check its header against its name, and
 * return it ready to render.
 *
 * Read on every call. A prompt file is a few kilobytes and a run makes tens of
 * calls; caching it would buy nothing and would mean a file edited mid-session
 * is not the file being sent.
 *
 * `dir` exists so the loader's own failure paths can be tested against files
 * written for the purpose, rather than by committing broken prompts. Callers
 * in `src/` never pass it.
 */
export function loadPrompt(prompt: PromptId, dir: string = PROMPTS_DIR): Prompt {
  const path = promptPath(prompt, dir);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new PromptError(
      `cannot read prompt ${prompt.id} v${prompt.version} at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { header, body } = splitFrontMatter(text, path);

  const declaredId = headerField(header, "id");
  const declaredVersion = headerField(header, "version");
  if (declaredId !== prompt.id || declaredVersion !== String(prompt.version)) {
    throw new PromptError(
      `${path} declares id '${declaredId ?? "(missing)"}' version ` +
        `'${declaredVersion ?? "(missing)"}', but its filename says '${prompt.id}' v${prompt.version}. ` +
        `Cache keys use the filename, so the two must agree — fix the front matter.`,
    );
  }

  if (body.length === 0) throw new PromptError(`${path} has front matter and no body.`);

  const placeholders = placeholdersIn(body);
  const inputs = declaredInputs(header, path);
  if (inputs !== null && sorted(inputs) !== sorted(placeholders)) {
    throw new PromptError(
      `${path} declares inputs [${sorted(inputs)}] but its body uses [${sorted(placeholders)}]. ` +
        `The header is read by people deciding what to pass; it does not get to be wrong.`,
    );
  }

  return {
    id: prompt.id,
    version: prompt.version,
    ref: { id: prompt.id, version: String(prompt.version) },
    body,
    placeholders,
    inputs,
    render(values) {
      const supplied = Object.keys(values);
      const missing = placeholders.filter((name) => !supplied.includes(name));
      const unused = supplied.filter((name) => !placeholders.includes(name));
      if (missing.length > 0 || unused.length > 0) {
        throw new PromptError(
          `${path}: ` +
            [
              missing.length > 0 ? `nothing supplied for [${sorted(missing)}]` : null,
              unused.length > 0 ? `supplied [${sorted(unused)}], which it does not use` : null,
            ]
              .filter((part) => part !== null)
              .join("; ") +
            `. Rendering a prompt with a hole in it is a call that costs money and ` +
            `answers a different question.`,
        );
      }
      // One pass, so a value containing `{{x}}` is left as the text it is (rule 4).
      return body.replace(PLACEHOLDER, (_whole, name: string) => values[name] as string);
    },
  };
}
