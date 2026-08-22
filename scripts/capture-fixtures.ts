import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { githubAuth, loadDotEnv } from "../src/config.js";
import { extractHtml, type HttpOptions, httpGet } from "../src/evidence/fetch.js";
import { hnSearchUrl } from "../src/source/hn.js";
import {
  type AuthoredFixture,
  deriveMalformedPage,
  findSecrets,
  modelFixtures,
  normaliseHtml,
  normaliseJson,
  pickHeaders,
  sha256,
} from "./fixtures.js";

/**
 * `pnpm capture-fixtures` (TICKET-0014). TESTING commits to this script by
 * name: it is what keeps the suite offline as stage 2 adds three more external
 * surfaces, and the fixtures double as a record of what the external APIs
 * actually returned on the day the code was written.
 *
 * Run manually and rarely. It is not wired into `pnpm test`, it is not run in
 * CI, and it is the only file outside `src/` allowed to touch the network.
 *
 * Four rules:
 *
 * 1. **A fixture is written once and refreshed on purpose.** A bare run writes
 *    only what is missing. Refreshing is `--refresh`, because a relevance-ranked
 *    API returns different hits every month and a script that silently rewrote
 *    committed fixtures would rewrite the suite's assertions with them.
 *
 * 2. **Capture never reads the HTTP cache.** `cacheDir: ""` — a capture is a
 *    statement about what the server returned today, and a cache hit would
 *    replay a `retrieved_at` from another day into the record.
 *
 * 3. **Nothing is written until it has been scanned.** A body carrying anything
 *    credential-shaped fails its fixture, names the rule and writes no file
 *    (`findSecrets`, rule 2 there). The run then exits non-zero: the ticket's
 *    acceptance criterion is mechanical, not a promise.
 *
 * 4. **Provenance is generated, not remembered.** `tests/fixtures/capture.json`
 *    records url, status, date, size and digest per fixture, merged across
 *    runs, so capturing one group cannot erase how the others were obtained.
 */

export const FIXTURE_ROOT = join("tests", "fixtures");
export const MANIFEST_PATH = join(FIXTURE_ROOT, "capture.json");
export const MANIFEST_SCHEMA_VERSION = 1;

/** Cap on a captured page. Bigger than this is not reviewable, so it is refused
 * rather than truncated — a half-page of HTML parses to something the server
 * never served. */
export const MAX_FIXTURE_BYTES = 128 * 1024;

export interface FixtureSpec {
  /** Relative to `tests/fixtures`, posix-style in the source. */
  path: string;
  kind: "json" | "html";
  url: string;
  /** One line, copied into the manifest and the fixtures README. */
  note: string;
  headers?: Record<string, string>;
  /**
   * Set on a fixture that predates this script. It was captured by hand, the
   * committed bytes are the ones the suite asserts against, and a bare run
   * *adopts* it — records its provenance without fetching — rather than
   * quietly replacing it. `--refresh` still re-captures it, which is a
   * deliberate act: refreshing these five broke five assertions in
   * `tests/hn.test.ts` the first time it was tried, which is rule 1 working.
   */
  legacy?: { captured_on: string; how: string };
}

const GITHUB_API = "https://api.github.com";

/**
 * The four fixtures TICKET-0009 captured by hand, before this script existed.
 * Their urls are transcriptions of the `curl` commands in that ticket's own
 * fixture README rather than rebuilt through `hnSearchUrl` — the commands are
 * what produced the committed bytes, and a manifest that claimed otherwise
 * would be provenance with a lie in it.
 */
const LEGACY_0009 = {
  captured_on: "2026-08-22T00:00:00.000Z",
  how: "captured by hand for TICKET-0009, before this script existed",
} as const;

const HN_SEARCH = "https://hn.algolia.com/api/v1/search";

/**
 * GitHub's documented pinning headers. The token, when there is one, is added
 * at request time by `captureOne` and never travels in a spec — a spec is
 * printable and a token is not.
 */
const GITHUB_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

/**
 * The capture list. Every entry names why it exists, because a fixture nobody
 * can justify is a fixture nobody dares delete.
 *
 * The GitHub five and the two company pages are all candidates from the
 * TICKET-0013 gate's own 48 (worklog 0022), not inventions: `coroot` is the
 * organisation whose demo instance was the gate's one surviving junk candidate,
 * and `nullswan/bpfsnitch` is one of the ten open-source projects the gate found
 * indistinguishable from a company at stage 1. `ccfos/huatuo` is the exception
 * that proves `type` is a signal and not a rule — an organisation that is a
 * foundation, not a company.
 */
export function fixtureSpecs(now: Date): FixtureSpec[] {
  return [
    {
      path: "hn/search-page-0.json",
      kind: "json",
      url: `${HN_SEARCH}?query=llm%20observability&tags=story&hitsPerPage=5&page=0&numericFilters=created_at_i%3E1740000000`,
      note: "Page 0 of a normal topic. Pagination, and the shape every hn test starts from.",
      legacy: LEGACY_0009,
    },
    {
      path: "hn/search-page-1.json",
      kind: "json",
      url: `${HN_SEARCH}?query=llm%20observability&tags=story&hitsPerPage=5&page=1&numericFilters=created_at_i%3E1740000000`,
      note: "Page 1 of the same query. The pagination test needs two real pages.",
      legacy: LEGACY_0009,
    },
    {
      path: "hn/search-empty.json",
      kind: "json",
      url: `${HN_SEARCH}?query=qzxvnowaythisisareal%20term%20xyzzy&tags=story`,
      note: "A seed nobody has posted about: zero hits, still a 200.",
      legacy: LEGACY_0009,
    },
    {
      path: "hn/search-ask-hn.json",
      kind: "json",
      url: `${HN_SEARCH}?query=llm%20observability&tags=ask_hn&hitsPerPage=5`,
      note: "Text posts — every hit has a null url, which the classifier must reject.",
      legacy: LEGACY_0009,
    },
    {
      path: "hn/search-thin.json",
      kind: "json",
      url: hnSearchUrl({ query: "eBPF observability", tags: "story", sinceDays: 180 }, now),
      note: "The gate's thin topic, probe-shaped: the run that fell under --min-hits 8 and produced four of five junk candidates (worklog 0022).",
    },
    {
      path: "github/user-organization.json",
      kind: "json",
      url: `${GITHUB_API}/users/coroot`,
      note: 'GET /users/<owner> for an organisation. `type: "Organization"` is the discriminator of inconsistency 22, and `blog` is a second route to the company site.',
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/user-person.json",
      kind: "json",
      url: `${GITHUB_API}/users/nullswan`,
      note: 'The same call for a personal account: `type: "User"`, the side of the gate\'s ten open-source projects with no company behind them.',
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/user-foundation.json",
      kind: "json",
      url: `${GITHUB_API}/users/ccfos`,
      note: "An organisation that is a foundation, not a company — the exception that keeps `type` a fact for the rubric rather than a filter.",
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/repo-with-homepage.json",
      kind: "json",
      url: `${GITHUB_API}/repos/coroot/coroot`,
      note: "GET /repos/<owner>/<repo> carrying `homepage` — the repo ↔ company-site join stage 1 structurally cannot make (inconsistency 45).",
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/repo-hobby.json",
      kind: "json",
      url: `${GITHUB_API}/repos/nullswan/bpfsnitch`,
      note: "A repo from the gate's list with a personal owner and no homepage. The missing-data path for the join.",
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/readme-coroot.json",
      kind: "json",
      url: `${GITHUB_API}/repos/coroot/coroot/readme`,
      note: "GET /repos/<owner>/<repo>/readme — base64 in a JSON envelope, so the adapter decodes rather than stores what the API returned.",
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/contributors-coroot.json",
      kind: "json",
      url: `${GITHUB_API}/repos/coroot/coroot/contributors?per_page=100`,
      note: "The contributor list, one page. Its length is the count when it is short of the page size and a floor when it is not.",
      headers: GITHUB_HEADERS,
    },
    {
      path: "github/commit-activity-coroot.json",
      kind: "json",
      url: `${GITHUB_API}/repos/coroot/coroot/stats/commit_activity`,
      // The 202 is not capturable on demand — it depends on whether GitHub's
      // cache is warm — so the adapter's 202 path is tested with a stub.
      note: "52 weeks of commit counts, each carrying its own week boundary. The one dated cadence signal the API gives free; it answers 202 with an empty body while GitHub computes it.",
      headers: GITHUB_HEADERS,
    },
    {
      path: "sites/coroot-home.html",
      kind: "html",
      url: "https://coroot.com",
      note: "A real company landing page, for the extractor to meet chrome it did not write.",
    },
    {
      path: "sites/coroot-about.html",
      kind: "html",
      url: "https://coroot.com/about",
      note: "The team page behind it: the surface founder facts are extracted from.",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export interface FixtureRecord {
  path: string;
  /** A superset of `FixtureSpec["kind"]`: an authored fixture may be plain text. */
  kind: FixtureSpec["kind"] | "text";
  /** How these bytes came to exist. `hand` predates the script; see `legacy`. */
  captured_by: "script" | "hand" | "derived" | "authored";
  /** Null for a derived fixture; see `derived_from`. */
  url: string | null;
  /** Set when the fixture was built from another fixture rather than fetched. */
  derived_from?: string;
  note: string;
  status: number | null;
  captured_at: string;
  bytes: number;
  sha256: string;
  /** Allowlisted response headers only. */
  headers?: Record<string, string>;
  /** For html: what `extractHtml` gets out of it. A near-zero count is the
   * "empty shell" case TESTING §6 asks for, and worth seeing in the manifest. */
  text_chars?: number;
}

export interface Captured {
  spec: FixtureSpec;
  content: string;
  record: FixtureRecord;
}

export interface CaptureFailure {
  path: string;
  reason: string;
}

export type CaptureOutcome = ({ ok: true } & Captured) | ({ ok: false } & CaptureFailure);

export async function captureOne(
  spec: FixtureSpec,
  options: HttpOptions = {},
): Promise<CaptureOutcome> {
  const fail = (reason: string): CaptureOutcome => ({ ok: false, path: spec.path, reason });

  const result = await httpGet(spec.url, {
    ...options,
    // Rule 2: a capture is today's answer or it is not a capture.
    cacheDir: "",
    headers: { ...spec.headers, ...options.headers },
  });
  if (!result.ok) return fail(`${result.status || "no response"} — ${result.reason}`);

  let content: string;
  try {
    content = spec.kind === "json" ? normaliseJson(result.body) : normaliseHtml(result.body);
  } catch (error) {
    return fail(
      `unreadable as ${spec.kind}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_FIXTURE_BYTES) {
    return fail(`${Math.round(bytes / 1024)} KB exceeds the ${MAX_FIXTURE_BYTES / 1024} KB cap`);
  }

  // Rule 3. The body is scanned before it is a file, and the report names the
  // rule and a fingerprint rather than the match.
  const secrets = findSecrets(content);
  if (secrets.length > 0) {
    const rules = [...new Set(secrets.map((s) => s.rule))].join(", ");
    return fail(
      `credential-shaped content (${rules}) at ${secrets.map((s) => s.index).join(", ")}`,
    );
  }

  const headers = pickHeaders(result.headers);
  const record: FixtureRecord = {
    path: spec.path,
    kind: spec.kind,
    captured_by: "script",
    url: spec.url,
    note: spec.note,
    status: result.status,
    captured_at: result.retrieved_at,
    bytes,
    sha256: sha256(content),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(spec.kind === "html" ? { text_chars: extractHtml(content).text.length } : {}),
  };
  return { ok: true, spec, content, record };
}

/* -------------------------------------------------------------------------- */
/* Derived fixtures                                                            */
/* -------------------------------------------------------------------------- */

export const MALFORMED_SPEC = {
  path: "hn/search-malformed.json",
  from: "hn/search-page-0.json",
  note: "search-page-0 with five deliberate defects, one per hit. Derived by `HN_DEFECTS`, not hand-edited; four of the five are survivable on purpose.",
} as const;

/** Built from a fixture on disk, so it stays in step with a refresh of its source. */
export function deriveMalformed(sourceJson: string, now: Date): Captured {
  const content = normaliseJson(JSON.stringify(deriveMalformedPage(JSON.parse(sourceJson))));
  return {
    spec: { path: MALFORMED_SPEC.path, kind: "json", url: "", note: MALFORMED_SPEC.note },
    content,
    record: {
      path: MALFORMED_SPEC.path,
      kind: "json",
      captured_by: "derived",
      url: null,
      derived_from: MALFORMED_SPEC.from,
      note: MALFORMED_SPEC.note,
      status: null,
      captured_at: now.toISOString(),
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    },
  };
}

/**
 * Model output cannot be captured — the interesting shapes are the ones a model
 * produces on a bad day — so these are written from a table with the defect each
 * one demonstrates next to it (`FACT_DEFECTS`). Rewritten every run, which is
 * safe because they are a pure function of that table.
 */
export function authoredRecord(fixture: AuthoredFixture, now: Date): Captured {
  return {
    spec: { path: fixture.path, kind: "json", url: "", note: fixture.note },
    content: fixture.content,
    record: {
      path: fixture.path,
      kind: fixture.path.endsWith(".json") ? "json" : "text",
      captured_by: "authored",
      url: null,
      derived_from: "scripts/fixtures.ts",
      note: fixture.note,
      status: null,
      captured_at: now.toISOString(),
      bytes: Buffer.byteLength(fixture.content),
      sha256: sha256(fixture.content),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Adoption                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record a hand-captured fixture's provenance without fetching it. The digest
 * is read off the committed file — which is the point: the manifest then
 * describes the bytes the suite actually asserts against, and says they were
 * not this script's doing.
 */
export function adopt(spec: FixtureSpec, content: string): FixtureRecord {
  if (!spec.legacy) throw new Error(`${spec.path} is not a legacy fixture; capture it instead`);
  return {
    path: spec.path,
    kind: spec.kind,
    captured_by: "hand",
    url: spec.url,
    note: `${spec.note} (${spec.legacy.how})`,
    // Null, not 200: this script never saw a response for these bytes.
    status: null,
    captured_at: spec.legacy.captured_on,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    ...(spec.kind === "html" ? { text_chars: extractHtml(content).text.length } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                    */
/* -------------------------------------------------------------------------- */

export interface Manifest {
  schema_version: number;
  generated_by: string;
  fixtures: FixtureRecord[];
}

/**
 * Merge new records over old ones and sort by path. A run capturing one group
 * must not erase the provenance of the groups it did not touch (rule 4).
 */
export function mergeManifest(previous: FixtureRecord[], captured: FixtureRecord[]): Manifest {
  const byPath = new Map(previous.map((record) => [record.path, record]));
  for (const record of captured) byPath.set(record.path, record);
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    generated_by: "pnpm capture-fixtures",
    fixtures: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function readManifest(root: string): FixtureRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "capture.json"), "utf8")) as Manifest;
    return Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
  } catch {
    return [];
  }
}

function writeFixture(root: string, path: string, content: string): void {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function exists(root: string, path: string): boolean {
  try {
    readFileSync(join(root, ...path.split("/")));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

export interface RunFlags {
  refresh: boolean;
  only: string | null;
  dryRun: boolean;
}

export function parseFlags(argv: readonly string[]): RunFlags {
  const flags: RunFlags = { refresh: false, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--refresh") flags.refresh = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--only needs a path prefix, e.g. --only github");
      flags.only = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    } else throw new Error(`unknown flag '${arg}'\n\n${USAGE}`);
  }
  return flags;
}

const USAGE = `usage: pnpm capture-fixtures [--only <prefix>] [--refresh] [--dry-run]

Captures live responses into ${FIXTURE_ROOT}/ and records provenance in
${MANIFEST_PATH}. Run manually and rarely; never in CI.

  --only <prefix>  capture one group, e.g. --only github
  --refresh        re-capture fixtures that already exist (they are skipped by
                   default: a relevance-ranked API returns different hits every
                   month, and the suite asserts on these files)
  --dry-run        print the plan and make no requests`;

async function main(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  const now = new Date();
  const specs = fixtureSpecs(now).filter(
    (spec) => flags.only === null || spec.path.startsWith(flags.only),
  );

  const planned = specs.filter((spec) => flags.refresh || !exists(FIXTURE_ROOT, spec.path));
  const skipped = specs.length - planned.length;

  if (flags.dryRun) {
    for (const spec of planned) process.stdout.write(`would capture ${spec.path}\n  ${spec.url}\n`);
    process.stdout.write(`\n${planned.length} to capture, ${skipped} already present\n`);
    return 0;
  }

  const auth = githubAuth();
  process.stdout.write(`github: ${auth.mode}\n`);

  const captured: Captured[] = [];
  const adopted: FixtureRecord[] = [];
  const failures: CaptureFailure[] = [];
  for (const spec of planned) {
    const isGithub = spec.url.startsWith(GITHUB_API);
    const outcome = await captureOne(spec, {
      ...(isGithub && auth.token ? { headers: { authorization: `Bearer ${auth.token}` } } : {}),
    });
    if (outcome.ok) {
      captured.push(outcome);
      writeFixture(FIXTURE_ROOT, spec.path, outcome.content);
      process.stdout.write(
        `  ok    ${spec.path} — ${outcome.record.status}, ${outcome.record.bytes} bytes\n`,
      );
    } else {
      failures.push(outcome);
      process.stdout.write(`  FAIL  ${spec.path} — ${outcome.reason}\n`);
    }
  }

  // A hand-captured fixture this run skipped still belongs in the manifest, so
  // its provenance is recorded from the committed bytes rather than invented.
  for (const spec of specs) {
    if (!spec.legacy || planned.includes(spec)) continue;
    try {
      adopted.push(adopt(spec, readFileSync(join(FIXTURE_ROOT, ...spec.path.split("/")), "utf8")));
    } catch (error) {
      failures.push({
        path: spec.path,
        reason: `adopt failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const fixture of modelFixtures()) {
    if (flags.only !== null && !fixture.path.startsWith(flags.only)) continue;
    const authored = authoredRecord(fixture, now);
    captured.push(authored);
    writeFixture(FIXTURE_ROOT, fixture.path, fixture.content);
    process.stdout.write(`  ok    ${fixture.path} — authored from scripts/fixtures.ts\n`);
  }

  // Derived last, so a refreshed source page produces a matching malformed one
  // in the same run. Its source must exist, which after the loop above it does.
  if (flags.only === null || MALFORMED_SPEC.path.startsWith(flags.only)) {
    try {
      const source = readFileSync(join(FIXTURE_ROOT, ...MALFORMED_SPEC.from.split("/")), "utf8");
      const derived = deriveMalformed(source, now);
      captured.push(derived);
      writeFixture(FIXTURE_ROOT, derived.record.path, derived.content);
      process.stdout.write(
        `  ok    ${derived.record.path} — derived from ${MALFORMED_SPEC.from}\n`,
      );
    } catch (error) {
      failures.push({
        path: MALFORMED_SPEC.path,
        reason: `derive failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // A fixture on disk with no manifest entry is provenance this repo has lost —
  // most likely `capture.json` was deleted, since a bare run skips what exists
  // and so cannot rebuild a record it never wrote. Loud, because the alternative
  // is a committed fixture nobody can say the origin of.
  const manifest = mergeManifest(readManifest(FIXTURE_ROOT), [
    ...captured.map((entry) => entry.record),
    ...adopted,
  ]);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  const recorded = new Set(manifest.fixtures.map((record) => record.path));
  for (const spec of specs) {
    if (recorded.has(spec.path) || !exists(FIXTURE_ROOT, spec.path)) continue;
    failures.push({
      path: spec.path,
      reason: "on disk with no provenance record — re-capture it with --refresh",
    });
    process.stdout.write(`  FAIL  ${spec.path} — no provenance record\n`);
  }

  process.stdout.write(
    `\n${captured.length} written, ${adopted.length} adopted, ${failures.length} failed, ` +
      `${skipped} already present.\n` +
      `provenance: ${MANIFEST_PATH}\n`,
  );
  if (skipped > 0 && !flags.refresh) {
    process.stdout.write("re-capture an existing fixture with --refresh.\n");
  }
  return failures.length > 0 ? 1 : 0;
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  return argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href;
}

if (isEntrypoint()) {
  // Only for `GITHUB_TOKEN`: unauthenticated GitHub is 60 requests/hour, which
  // this list fits inside and a wider one would not. Absent is fine — the run
  // says which mode it used, the same way a pipeline run does (TICKET-0006).
  loadDotEnv();
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `capture-fixtures: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    });
}
