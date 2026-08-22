import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureOne,
  deriveMalformed,
  type FixtureRecord,
  fixtureSpecs,
  MALFORMED_SPEC,
  MAX_FIXTURE_BYTES,
  mergeManifest,
  parseFlags,
} from "../scripts/capture-fixtures.js";
import type { Transport } from "../src/evidence/fetch.js";

/**
 * The runner is the half of TICKET-0014 that needs a network, so everything
 * here drives a stub transport. What is worth testing is not "does fetch work"
 * but the three decisions around it: nothing is written unscanned, a fixture is
 * refreshed on purpose, and provenance is merged rather than replaced.
 */

const NOW = new Date("2026-08-22T09:00:00.000Z");

const stub = (body: string, init: ResponseInit = {}): { transport: Transport; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    transport: (url) => {
      calls.push(url);
      return Promise.resolve(new Response(body, { status: 200, ...init }));
    },
  };
};

const spec = (over: Partial<ReturnType<typeof fixtureSpecs>[number]> = {}) => ({
  path: "github/example.json",
  kind: "json" as const,
  url: "https://api.github.com/users/example",
  note: "example",
  ...over,
});

describe("fixtureSpecs", () => {
  const specs = fixtureSpecs(NOW);

  it("has a unique path per fixture", () => {
    expect(new Set(specs.map((s) => s.path)).size).toBe(specs.length);
  });

  it("is https throughout and never writes outside tests/fixtures", () => {
    for (const s of specs) {
      expect(s.url.startsWith("https://"), s.path).toBe(true);
      expect(s.path).not.toMatch(/^\/|\.\./);
      expect(s.note.length, s.path).toBeGreaterThan(20);
    }
  });

  it("builds hn urls through the adapter, so a fixture matches what the run requests", () => {
    const thin = specs.find((s) => s.path === "hn/search-thin.json");
    expect(thin?.url).toContain("query=eBPF+observability");
    expect(thin?.url).toContain("tags=story");
    // --since 180 from the CLI default, floored to the start of the UTC day.
    expect(thin?.url).toContain("numericFilters=created_at_i%3E1771804800");
  });

  it("carries no credential in any spec — a spec is printable", () => {
    expect(JSON.stringify(specs).toLowerCase()).not.toContain("authorization");
  });
});

describe("captureOne", () => {
  it("normalises json and records provenance", async () => {
    const { transport } = stub('{"login":"coroot","type":"Organization"}', {
      headers: { "content-type": "application/json", "set-cookie": "s=1" },
    });
    const outcome = await captureOne(spec(), { transport, now: () => NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.content).toBe('{\n  "login": "coroot",\n  "type": "Organization"\n}\n');
    expect(outcome.record.status).toBe(200);
    expect(outcome.record.captured_at).toBe(NOW.toISOString());
    expect(outcome.record.bytes).toBe(outcome.content.length);
    expect(outcome.record.headers).toEqual({ "content-type": "application/json" });
  });

  it("records what the extractor gets out of an html page", async () => {
    const { transport } = stub("<!doctype html><title>Coroot</title><body><p>Hello</p></body>");
    const outcome = await captureOne(spec({ path: "sites/x.html", kind: "html" }), {
      transport,
      now: () => NOW,
    });
    expect(outcome.ok && outcome.record.text_chars).toBe("Hello".length);
  });

  it("never reads the http cache — two captures are two requests", async () => {
    const { transport, calls } = stub("{}");
    await captureOne(spec(), { transport, now: () => NOW });
    await captureOne(spec(), { transport, now: () => NOW });
    expect(calls).toHaveLength(2);
  });

  it("fails a fixture whose body is not what its kind says", async () => {
    const { transport } = stub("<!doctype html><title>502 Bad Gateway</title>");
    const outcome = await captureOne(spec(), { transport, now: () => NOW });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toContain("unreadable as json");
  });

  it("fails a fetch rather than writing an error page", async () => {
    const { transport } = stub("not found", { status: 404 });
    const outcome = await captureOne(spec(), { transport, now: () => NOW, retry: { retries: 0 } });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toContain("404");
  });

  it("refuses an oversized page rather than truncating it", async () => {
    const { transport } = stub(`<p>${"x".repeat(MAX_FIXTURE_BYTES)}</p>`);
    const outcome = await captureOne(spec({ path: "sites/big.html", kind: "html" }), {
      transport,
      now: () => NOW,
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/exceeds the \d+ KB cap/);
  });

  it("writes nothing when a body is credential-shaped, and does not echo the secret", async () => {
    const secret = "ghp_0123456789abcdefghijABCDEFGHIJ";
    const { transport } = stub(`{"note":"${secret}"}`);
    const outcome = await captureOne(spec(), { transport, now: () => NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("github-token");
    expect(outcome.reason).not.toContain(secret);
  });
});

describe("deriveMalformed", () => {
  const source = readFileSync(
    join(import.meta.dirname, "fixtures", "hn", "search-page-0.json"),
    "utf8",
  );

  it("reproduces the committed fixture and records that it was not fetched", () => {
    const derived = deriveMalformed(source, NOW);
    expect(derived.content).toBe(
      readFileSync(join(import.meta.dirname, "fixtures", MALFORMED_SPEC.path), "utf8"),
    );
    expect(derived.record.url).toBeNull();
    expect(derived.record.derived_from).toBe("hn/search-page-0.json");
    expect(derived.record.status).toBeNull();
  });
});

describe("mergeManifest", () => {
  const record = (path: string, bytes: number): FixtureRecord => ({
    path,
    kind: "json",
    url: `https://example.com/${path}`,
    note: "n",
    status: 200,
    captured_at: NOW.toISOString(),
    bytes,
    sha256: "0".repeat(64),
  });

  it("keeps the provenance of groups this run did not touch", () => {
    const merged = mergeManifest(
      [record("hn/a.json", 1), record("github/b.json", 2)],
      [record("github/b.json", 99)],
    );
    expect(merged.fixtures.map((f) => [f.path, f.bytes])).toEqual([
      ["github/b.json", 99],
      ["hn/a.json", 1],
    ]);
  });

  it("is sorted by path, so a re-run is a readable diff", () => {
    const merged = mergeManifest([], [record("z.json", 1), record("a.json", 1)]);
    expect(merged.fixtures.map((f) => f.path)).toEqual(["a.json", "z.json"]);
  });
});

describe("parseFlags", () => {
  it("defaults to writing only what is missing", () => {
    expect(parseFlags([])).toEqual({ refresh: false, only: null, dryRun: false });
  });

  it("reads --refresh, --only and --dry-run", () => {
    expect(parseFlags(["--only", "github", "--refresh", "--dry-run"])).toEqual({
      refresh: true,
      only: "github",
      dryRun: true,
    });
  });

  it("refuses an unknown flag and a bare --only", () => {
    expect(() => parseFlags(["--all"])).toThrow(/unknown flag/);
    expect(() => parseFlags(["--only"])).toThrow(/needs a path prefix/);
  });

  it("prints usage for --help", () => {
    expect(() => parseFlags(["--help"])).toThrow(/usage: pnpm capture-fixtures/);
  });
});
