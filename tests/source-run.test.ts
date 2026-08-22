import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Candidate } from "../src/contracts/index.js";
import type { HttpOptions } from "../src/evidence/fetch.js";
import { readManifest } from "../src/manifest.js";
import { RunError } from "../src/run.js";
import {
  FALLBACK_SINCE_DAYS,
  MIN_CANDIDATE_YIELD,
  rankSites,
  runSource,
  SourceError,
  type SourceStage,
  seedForm,
} from "../src/source/index.js";
import type { ResolvedSite, SitePost } from "../src/source/resolve.js";

// Offline (TESTING §4). One stub transport answers both the Algolia search and
// the per-candidate redirect resolution; everything under test — url building,
// pagination, the classifier, dedup, ranking, the manifest — is production code.

const SEED = "LLM observability";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "source-run-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function searchPage(companies: number, junk = 0, offset = 0): unknown {
  return {
    hits: [
      ...Array.from({ length: companies }, (_, i) => ({
        objectID: `c${offset + i}`,
        title: `Show HN: Acme ${offset + i} – tracing for LLM calls`,
        url: `https://acme${offset + i}.dev`,
        points: 10 + offset + i,
        num_comments: 3,
        created_at: "2026-08-01T00:00:00.000Z",
      })),
      ...Array.from({ length: junk }, (_, i) => ({
        objectID: `j${offset + i}`,
        title: `Ask HN: how do you trace agents? ${i}`,
        points: 1,
        created_at: "2026-08-01T00:00:00.000Z",
      })),
    ],
    nbHits: companies + junk,
    page: 0,
    nbPages: 1,
  };
}

interface StubOptions {
  /** Algolia responses, by call order; the last one repeats. */
  search?: unknown[];
  searchStatus?: number;
  /** Status for a company site request during redirect resolution. */
  siteStatus?: number;
}

function stub(options: StubOptions = {}): { http: HttpOptions; urls: string[] } {
  const { search = [searchPage(12)], searchStatus = 200, siteStatus = 200 } = options;
  const urls: string[] = [];
  let call = 0;
  const transport = async (url: string): Promise<Response> => {
    urls.push(url);
    if (url.startsWith("https://hn.algolia.com")) {
      const body = search[Math.min(call++, search.length - 1)];
      return new Response(JSON.stringify(body), {
        status: searchStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("<html><main>a company</main></html>", {
      status: siteStatus,
      headers: { "content-type": "text/html" },
    });
  };
  // No cache: two tests would otherwise share one temp directory's worth of state.
  return { http: { transport, cacheDir: "", retry: { retries: 0 } }, urls };
}

function stage(root: string, runId: string): SourceStage {
  const manifest = readManifest(join(root, "runs", runId, "manifest.json"));
  return manifest?.stages.source as SourceStage;
}

describe("seedForm", () => {
  it("is a topic unless the seed names a readable file", () => {
    expect(seedForm(SEED)).toBe("topic");
    const list = join(root, "urls.txt");
    writeFileSync(list, "https://acme.dev\n");
    expect(seedForm(list)).toBe("urls");
  });

  it("treats a path that does not exist as a topic rather than failing", () => {
    expect(seedForm("./nope.txt")).toBe("topic");
  });
});

describe("rankSites", () => {
  const site = (key: string, points: number | null, created_at: string | null): ResolvedSite => {
    const post = {
      hit: { object_id: key, points, created_at, title: null, url: `https://${key}` },
      found_by: ["raw"],
      posted_url: `https://${key}`,
      canonical_url: `https://${key}`,
    } as unknown as SitePost;
    return {
      key,
      canonical_url: `https://${key}`,
      host: key,
      domain: key,
      kind: "company_site",
      posts: [post],
    };
  };

  // The finding from the first live run: discovery order spent a --limit 10 on
  // 2-point posts while a 105-point company sat at position 31.
  it("puts the strongest post first, whatever order they were discovered in", () => {
    const ranked = rankSites([
      site("a.dev", 2, null),
      site("b.dev", 105, null),
      site("c.dev", 31, null),
    ]);
    expect(ranked.map((s) => s.key)).toEqual(["b.dev", "c.dev", "a.dev"]);
  });

  it("sorts a site with no points last rather than treating it as zero", () => {
    const ranked = rankSites([site("a.dev", null, null), site("b.dev", 1, null)]);
    expect(ranked.map((s) => s.key)).toEqual(["b.dev", "a.dev"]);
  });

  it("breaks a tie on the earlier post", () => {
    const ranked = rankSites([
      site("late.dev", 5, "2026-08-02T00:00:00.000Z"),
      site("early.dev", 5, "2026-08-01T00:00:00.000Z"),
    ]);
    expect(ranked.map((s) => s.key)).toEqual(["early.dev", "late.dev"]);
  });
});

describe("runSource — the happy path", () => {
  it("writes candidates.jsonl, query_plan.json and manifest.json", async () => {
    const { http } = stub();
    const outcome = await runSource({ seed: SEED, root, http, limit: 5 });

    expect(outcome.run_id).toMatch(/^\d{4}-\d{2}-\d{2}-llm-observability$/);
    expect(outcome.candidates).toHaveLength(5);

    const lines = readFileSync(outcome.paths.candidates, "utf8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(Candidate.safeParse(JSON.parse(line)).success).toBe(true);

    const plan = JSON.parse(readFileSync(outcome.paths.queryPlan, "utf8"));
    expect(plan.chosen).toBe(SEED);

    const manifest = readManifest(outcome.paths.manifest);
    expect(manifest?.run_id).toBe(outcome.run_id);
    expect(manifest?.seed).toEqual({ form: "topic", value: SEED });
    // The ticket's acceptance: an output can always be tied to the code that made it.
    expect(manifest?.git.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("cuts to --limit before resolving, so resolution is one request per candidate", async () => {
    const { http, urls } = stub({ search: [searchPage(40)] });
    await runSource({ seed: SEED, root, http, limit: 4 });
    const siteRequests = urls.filter((url) => !url.startsWith("https://hn.algolia.com"));
    expect(siteRequests).toHaveLength(4);
  });

  it("ranks before it cuts, so --limit keeps the strongest posts", async () => {
    const { http } = stub({ search: [searchPage(20)] });
    const outcome = await runSource({ seed: SEED, root, http, limit: 3 });
    // searchPage gives acme<i> 10+i points, so the last three are the strongest.
    expect(outcome.candidates.map((c) => c.name)).toEqual(["Acme 19", "Acme 18", "Acme 17"]);
  });

  it("records the run in the manifest — flags, arms, counts and per-candidate status", async () => {
    const { http } = stub();
    const outcome = await runSource({ seed: SEED, root, http, limit: 5, sinceDays: 90 });
    const source = stage(root, outcome.run_id);
    expect(source.flags).toMatchObject({ limit: 5, since_days: 90, expand: true, replay: false });
    expect(source.query?.chosen_by).toBe("probe");
    expect(source.search?.arms.map((arm) => arm.label)).toEqual([
      "raw",
      "show_hn",
      "launch",
      "funding",
    ]);
    expect(source.counts.candidates).toBe(5);
    expect(source.candidates[0]).toMatchObject({ status: "ok", http_status: 200 });
    expect(source.resolve).toMatchObject({ requests: 5 });
  });

  it("records an unreachable candidate as coverage lost, not as a rejection", async () => {
    const { http } = stub({ siteStatus: 404 });
    const outcome = await runSource({ seed: SEED, root, http, limit: 2 });
    const source = stage(root, outcome.run_id);
    expect(outcome.candidates).toHaveLength(2);
    expect(source.resolve?.unreachable).toBe(2);
    expect(source.candidates.every((c) => c.status === "unreachable")).toBe(true);
  });
});

describe("runSource — the run directory", () => {
  it("refuses to overwrite an existing run (ADR-0001)", async () => {
    const { http } = stub();
    await runSource({ seed: SEED, root, http, runId: "sample-run" });
    await expect(runSource({ seed: SEED, root, http, runId: "sample-run" })).rejects.toThrow(
      RunError,
    );
  });

  it("reuses the run and its decided plan on a replay, without asking again", async () => {
    const { http } = stub();
    const first = await runSource({ seed: SEED, root, http, runId: "sample-run", limit: 2 });
    const again = await runSource({
      seed: SEED,
      root,
      http,
      runId: "sample-run",
      limit: 2,
      replay: true,
    });
    expect(again.plan).toEqual(first.plan);
    expect(stage(root, "sample-run").query?.replayed).toBe(true);
  });

  it("rejects a run id that is not a directory name", async () => {
    const { http } = stub();
    await expect(runSource({ seed: SEED, root, http, runId: "../escape" })).rejects.toThrow(
      RunError,
    );
  });
});

describe("runSource — failure policy (ARCHITECTURE §5)", () => {
  it("fails the run when every source request failed", async () => {
    const { http } = stub({ searchStatus: 500 });
    await expect(runSource({ seed: SEED, root, http })).rejects.toMatchObject({
      name: "SourceError",
      failure: "source_dead",
    });
  });

  it("fails the run when the source answered with nothing", async () => {
    const { http } = stub({ search: [{ hits: [], nbHits: 0, page: 0, nbPages: 0 }] });
    await expect(runSource({ seed: SEED, root, http })).rejects.toMatchObject({
      failure: "no_hits",
    });
  });

  it("fails when every hit was rejected before dedup", async () => {
    const { http } = stub({ search: [searchPage(0, 6)] });
    await expect(runSource({ seed: SEED, root, http })).rejects.toBeInstanceOf(SourceError);
  });

  // A failed run still has to be inspectable: the manifest says what happened.
  it("writes the manifest before it fails", async () => {
    const { http } = stub({ searchStatus: 500 });
    await expect(runSource({ seed: SEED, root, http, runId: "dead-run" })).rejects.toThrow();
    const source = stage(root, "dead-run");
    expect(source.counts.candidates).toBe(0);
    expect(source.search?.failures.length).toBeGreaterThan(0);
  });

  // One page failing among eight is not a dead source (inconsistency 24).
  it("keeps going when only some pages failed", async () => {
    let call = 0;
    const transport = async (url: string): Promise<Response> => {
      if (!url.startsWith("https://hn.algolia.com"))
        return new Response("<html></html>", { status: 200 });
      call += 1;
      if (call === 2) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify(searchPage(12)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const http: HttpOptions = { transport, cacheDir: "", retry: { retries: 0 } };
    const outcome = await runSource({ seed: SEED, root, http, limit: 3 });
    expect(outcome.candidates).toHaveLength(3);
    expect(stage(root, outcome.run_id).search?.failures).toHaveLength(1);
  });
});

describe("runSource — the thin-yield fallback", () => {
  it("widens the window and records that it fired", async () => {
    // Five thin responses cover the probe and the four arms; the sixth (which
    // repeats) is the widened window, so only the fallback sees a full page.
    const thin = Array.from({ length: 5 }, () => searchPage(3));
    const { http, urls } = stub({ search: [...thin, searchPage(14, 0, 100)] });
    const outcome = await runSource({ seed: SEED, root, http, limit: 20, sinceDays: 180 });
    const source = stage(root, outcome.run_id);
    expect(source.fallback).toMatchObject({
      fired: true,
      from_days: 180,
      to_days: FALLBACK_SINCE_DAYS,
    });
    expect(source.fallback?.sites_before).toBeLessThan(MIN_CANDIDATE_YIELD);
    // The widened window is in the url, not just in the manifest.
    const windows = urls.filter((url) => url.includes("created_at_i"));
    expect(windows.length).toBeGreaterThan(0);
  });

  it("says null rather than fired:false when the yield was fine", async () => {
    const { http } = stub({ search: [searchPage(20)] });
    const outcome = await runSource({ seed: SEED, root, http });
    expect(stage(root, outcome.run_id).fallback).toBeNull();
  });
});

describe("runSource — --no-expand", () => {
  // Inconsistency 31, decided here: the flag's help says "the raw seed
  // verbatim", so it cuts the four arms as well as the planning.
  it("searches one arm and skips the probe", async () => {
    const { http } = stub();
    const outcome = await runSource({ seed: SEED, root, http, expand: false, limit: 2 });
    const source = stage(root, outcome.run_id);
    expect(source.search?.arms.map((arm) => arm.label)).toEqual(["raw"]);
    expect(source.query?.chosen_by).toBe("no_expand");
    expect(source.query?.probe).toBeNull();
  });
});

describe("runSource — the urls seed form", () => {
  function list(body: string): string {
    const path = join(root, "urls.txt");
    writeFileSync(path, body);
    return path;
  }

  it("builds candidates from a url list, with no network at all", async () => {
    const { http, urls } = stub();
    const path = list("# companies\n\nhttps://acme.dev\nhttps://beta.io/product\n");
    const outcome = await runSource({ seed: path, root, http });
    expect(outcome.candidates.map((c) => c.name)).toEqual(["acme.dev", "beta.io"]);
    expect(outcome.candidates[0]?.provenance[0]).toMatchObject({ source: "url_list", ref: null });
    expect(urls).toHaveLength(0);
    expect(outcome.plan).toBeNull();
  });

  it("collapses two lines pointing at one company into one candidate", async () => {
    const { http } = stub();
    const path = list("https://acme.dev\nhttps://www.acme.dev/pricing?utm_source=x\n");
    const outcome = await runSource({ seed: path, root, http });
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]?.provenance).toHaveLength(2);
  });

  it("rejects a line the classifier would have rejected from HN", async () => {
    const { http } = stub();
    const path = list("https://medium.com/@someone/post\nhttps://acme.dev\n");
    const outcome = await runSource({ seed: path, root, http });
    expect(outcome.candidates.map((c) => c.name)).toEqual(["acme.dev"]);
    expect(stage(root, outcome.run_id).filter.rejected_posts).toBe(1);
  });

  it("fails the run when no line survives", async () => {
    const { http } = stub();
    const path = list("not-a-url\nhttps://medium.com/@someone/post\n");
    await expect(runSource({ seed: path, root, http })).rejects.toMatchObject({
      failure: "no_candidates",
    });
  });
});
