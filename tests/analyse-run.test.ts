import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnalyseError,
  type AnalyseOptions,
  type AnalyseOutcome,
  readCandidates,
  runAnalyse,
} from "../src/analyse/index.js";
import type { GithubAuth } from "../src/config.js";
import {
  Analysis,
  CANDIDATE_SCHEMA_VERSION,
  type Candidate,
  StoredBundle,
} from "../src/contracts/index.js";
import { GITHUB_API } from "../src/evidence/github.js";
import { llmCache } from "../src/llm/cache.js";
import { LlmCallError, type LlmModel } from "../src/llm/provider.js";
import { newManifest, readManifest, writeManifest } from "../src/manifest.js";
import { RUNS_ROOT, runPaths } from "../src/run.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const AT = new Date("2026-08-22T10:00:00.000Z");
const NOW = () => AT;
const RUN_ID = "2026-08-22-ebpf-observability";

const AUTH: GithubAuth = {
  token: "ghp_notarealtokenatall0000",
  mode: "authenticated",
  note: "",
  toJSON: () => ({ mode: "authenticated", note: "" }),
};

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const dirs: string[] = [];
function scratch(prefix = "analyse-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Route {
  status?: number;
  body?: string;
  contentType?: string;
}

/** Every url the two adapters and the HN fetch might ask for, in one table. */
function web(routes: Record<string, Route>) {
  const calls: string[] = [];
  const transport = async (url: string): Promise<Response> => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) {
      return new Response("<html><body>Not found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
    });
  };
  return { transport, calls };
}

const githubJson = (name: string): string => fixture(join("github", name));

const THREADS = {
  coroot: "https://news.ycombinator.com/item?id=41000001",
  deadco: "https://news.ycombinator.com/item?id=41000002",
} as const;

const thread = (title: string): Route => ({
  body:
    `<html><head><title>${title}</title></head><body>` +
    `<span class='titleline'>${title}</span>` +
    "<div class='comment'>We have been running this in production for months. </div>".repeat(5) +
    "</body></html>",
});

const ROUTES: Record<string, Route> = {
  [THREADS.coroot]: thread("Show HN: Coroot — eBPF observability"),
  [THREADS.deadco]: thread("Show HN: Deadco — traces for agents"),
  "https://coroot.com/": { body: fixture("sites/coroot-home.html") },
  "https://coroot.com/about": { body: fixture("sites/coroot-about.html") },
  [`${GITHUB_API}/repos/coroot/coroot`]: {
    body: githubJson("repo-with-homepage.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/users/coroot`]: {
    body: githubJson("user-organization.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/repos/coroot/coroot/readme`]: {
    body: githubJson("readme-coroot.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/repos/coroot/coroot/contributors?per_page=100`]: {
    body: githubJson("contributors-coroot.json"),
    contentType: "application/json",
  },
  [`${GITHUB_API}/repos/coroot/coroot/stats/commit_activity`]: {
    body: githubJson("commit-activity-coroot.json"),
    contentType: "application/json",
  },
  // Deadco is the candidate whose own site is gone. Every one of its urls
  // falls through to the 404 above, which is the point of it.
};

function candidate(slug: string, name: string, url: string, ref: string, title: string): Candidate {
  return {
    schema_version: CANDIDATE_SCHEMA_VERSION,
    slug,
    name,
    url,
    one_liner: title,
    provenance: [
      {
        source: "hn",
        query: "eBPF observability",
        at: AT.toISOString(),
        ref,
        title,
        posted_url: url,
        posted_at: "2026-08-01T09:00:00.000Z",
      },
    ],
  };
}

const CANDIDATES: Candidate[] = [
  candidate(
    "coroot",
    "Coroot",
    "https://coroot.com/",
    "41000001",
    "Show HN: Coroot — eBPF observability",
  ),
  candidate(
    "deadco",
    "Deadco",
    "https://deadco.example/",
    "41000002",
    "Show HN: Deadco — traces for agents",
  ),
];

/** A run directory as stage 1 leaves it: a manifest and a candidate line each. */
function stageOneRun(candidates: readonly Candidate[] = CANDIDATES): string {
  const root = scratch();
  const paths = runPaths(RUN_ID, root);
  mkdirSync(paths.dir, { recursive: true });
  writeManifest(
    paths.manifest,
    newManifest({
      run_id: RUN_ID,
      created_at: AT.toISOString(),
      seed: { form: "topic", value: "eBPF observability" },
      git: { sha: null, dirty: null },
      llm: { provider: "openai", models: { extract: "gpt-cheap", analyse: null } },
    }),
  );
  writeFileSync(
    paths.candidates,
    `${candidates.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return root;
}

/** The record ids the prompt showed, in the order it showed them. */
function shownIds(input: string): string[] {
  return [...input.matchAll(/^--- BEGIN RECORD ([0-9a-f]+) ---$/gm)].map((match) => match[1] ?? "");
}

interface StubModel extends LlmModel {
  inputs: string[];
}

/**
 * A model that cites the first record it was shown. It reads the ids out of the
 * rendered prompt rather than being told them, because the ids are
 * content-addressed and a test that hard-codes one is a test that breaks when a
 * fixture's whitespace changes.
 *
 * It parses its own answer against the schema it was handed, because
 * `createModel` does (`src/llm/provider.ts`) — a stub that skips that check can
 * write a cache entry no replay can read, which is a property of the stub and
 * not of the pipeline.
 */
function stubModel(over: { fails?: (input: string) => boolean } = {}): StubModel {
  const inputs: string[] = [];
  return {
    provider: "openai",
    model: "gpt-cheap",
    inputs,
    invoke: async (input, schema) => {
      inputs.push(input);
      if (over.fails?.(input)) throw new Error("provider said no");
      const [first] = shownIds(input);
      const facts =
        first === undefined
          ? []
          : [
              {
                key: "product.one_liner",
                statement: "The company describes itself as observability for microservices.",
                value: "observability for microservices",
                evidence_ids: [first],
                confidence: "high",
              },
              {
                key: "founder.name_role",
                statement: "A named person is listed as a co-founder.",
                value: "co-founder",
                evidence_ids: [first],
                confidence: "medium",
              },
              // Dropped at parse time: a key outside the vocabulary. The
              // response schema leaves every field open (`extractionSchema`
              // rule 2), so this arrives to be refused with a reason rather
              // than costing the whole answer.
              {
                key: "traction.is_promising",
                statement: "This looks like a winner.",
                value: true,
                evidence_ids: [first],
                confidence: "low",
              },
            ];
      return {
        value: schema.parse({ facts }) as never,
        usage: { input_tokens: 900, output_tokens: 60 },
      };
    },
  };
}

function analyse(root: string, over: Partial<AnalyseOptions> = {}): Promise<AnalyseOutcome> {
  const stub = over.http?.transport === undefined ? web(ROUTES) : null;
  return runAnalyse({
    runId: RUN_ID,
    root,
    auth: AUTH,
    model: stubModel(),
    cache: llmCache(scratch("analyse-llm-")),
    now: NOW,
    env: {},
    ...over,
    http: {
      cacheDir: "",
      now: NOW,
      retry: { retries: 0 },
      ...(stub ? { transport: stub.transport } : {}),
      ...over.http,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("readCandidates", () => {
  it("counts the lines it could not read rather than failing the run", () => {
    const root = scratch();
    const path = join(root, "candidates.jsonl");
    writeFileSync(path, `${JSON.stringify(CANDIDATES[0])}\nnot json\n{"slug":"x"}\n\n`);

    const read = readCandidates(path);
    expect(read.lines).toBe(3);
    expect(read.candidates.map((entry) => entry.slug)).toEqual(["coroot"]);
    expect(read.unparseable).toBe(2);
  });
});

describe("runAnalyse", () => {
  it("writes one analysis per candidate, and each round-trips through the schema", async () => {
    const root = stageOneRun();
    const outcome = await analyse(root);

    expect(outcome.analysed.map((entry) => entry.slug)).toEqual(["coroot", "deadco"]);
    for (const entry of outcome.analysed) {
      expect(entry.path).not.toBeNull();
      const raw: unknown = JSON.parse(readFileSync(entry.path as string, "utf8"));
      const parsed = Analysis.safeParse(raw);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.candidate.slug).toBe(entry.slug);
    }
    expect(outcome.stage.counts).toMatchObject({ candidates: 2, failed: 0, analyses: 2 });
  });

  // CLAUDE.md invariant 1: the score is arithmetic over the rubric, and the
  // model's only contribution is the facts underneath it.
  it("scores from the rubric, and the score is the sum of the dimensions", async () => {
    const root = stageOneRun();
    const [coroot] = (await analyse(root)).analysed;
    const analysis = coroot?.analysis;

    expect(analysis).toBeTruthy();
    const total = (analysis?.dimensions ?? []).reduce((sum, d) => sum + d.score, 0);
    expect(analysis?.score).toBe(total);
    expect(["PASS", "WATCH", "TAKE_A_MEETING"]).toContain(analysis?.call);
  });

  /**
   * TICKET-0024's stage-2 half, at the seam. `src/analyse/derive.ts` has its
   * own 32 tests; what this one checks is that the stage actually calls it, so
   * a memo has a body to render, and that the body is built from the facts this
   * candidate cited rather than from anything the stage invented.
   */
  it("derives the memo's body from the analysis it just scored", async () => {
    const root = stageOneRun();
    const [coroot] = (await analyse(root)).analysed;
    const analysis = coroot?.analysis;

    expect(analysis?.sections.length).toBeGreaterThan(0);
    const cited = new Set((analysis?.facts ?? []).flatMap((fact) => fact.evidence_ids));
    for (const section of analysis?.sections ?? []) {
      for (const bullet of section.bullets) {
        if (bullet.kind !== "fact") continue;
        expect(bullet.evidence_ids.length).toBeGreaterThan(0);
        for (const id of bullet.evidence_ids) expect(cited.has(id)).toBe(true);
      }
    }
    // SPEC §3: a Watch owes a trigger, and nothing else has one to owe.
    if (analysis?.call !== "WATCH") expect(analysis?.upgrade_trigger).toBeNull();
  });

  it("drops the facts the parser refuses, and counts them by kind", async () => {
    const root = stageOneRun();
    const outcome = await analyse(root);
    const coroot = outcome.analysed[0]?.analysis;

    expect(coroot?.facts.every((fact) => fact.evidence_ids.length > 0)).toBe(true);
    expect(coroot?.inputs.extraction.dropped).toBe(1);
    expect(coroot?.inputs.extraction.dropped_by_kind).toEqual({ schema: 1 });
    // Inconsistency 77: the run-level sum, so a run of heavy drops does not
    // read like a run with thin evidence.
    expect(outcome.stage.facts.dropped_by_kind.schema).toBe(2);
    expect(outcome.stage.facts.kept).toBe(
      outcome.analysed.reduce((sum, entry) => sum + (entry.analysis?.facts.length ?? 0), 0),
    );
  });

  // The ticket's second acceptance item: one site 404s, one model call fails
  // twice, and the run still finishes with both recorded.
  it("finishes with a dead site and a silent model, and records both", async () => {
    const root = stageOneRun();
    const model = stubModel({ fails: (input) => input.includes("name: Coroot") });
    const outcome = await analyse(root, { model });

    const byslug = new Map(outcome.analysed.map((entry) => [entry.slug, entry]));
    const coroot = byslug.get("coroot")?.analysis;
    const deadco = byslug.get("deadco")?.analysis;

    // Asked twice, answered never. Not the same thing as an empty world.
    expect(coroot?.status).toBe("partial");
    expect(coroot?.inputs.extraction.status).toBe("partial");
    expect(coroot?.inputs.extraction.attempts).toBe(2);
    expect(coroot?.facts).toEqual([]);
    expect(coroot?.status_reason).toMatch(/two attempts/);

    // Deadco's own site is gone, so the only readable record is its HN thread.
    expect(deadco?.inputs.gather_failures).toBeGreaterThan(0);
    expect(deadco?.status).toBe("ok");

    expect(outcome.stage.counts.failed).toBe(0);
    expect(outcome.stage.counts.partial).toBe(1);
    expect(outcome.stage.candidates.find((row) => row.slug === "coroot")?.reason).toMatch(
      /two attempts/,
    );
  });

  it("marks a candidate with nothing readable as partial, without calling the model", async () => {
    const root = stageOneRun([CANDIDATES[1] as Candidate]);
    const model = stubModel();
    const outcome = await analyse(root, {
      model,
      // Every url is gone, including the thread: nothing has text to read.
      http: { transport: web({}).transport, cacheDir: "", now: NOW, retry: { retries: 0 } },
    });

    const analysis = outcome.analysed[0]?.analysis;
    expect(analysis?.inputs.extraction.status).toBe("no_evidence");
    expect(analysis?.inputs.extraction.attempts).toBe(0);
    expect(analysis?.status).toBe("partial");
    expect(model.inputs).toEqual([]);
    // Invariant 4: a gap lowers coverage; it never becomes a zero or a guess.
    expect(analysis?.coverage).toBe(0);
    expect(analysis?.unknowns.length).toBeGreaterThan(0);
  });

  it("appends to the manifest without erasing stage 1's record", async () => {
    const root = stageOneRun();
    const paths = runPaths(RUN_ID, root);
    const before = readManifest(paths.manifest);
    writeManifest(paths.manifest, {
      ...(before as NonNullable<typeof before>),
      stages: { source: { candidates: 2 } },
    });

    const outcome = await analyse(root);
    const manifest = readManifest(paths.manifest);

    expect(manifest?.stages.source).toEqual({ candidates: 2 });
    expect(manifest?.stages.analyse).toBeTruthy();
    expect(manifest?.prompt_versions).toEqual({ extract: "1" });
    expect(outcome.stage.llm.model).toBe("gpt-cheap");
    expect(outcome.stage.llm.input_tokens).toBeGreaterThan(0);
    // Inconsistency 54: there is no price table, so cost is unknown — and an
    // unknown cost is null, never a zero that reads as free.
    expect(outcome.stage.llm.cost_usd).toBeNull();
  });

  it("records the budget it planned and what it spent", async () => {
    const root = stageOneRun();
    const outcome = await analyse(root);

    expect(outcome.stage.budget?.candidates).toBe(2);
    expect(outcome.stage.budget?.github_mode).toBe("authenticated");
    expect(outcome.stage.budget?.spent.site?.spent).toBeGreaterThan(0);
    expect(outcome.stage.budget?.spent.github?.limit).toBe(5000);
  });

  describe("--replay", () => {
    it("makes no request and no call, and reaches the same conclusions", async () => {
      const root = stageOneRun();
      const httpCache = scratch("analyse-http-");
      const llm = llmCache(scratch("analyse-llm-"));
      const first = web(ROUTES);

      const cold = await analyse(root, {
        cache: llm,
        http: { transport: first.transport, cacheDir: httpCache, now: NOW, retry: { retries: 0 } },
      });
      expect(first.calls.length).toBeGreaterThan(0);

      // The transport passed here is never reached: `replayHttp` replaces it.
      const second = web(ROUTES);
      const model = stubModel();
      const warm = await analyse(root, {
        replay: true,
        cache: llm,
        model,
        http: { transport: second.transport, cacheDir: httpCache, now: NOW, retry: { retries: 0 } },
      });

      expect(second.calls).toEqual([]);
      expect(model.inputs).toEqual([]);
      expect(warm.stage.llm.from_cache).toBe(warm.stage.llm.calls);
      expect(warm.analysed.map((entry) => entry.analysis?.score)).toEqual(
        cold.analysed.map((entry) => entry.analysis?.score),
      );
    });

    it("stops the run when the LLM cache is cold, rather than calling the provider", async () => {
      const root = stageOneRun();
      const httpCache = scratch("analyse-http-");
      const warmer = web(ROUTES);
      await analyse(root, {
        http: { transport: warmer.transport, cacheDir: httpCache, now: NOW, retry: { retries: 0 } },
      });

      const error = await analyse(root, {
        replay: true,
        cache: llmCache(scratch("analyse-llm-")),
        http: { cacheDir: httpCache, now: NOW, retry: { retries: 0 } },
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlmCallError);
      expect((error as LlmCallError).kind).toBe("replay_miss");
    });

    it("reproduces a run whose HTTP cache is gone — STATE inconsistency 84", async () => {
      const root = stageOneRun();
      const httpCache = scratch("analyse-http-");
      const llm = llmCache(scratch("analyse-llm-"));

      const cold = await analyse(root, {
        cache: llm,
        http: {
          transport: web(ROUTES).transport,
          cacheDir: httpCache,
          now: NOW,
          retry: { retries: 0 },
        },
      });
      const before = readdirSync(runPaths(RUN_ID, root).analysesDir)
        .sort()
        .map((file) => readFileSync(join(runPaths(RUN_ID, root).analysesDir, file), "utf8"));

      // A fresh clone: `.cache/http/` is gitignored, so it is not there. This
      // is the exact state that used to overwrite the committed analyses with
      // `PASS 25` at 0% coverage, because gathering produced empty bundles.
      rmSync(httpCache, { recursive: true, force: true });

      const warm = await analyse(root, {
        replay: true,
        cache: llm,
        http: { cacheDir: scratch("analyse-cold-"), now: NOW, retry: { retries: 0 } },
      });

      expect(warm.stage.bundles.source).toBe("bundles");
      expect(warm.stage.budget).toBeNull();
      expect(warm.analysed.map((entry) => entry.analysis?.coverage)).toEqual(
        cold.analysed.map((entry) => entry.analysis?.coverage),
      );
      const after = readdirSync(runPaths(RUN_ID, root).analysesDir)
        .sort()
        .map((file) => readFileSync(join(runPaths(RUN_ID, root).analysesDir, file), "utf8"));
      expect(after).toEqual(before);
    });

    it("stops rather than guessing when the run has no bundles to replay", async () => {
      const root = stageOneRun();
      const error = await analyse(root, {
        replay: true,
        http: { cacheDir: scratch("analyse-cold-"), now: NOW, retry: { retries: 0 } },
      }).catch((e: unknown) => e);

      expect((error as Error).name).toBe("BundleError");
      expect((error as Error).message).toContain("without --replay");
    });

    it("writes its record beside the gather's, never over it", async () => {
      const root = stageOneRun();
      const httpCache = scratch("analyse-http-");
      const llm = llmCache(scratch("analyse-llm-"));
      await analyse(root, {
        cache: llm,
        http: {
          transport: web(ROUTES).transport,
          cacheDir: httpCache,
          now: NOW,
          retry: { retries: 0 },
        },
      });
      const gather = readManifest(runPaths(RUN_ID, root).manifest)?.stages.analyse;

      await analyse(root, {
        replay: true,
        cache: llm,
        http: { cacheDir: scratch("analyse-cold-"), now: NOW, retry: { retries: 0 } },
      });

      // STATE inconsistency 96. The gather's record is the only place the
      // requests it spent are written down at run level, and a replay spent
      // none of them.
      const after = readManifest(runPaths(RUN_ID, root).manifest);
      expect(after?.stages.analyse).toEqual(gather);
      const replayed = after?.stages.analyse_replay as { bundles: { source: string } } | undefined;
      expect(replayed?.bundles.source).toBe("bundles");
    });

    it("needs no API key, because a replay never reaches a provider", async () => {
      const root = stageOneRun();
      const httpCache = scratch("analyse-http-");
      const llm = llmCache(scratch("analyse-llm-"));
      await analyse(root, {
        cache: llm,
        http: {
          transport: web(ROUTES).transport,
          cacheDir: httpCache,
          now: NOW,
          retry: { retries: 0 },
        },
      });

      // No `model` override: the run resolves one from a keyless environment.
      const outcome = await runAnalyse({
        runId: RUN_ID,
        root,
        replay: true,
        auth: AUTH,
        cache: llm,
        now: NOW,
        env: { LLM_PROVIDER: "openai", MODEL_EXTRACT: "gpt-cheap" },
        http: { cacheDir: httpCache, now: NOW, retry: { retries: 0 } },
      });

      expect(outcome.stage.counts.analyses).toBe(2);
      expect(outcome.stage.llm.from_cache).toBe(outcome.stage.llm.calls);
    });
  });

  describe("bundles as an artifact", () => {
    it("writes one bundle per candidate, naming its evidence in gather order", async () => {
      const root = stageOneRun();
      const outcome = await analyse(root);
      const dir = runPaths(RUN_ID, root).bundlesDir;

      expect(readdirSync(dir).sort()).toEqual(["coroot.json", "deadco.json"]);
      const stored = StoredBundle.parse(JSON.parse(readFileSync(join(dir, "coroot.json"), "utf8")));
      const analysis = outcome.analysed.find((entry) => entry.slug === "coroot")?.analysis;
      expect(stored.slug).toBe("coroot");
      expect(stored.evidence_ids.length).toBeGreaterThan(0);
      // Everything the analysis cites was in the bundle it was extracted from.
      for (const dimension of analysis?.dimensions ?? []) {
        for (const id of dimension.evidence_ids) expect(stored.evidence_ids).toContain(id);
      }
      // The signals the rubric scored are here, because they cannot be
      // recovered from the evidence store — that is why (c) was the fix.
      expect(stored.signals.length).toBeGreaterThan(0);
    });

    it("records a candidate that yielded nothing, rather than omitting it", async () => {
      const root = stageOneRun();
      await analyse(root);
      const stored = StoredBundle.parse(
        JSON.parse(readFileSync(join(runPaths(RUN_ID, root).bundlesDir, "deadco.json"), "utf8")),
      );

      expect(stored.failures.length).toBeGreaterThan(0);
      expect(stored.unknowns.length).toBeGreaterThan(0);
    });
  });

  describe("what the operator got wrong", () => {
    it("refuses to overwrite analyses a previous pass decided", async () => {
      const root = stageOneRun();
      await analyse(root);
      const dir = runPaths(RUN_ID, root).analysesDir;
      const before = readFileSync(join(dir, "coroot.json"), "utf8");

      const error = await analyse(root).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AnalyseError);
      expect((error as AnalyseError).failure).toBe("analyses_exist");
      expect(readFileSync(join(dir, "coroot.json"), "utf8")).toBe(before);
    });

    it("overwrites them when --force says so", async () => {
      const root = stageOneRun();
      await analyse(root);
      const outcome = await analyse(root, { force: true });

      expect(outcome.stage.flags.force).toBe(true);
      expect(outcome.stage.counts.analyses).toBe(2);
    });

    it("refuses a run directory that stage 1 never finished", async () => {
      const root = scratch();
      const error = await analyse(root).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnalyseError);
      expect((error as AnalyseError).failure).toBe("no_run");
    });

    it("refuses a run whose candidates file holds nothing usable", async () => {
      const root = stageOneRun();
      writeFileSync(runPaths(RUN_ID, root).candidates, "not json\n");
      const error = await analyse(root).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnalyseError);
      expect((error as AnalyseError).failure).toBe("no_candidates");
    });
  });

  // ARCHITECTURE §5, at the layer that owns it. Nothing inside stage 2 throws
  // per candidate by design — both adapters and the extractor return failures
  // as data — so the case is provoked with an unwritable directory, which is
  // the shape a real one would have: the analysis was computed and could not
  // be kept.
  it("records a candidate that threw as failed, and still finishes the run", async () => {
    if (process.getuid?.() === 0) return;
    const root = stageOneRun();
    const paths = runPaths(RUN_ID, root);
    mkdirSync(paths.analysesDir, { recursive: true });
    chmodSync(paths.analysesDir, 0o555);
    try {
      const outcome = await analyse(root);

      expect(outcome.stage.counts).toMatchObject({ candidates: 2, ok: 0, failed: 2, analyses: 0 });
      expect(outcome.analysed.every((entry) => entry.analysis === null)).toBe(true);
      expect(outcome.stage.candidates[0]?.reason).toMatch(/EACCES|permission/i);
      // The manifest is still written: it is how a reviewer sees what happened.
      expect(readManifest(paths.manifest)?.stages.analyse).toBeTruthy();
    } finally {
      chmodSync(paths.analysesDir, 0o755);
    }
  });

  // ADR-0003: a citation is a pointer into this directory, so every id an
  // analysis carries has to be a file a stage-3 validator can open.
  it("writes every cited record into the run's own evidence store", async () => {
    const root = stageOneRun();
    const outcome = await analyse(root);
    const dir = join(root, RUNS_ROOT, RUN_ID, "evidence");

    const cited = new Set(
      outcome.analysed.flatMap(
        (entry) => entry.analysis?.facts.flatMap((f) => f.evidence_ids) ?? [],
      ),
    );
    expect(cited.size).toBeGreaterThan(0);
    const onDisk = new Set(readdirSync(dir).map((name) => name.replace(/\.json$/, "")));
    for (const id of cited) expect(onDisk.has(id)).toBe(true);
  });
});
