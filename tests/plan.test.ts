import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUERY_PLAN_SCHEMA_VERSION, QueryPlan } from "../src/contracts/index.js";
import type { HttpOptions } from "../src/evidence/fetch.js";
import {
  type Chooser,
  type Clarifier,
  cleanOption,
  DEFAULT_MIN_HITS,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS_OFFERED,
  PlanError,
  planQuery,
  probeSeed,
  readQueryPlan,
  sanitiseOptions,
  writeQueryPlan,
} from "../src/source/plan.js";

// Every test here is offline (TESTING §4): a stub transport answers the probe,
// and the clarifier and the chooser are injected functions. The url building,
// the classifier and the `httpGet` path under test are the production ones.

const NOW = new Date("2026-08-22T13:45:12.345Z");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plan-test-"));
  llmCalls.clarifier = 0;
  llmCalls.chooser = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `n` hits whose urls classify as company sites, plus `junk` that do not. */
function page(n: number, junk = 0): unknown {
  const hits = [
    ...Array.from({ length: n }, (_, i) => ({
      objectID: `c${i}`,
      title: `Show HN: Acme ${i}`,
      url: `https://acme${i}.dev`,
      points: 40 + i,
      num_comments: 5,
      created_at: "2026-08-01T00:00:00.000Z",
    })),
    ...Array.from({ length: junk }, (_, i) => ({
      objectID: `j${i}`,
      title: `Why observability matters ${i}`,
      url: `https://medium.com/@someone/post-${i}`,
      points: 3,
      num_comments: 0,
      created_at: "2026-08-01T00:00:00.000Z",
    })),
  ];
  return { hits, nbHits: hits.length, page: 0, nbPages: 1 };
}

/** Counts requests so "zero LLM calls" has a sibling assertion for the network. */
function transportFor(response: Response | (() => Response)) {
  const calls: string[] = [];
  const transport = async (url: string): Promise<Response> => {
    calls.push(url);
    return (typeof response === "function" ? response() : response).clone();
  };
  // `cacheDir: ""` disables the cache: these tests are about planning, and a
  // cache hit would make request counting meaningless.
  const http: HttpOptions = { transport, cacheDir: "", retry: { retries: 0 } };
  return { http, calls };
}

/**
 * TESTING §5 asks for the zero-LLM-calls case to be asserted by a stub that
 * fails the test if invoked. `planQuery` catches a clarifier that throws — that
 * is rule 3, a provider outage must not cost the run — so the stub counts
 * instead of throwing, and the count is what the assertion reads.
 */
const llmCalls = { clarifier: 0, chooser: 0 };
const forbiddenClarifier: Clarifier = async () => {
  llmCalls.clarifier += 1;
  return [];
};
const forbiddenChooser: Chooser = async ({ seed }) => {
  llmCalls.chooser += 1;
  return seed;
};

const yes = () => true;
const no = () => false;

describe("probeSeed", () => {
  it("counts usable hits, not every hit the search returned", async () => {
    const { http, calls } = transportFor(json(page(3, 7)));
    const outcome = await probeSeed("llm observability", { http, now: () => NOW });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.probe).toEqual({ hits: 10, usable: 3 });
    expect(outcome.rejected).toHaveLength(7);
    // One request. The probe is meant to be cheap enough to run before the run.
    expect(calls).toHaveLength(1);
  });

  it("probes the raw seed on one page, not the four expansion arms", async () => {
    const { http, calls } = transportFor(json(page(1)));
    await probeSeed("llm observability", { http, now: () => NOW });

    const url = new URL(calls[0] ?? "");
    expect(url.searchParams.get("query")).toBe("llm observability");
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("page")).toBe("0");
  });

  it("passes --since through so it measures the window the run will use", async () => {
    const { http, calls } = transportFor(json(page(1)));
    await probeSeed("x", { http, sinceDays: 180, now: () => NOW });

    const filter = new URL(calls[0] ?? "").searchParams.get("numericFilters") ?? "";
    expect(filter.startsWith("created_at_i>")).toBe(true);
  });

  it("returns a failure rather than throwing when the request dies", async () => {
    const { http } = transportFor(json({ error: "nope" }, 503));
    const outcome = await probeSeed("x", { http, now: () => NOW });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503);
  });

  it("treats a 200 that is not a search response as a failure", async () => {
    const html = new Response("<html>gateway error</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const { http } = transportFor(html);
    const outcome = await probeSeed("x", { http, now: () => NOW });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("unreadable response");
  });

  it("reports an empty result set as zero usable, not as an error", async () => {
    const { http } = transportFor(json({ hits: [], nbHits: 0, page: 0, nbPages: 0 }));
    const outcome = await probeSeed("nobody has posted about this", { http, now: () => NOW });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.probe).toEqual({ hits: 0, usable: 0 });
  });
});

describe("sanitiseOptions", () => {
  it("keeps at most four proposals", () => {
    const many = ["a", "b", "c", "d", "e", "f"];
    expect(sanitiseOptions(many, "seed")).toHaveLength(MAX_OPTIONS_OFFERED);
  });

  it("drops a proposal identical to the seed — the chooser offers that itself", () => {
    expect(sanitiseOptions(["LLM Observability", "tracing for llms"], "llm observability")).toEqual(
      ["tracing for llms"],
    );
  });

  it("dedupes case-insensitively", () => {
    expect(sanitiseOptions(["Tracing SDK", "tracing sdk"], "seed")).toEqual(["Tracing SDK"]);
  });

  it("drops a proposal longer than a query has any business being", () => {
    expect(sanitiseOptions(["x".repeat(MAX_OPTION_LENGTH + 1)], "seed")).toEqual([]);
  });

  it("collapses newlines rather than letting a model write two lines into a url", () => {
    expect(cleanOption("llm tracing\nand metrics")).toBe("llm tracing and metrics");
  });

  it("returns nothing for a non-array, which is what a broken provider returns", () => {
    expect(sanitiseOptions("tracing", "seed")).toEqual([]);
    expect(sanitiseOptions(null, "seed")).toEqual([]);
    expect(sanitiseOptions([1, {}, null], "seed")).toEqual([]);
  });
});

describe("planQuery — the probe path", () => {
  it("passes through with zero LLM calls when the probe meets --min-hits", async () => {
    const { http } = transportFor(json(page(DEFAULT_MIN_HITS)));
    const { plan } = await planQuery("llm observability", {
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("probe");
    expect(plan.chosen).toBe("llm observability");
    expect(plan.clarified).toBe(false);
    expect(plan.options_offered).toEqual([]);
    expect(plan.probe).toEqual({ hits: DEFAULT_MIN_HITS, usable: DEFAULT_MIN_HITS });
    expect(llmCalls).toEqual({ clarifier: 0, chooser: 0 });
  });

  it("treats exactly --min-hits as enough — the threshold is inclusive", async () => {
    const { http } = transportFor(json(page(3)));
    const { plan } = await planQuery("x", {
      minHits: 3,
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("probe");
  });

  it("records the raw seed and continues when the probe request fails", async () => {
    const { http } = transportFor(json({ error: "nope" }, 500));
    const { plan } = await planQuery("llm observability", {
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("probe_failed");
    expect(plan.chosen).toBe("llm observability");
    // No probe ran, so there is no measurement — not a measurement of zero.
    expect(plan.probe).toBeNull();
  });
});

describe("planQuery — the thin path", () => {
  it("uses the raw seed with no TTY and says so", async () => {
    const { http } = transportFor(json(page(2, 5)));
    const { plan } = await planQuery("ai agents for smbs", {
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: no,
    });

    expect(plan.chosen_by).toBe("non-interactive");
    expect(plan.chosen).toBe("ai agents for smbs");
    expect(plan.clarified).toBe(false);
    // The measurement is kept: a reviewer can see the seed was thin and that
    // nobody was there to be asked about it.
    expect(plan.probe).toEqual({ hits: 7, usable: 2 });
  });

  it("takes the same path with a TTY but no clarifier wired (TICKET-0018)", async () => {
    const { http } = transportFor(json(page(2)));
    const { plan } = await planQuery("ai agents for smbs", {
      probe: { http, now: () => NOW },
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("non-interactive");
  });

  it("offers refinements and records the one a person picked", async () => {
    const { http } = transportFor(json(page(1, 4)));
    const seen: { seed: string; sample: unknown[] }[] = [];
    const clarifier: Clarifier = async (input) => {
      seen.push({ seed: input.seed, sample: input.sample });
      return ["bookkeeping bot small business", "invoice automation launch"];
    };
    const chooser: Chooser = async ({ options }) => options[0] ?? "";

    const { plan } = await planQuery("AI agents for SMBs", {
      probe: { http, now: () => NOW },
      clarifier,
      chooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("user");
    expect(plan.clarified).toBe(true);
    expect(plan.chosen).toBe("bookkeeping bot small business");
    expect(plan.options_offered).toEqual([
      "bookkeeping bot small business",
      "invoice automation launch",
    ]);
    // The original survives the exchange: provenance is the whole point of it.
    expect(plan.original_seed).toBe("AI agents for SMBs");
    // The model saw the thin result set, both halves of it (ADR-0008).
    expect(seen[0]?.sample.length).toBe(5);
  });

  it("records chosen_by user when the person kept their own words", async () => {
    const { http } = transportFor(json(page(1)));
    const clarifier: Clarifier = async () => ["a refinement"];
    const chooser: Chooser = async () => "  something they typed  ";

    const { plan } = await planQuery("seed", {
      probe: { http, now: () => NOW },
      clarifier,
      chooser,
      isInteractive: yes,
    });

    expect(plan.chosen).toBe("something they typed");
    expect(plan.chosen_by).toBe("user");
    expect(plan.options_offered).toEqual(["a refinement"]);
  });

  it("falls back to the raw seed when the clarifier throws", async () => {
    const { http } = transportFor(json(page(1)));
    const clarifier: Clarifier = async () => {
      throw new Error("provider is down");
    };

    const { plan } = await planQuery("seed", {
      probe: { http, now: () => NOW },
      clarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("non-interactive");
    expect(plan.chosen).toBe("seed");
  });

  it("falls back when every proposal is junk the sanitiser drops", async () => {
    const { http } = transportFor(json(page(1)));
    const clarifier: Clarifier = async () => ["", "   ", "seed"];

    const { plan } = await planQuery("seed", {
      probe: { http, now: () => NOW },
      clarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("non-interactive");
  });
});

describe("planQuery — the bypasses", () => {
  it("--no-expand uses the seed verbatim and never touches the network", async () => {
    const { http, calls } = transportFor(json(page(50)));
    const { plan } = await planQuery("llm observability", {
      expand: false,
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("no_expand");
    expect(plan.chosen).toBe("llm observability");
    expect(plan.probe).toBeNull();
    expect(calls).toHaveLength(0);
    expect(llmCalls).toEqual({ clarifier: 0, chooser: 0 });
  });

  it("--query-plan uses a hand-written file and never probes", async () => {
    const file = join(dir, "hand.json");
    writeFileSync(file, JSON.stringify({ chosen: "opentelemetry llm tracing" }));
    const { http, calls } = transportFor(json(page(50)));

    const { plan } = await planQuery("llm observability", {
      planFile: file,
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(plan.chosen_by).toBe("query_plan_file");
    expect(plan.chosen).toBe("opentelemetry llm tracing");
    expect(plan.original_seed).toBe("llm observability");
    expect(plan.probe).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("--query-plan keeps a full plan verbatim, including how it was chosen", async () => {
    const file = join(dir, "full.json");
    const original: QueryPlan = {
      schema_version: QUERY_PLAN_SCHEMA_VERSION,
      original_seed: "AI agents for SMBs",
      probe: { hits: 12, usable: 2 },
      clarified: true,
      options_offered: ["bookkeeping bot"],
      chosen: "bookkeeping bot",
      chosen_by: "user",
    };
    writeFileSync(file, JSON.stringify(original));

    const { plan } = await planQuery("anything", { planFile: file });
    expect(plan).toEqual(original);
  });

  it("refuses a plan file from another schema version rather than downgrading it", async () => {
    const file = join(dir, "old.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1, chosen: "x", clarified: false }));

    await expect(planQuery("seed", { planFile: file })).rejects.toBeInstanceOf(PlanError);
  });

  it("refuses a plan file that is not there", async () => {
    await expect(planQuery("seed", { planFile: join(dir, "absent.json") })).rejects.toBeInstanceOf(
      PlanError,
    );
  });

  it("refuses a plan file that is not JSON", async () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, "{ not json");
    await expect(planQuery("seed", { planFile: file })).rejects.toBeInstanceOf(PlanError);
  });
});

describe("planQuery — the artifact", () => {
  it("writes a plan that parses as the contract", async () => {
    const path = join(dir, "run", "query_plan.json");
    const { http } = transportFor(json(page(DEFAULT_MIN_HITS)));

    const result = await planQuery("llm observability", {
      planPath: path,
      probe: { http, now: () => NOW },
    });

    expect(result.path).toBe(path);
    expect(result.replayed).toBe(false);
    const onDisk: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(QueryPlan.safeParse(onDisk).success).toBe(true);
    expect(onDisk).toEqual(result.plan);
  });

  it("never re-plans on replay — an existing plan is the answer", async () => {
    const path = join(dir, "run", "query_plan.json");
    const decided: QueryPlan = {
      schema_version: QUERY_PLAN_SCHEMA_VERSION,
      original_seed: "AI agents for SMBs",
      probe: { hits: 12, usable: 2 },
      clarified: true,
      options_offered: ["bookkeeping bot"],
      chosen: "bookkeeping bot",
      chosen_by: "user",
    };
    writeQueryPlan(path, decided);

    const { http, calls } = transportFor(json(page(50)));
    const result = await planQuery("AI agents for SMBs", {
      planPath: path,
      probe: { http, now: () => NOW },
      clarifier: forbiddenClarifier,
      chooser: forbiddenChooser,
      isInteractive: yes,
    });

    expect(result.replayed).toBe(true);
    expect(result.plan).toEqual(decided);
    // Nothing was searched and nobody was asked a second time.
    expect(calls).toHaveLength(0);
  });

  it("prefers the committed plan over --query-plan and --no-expand", async () => {
    const path = join(dir, "run", "query_plan.json");
    const decided: QueryPlan = {
      schema_version: QUERY_PLAN_SCHEMA_VERSION,
      original_seed: "seed",
      probe: null,
      clarified: false,
      options_offered: [],
      chosen: "the decided query",
      chosen_by: "no_expand",
    };
    writeQueryPlan(path, decided);

    const other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ chosen: "something else" }));

    const { plan } = await planQuery("seed", { planPath: path, planFile: other, expand: false });
    expect(plan.chosen).toBe("the decided query");
  });

  it("refuses to overwrite a plan that is already on disk", () => {
    const path = join(dir, "run", "query_plan.json");
    const plan: QueryPlan = {
      schema_version: QUERY_PLAN_SCHEMA_VERSION,
      original_seed: "seed",
      probe: null,
      clarified: false,
      options_offered: [],
      chosen: "seed",
      chosen_by: "no_expand",
    };
    writeQueryPlan(path, plan);
    expect(() => writeQueryPlan(path, plan)).toThrow(PlanError);
  });

  it("plans in memory when no path is given", async () => {
    const { http } = transportFor(json(page(DEFAULT_MIN_HITS)));
    const result = await planQuery("x", { probe: { http, now: () => NOW } });
    expect(result.path).toBeNull();
  });

  it("reads nothing where there is nothing, rather than throwing", () => {
    expect(readQueryPlan(join(dir, "absent.json"))).toBeNull();
  });

  it("refuses an empty seed", async () => {
    await expect(planQuery("   ")).rejects.toBeInstanceOf(PlanError);
  });
});
