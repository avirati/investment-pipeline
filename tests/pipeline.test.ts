import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubAuth } from "../src/config.js";
import type { HttpOptions } from "../src/evidence/fetch.js";
import { type LlmCache, llmCache } from "../src/llm/cache.js";
import type { LlmModel } from "../src/llm/provider.js";
import { readManifest } from "../src/manifest.js";
import {
  type PipelineEvent,
  type PipelineOptions,
  type PipelineOutcome,
  runPipeline,
} from "../src/pipeline.js";
import { runPaths } from "../src/run.js";

/**
 * TICKET-0027 — `./pipeline run`, offline.
 *
 * SPEC §5's first acceptance criterion is one command producing memos, and its
 * second is that a replay of that run makes zero network calls and produces
 * identical memos. Both are asserted here against the real three stages: the
 * only things stubbed are the transport and the provider, which is what
 * TESTING §4 requires and is also the only way the second assertion means
 * anything — a test that stubbed a stage could not tell you the stage replayed.
 */

const SEED = "LLM observability";
const AT = new Date("2026-08-23T09:00:00.000Z");
const NOW = () => AT;
const RUN_ID = "2026-08-23-llm-observability";

const AUTH: GithubAuth = {
  token: null,
  mode: "unauthenticated",
  note: "",
  toJSON: () => ({ mode: "unauthenticated", note: "" }),
};

const dirs: string[] = [];
function scratch(prefix = "pipeline-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The world                                                                   */
/* -------------------------------------------------------------------------- */

const SEARCH = {
  hits: Array.from({ length: 12 }, (_, i) => ({
    objectID: `4100000${i}`,
    title: `Show HN: Acme${i} – tracing for LLM calls`,
    url: `https://acme${i}.dev`,
    points: 100 - i,
    num_comments: 8,
    created_at: "2026-08-01T00:00:00.000Z",
  })),
  nbHits: 12,
  page: 0,
  nbPages: 1,
};

const SITE =
  "<html><head><title>Acme — tracing for LLM calls</title></head><body><main>" +
  "<h1>Acme</h1><p>Acme is an open-source tracing tool for LLM applications. " +
  "Founded in 2024 by two former infrastructure engineers.</p>" +
  "</main></body></html>";

const THREAD =
  "<html><head><title>Show HN: Acme</title></head><body>" +
  "<span class='titleline'>Show HN: Acme – tracing for LLM calls</span>" +
  "<div class='comment'>We have run this in production for a year. </div>".repeat(4) +
  "</body></html>";

/** One transport for both stages, so "no request" can be asserted run-wide. */
function web(): { http: HttpOptions; urls: string[]; cacheDir: string } {
  const urls: string[] = [];
  const cacheDir = scratch("pipeline-http-");
  const transport = async (url: string): Promise<Response> => {
    urls.push(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const html = (body: string, status = 200): Response =>
      new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

    if (url.startsWith("https://hn.algolia.com")) return json(SEARCH);
    if (url.startsWith("https://news.ycombinator.com")) return html(THREAD);
    // No GitHub account behind any of these companies. The gather records the
    // absence rather than inventing one, which is the path most candidates in a
    // real run take.
    if (url.startsWith("https://api.github.com")) return json({ message: "Not Found" }, 404);
    return html(SITE);
  };
  return { http: { transport, cacheDir, now: NOW, retry: { retries: 0 } }, urls, cacheDir };
}

/** Reads the ids out of the rendered prompt, as `tests/analyse-run.test.ts` does. */
function stubModel(over: { fails?: (input: string) => boolean } = {}): LlmModel & {
  inputs: string[];
} {
  const inputs: string[] = [];
  return {
    provider: "openai",
    model: "gpt-cheap",
    inputs,
    invoke: async (input, schema) => {
      inputs.push(input);
      if (over.fails?.(input)) throw new Error("provider said no");
      const [first] = [...input.matchAll(/^--- BEGIN RECORD ([0-9a-f]+) ---$/gm)].map(
        (match) => match[1] ?? "",
      );
      const facts =
        first === undefined
          ? []
          : [
              {
                key: "product.one_liner",
                statement: "The company describes itself as tracing for LLM applications.",
                value: "tracing for LLM applications",
                evidence_ids: [first],
                confidence: "high",
              },
              {
                key: "founder.name_role",
                statement: "Two former infrastructure engineers are named as founders.",
                value: "two former infrastructure engineers",
                evidence_ids: [first],
                confidence: "medium",
              },
            ];
      return {
        value: schema.parse({ facts }) as never,
        usage: { input_tokens: 800, output_tokens: 40 },
      };
    },
  };
}

interface Harness {
  root: string;
  cache: LlmCache;
  http: HttpOptions;
  urls: string[];
}

function harness(): Harness {
  const site = web();
  return {
    root: scratch(),
    cache: llmCache(scratch("pipeline-llm-")),
    http: site.http,
    urls: site.urls,
  };
}

function pipeline(h: Harness, over: Partial<PipelineOptions> = {}): Promise<PipelineOutcome> {
  return runPipeline({
    seed: SEED,
    limit: 2,
    root: h.root,
    auth: AUTH,
    model: stubModel(),
    cache: h.cache,
    http: h.http,
    now: NOW,
    env: {},
    ...over,
  });
}

const memoFiles = (root: string): string[] =>
  readdirSync(runPaths(RUN_ID, root).memoDir)
    .sort()
    .map((file) => readFileSync(join(runPaths(RUN_ID, root).memoDir, file), "utf8"));

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("runPipeline", () => {
  it("takes a seed and leaves memos on disk, in one call", async () => {
    const h = harness();
    const outcome = await pipeline(h);

    expect(outcome.run_id).toBe(RUN_ID);
    expect(outcome.stage.counts.candidates).toBe(2);
    expect(outcome.stage.counts.memos).toBe(2);
    expect(memoFiles(h.root)).toHaveLength(2);
    for (const memo of memoFiles(h.root)) {
      expect(memo).toContain("## Why this call");
    }
  });

  it("carries stage 1's run id into stages 2 and 3 rather than deriving it twice", async () => {
    const h = harness();
    const outcome = await pipeline(h);

    expect(outcome.source.run_id).toBe(outcome.run_id);
    expect(outcome.analyse.run_id).toBe(outcome.run_id);
    expect(outcome.memo.run_id).toBe(outcome.run_id);
    // And every artifact is under that one directory.
    const paths = runPaths(outcome.run_id, h.root);
    expect(readdirSync(paths.dir).sort()).toEqual([
      "analyses",
      "bundles",
      "candidates.jsonl",
      "evidence",
      "manifest.json",
      "query_plan.json",
    ]);
  });

  it("writes one manifest with all four records, and does not overwrite the earlier ones", async () => {
    const h = harness();
    const outcome = await pipeline(h);
    const manifest = readManifest(runPaths(RUN_ID, h.root).manifest);

    expect(Object.keys(manifest?.stages ?? {}).sort()).toEqual([
      "analyse",
      "memo",
      "run",
      "source",
    ]);
    expect(outcome.stage.stages.map((row) => row.stage)).toEqual(["source", "analyse", "memo"]);
  });

  /**
   * ARCHITECTURE §4's manifest list, item by item — the ticket asks for exactly
   * this, because each stage added its own slice and drift is the likely
   * failure. `cost_usd` is the one entry that is null, and deliberately: it
   * stays null while `PRICES` is empty (inconsistency 54), and null there reads
   * as unpriced rather than free.
   */
  it("records every field ARCHITECTURE §4 promises", async () => {
    const h = harness();
    await pipeline(h);
    const manifest = readManifest(runPaths(RUN_ID, h.root).manifest);
    if (manifest === null) throw new Error("no manifest");

    expect(manifest.seed).toEqual({ form: "topic", value: SEED });
    expect(manifest.git.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.llm.provider).not.toBe("");
    expect(manifest.prompt_versions.extract).toBe("1");

    const analyse = manifest.stages.analyse as { llm: { model: string; cost_usd: number | null } };
    expect(analyse.llm.model).toBe("gpt-cheap");
    expect(analyse.llm.cost_usd).toBeNull();

    const run = manifest.stages.run as {
      duration_ms: number;
      counts: Record<string, number>;
      stages: { stage: string; duration_ms: number }[];
    };
    expect(run.stages).toHaveLength(3);
    expect(run.counts.candidates).toBe(2);

    // Per-candidate status, with a row for every candidate stage 2 saw.
    const rows = (manifest.stages.analyse as { candidates: { slug: string; status: string }[] })
      .candidates;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(["ok", "partial", "failed"]).toContain(row.status);
  });

  it("reports progress a stage at a time, and a candidate at a time inside stage 2", async () => {
    const h = harness();
    const events: PipelineEvent[] = [];
    await pipeline(h, { report: (event) => events.push(event) });

    expect(events.filter((e) => e.kind === "stage_started").map((e) => e.stage)).toEqual([
      "source",
      "analyse",
      "memo",
    ]);
    const candidates = events.filter((e) => e.kind === "candidate");
    expect(candidates).toHaveLength(2);
    expect(candidates.map((e) => e.done)).toEqual([1, 2]);
  });

  describe("--replay", () => {
    it("makes no request and produces byte-identical memos", async () => {
      const h = harness();
      await pipeline(h);
      const before = memoFiles(h.root);
      expect(h.urls.length).toBeGreaterThan(0);

      // A fresh clone: the HTTP cache the first run filled is gone, which is
      // the state that used to empty a committed run (ADR-0009).
      const cold = web();

      const model = stubModel();
      const replayed = await pipeline(h, {
        replay: true,
        model,
        http: { ...cold.http, cacheDir: scratch("pipeline-cold-") },
      });

      expect(cold.urls).toEqual([]);
      expect(model.inputs).toEqual([]);
      expect(replayed.analyse.stage.llm.from_cache).toBe(replayed.analyse.stage.llm.calls);
      expect(replayed.analyse.stage.bundles.source).toBe("bundles");
      expect(memoFiles(h.root)).toEqual(before);
    });

    it("records that it was a replay, and that it planned no budget", async () => {
      const h = harness();
      await pipeline(h);
      const outcome = await pipeline(h, { replay: true });

      expect(outcome.stage.flags.replay).toBe(true);
      expect(outcome.analyse.stage.budget).toBeNull();
      // Stage 3 re-rendered from the same analyses, so nothing changed on disk.
      expect(outcome.memo.stage.counts.unchanged).toBe(2);
    });

    it("leaves the run's own manifest records intact — STATE inconsistency 96", async () => {
      const h = harness();
      await pipeline(h);
      const manifest = readManifest(runPaths(RUN_ID, h.root).manifest);
      const run = manifest?.stages.run;
      const analyse = manifest?.stages.analyse;

      await pipeline(h, { replay: true });

      // The documented way to reproduce a committed run must not damage it.
      const after = readManifest(runPaths(RUN_ID, h.root).manifest);
      expect(after?.stages.run).toEqual(run);
      expect(after?.stages.analyse).toEqual(analyse);
      expect(Object.keys(after?.stages ?? {}).sort()).toEqual([
        "analyse",
        "analyse_replay",
        "memo",
        "run",
        "run_replay",
        "source",
      ]);
    });
  });

  describe("a candidate that goes wrong", () => {
    /**
     * SPEC §5, and a correction to how the ticket words it. A provider that
     * will not answer for one candidate does not make that candidate `failed`
     * — `extractFacts` catches it after two attempts and returns `partial`, so
     * an analysis is still written, at the coverage its signals alone support,
     * and a memo is still rendered. `failed` is the narrower case where no
     * analysis exists at all. Both are tolerated; only one of them is common.
     */
    it("does not abort the run, and still writes that candidate a memo", async () => {
      const h = harness();
      // One candidate's extraction throws, every attempt — matched on the
      // record url in the rendered prompt rather than on call order, because
      // call order is concurrency and a retry.
      const failing = stubModel({ fails: (input) => input.includes("https://acme1.dev") });
      const outcome = await pipeline(h, { model: failing });

      expect(outcome.stage.counts.partial).toBe(1);
      expect(outcome.stage.counts.failed).toBe(0);
      expect(outcome.stage.counts.analyses).toBe(2);
      expect(outcome.stage.counts.memos).toBe(2);

      const thin = outcome.analyse.stage.candidates.find((row) => row.status === "partial");
      expect(thin?.reason).toContain("provider said no");
      // The thin one scored lower than the one that was read, which is
      // invariant 4 doing its job rather than a zero being invented.
      const ok = outcome.analyse.stage.candidates.find((row) => row.status === "ok");
      expect(thin?.coverage ?? 1).toBeLessThan(ok?.coverage ?? 0);
    });
  });
});
