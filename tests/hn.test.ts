import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyHit,
  classifyHits,
  expandQuery,
  HN_HITS_PER_PAGE,
  HN_SEARCH_BY_DATE_ENDPOINT,
  HN_SEARCH_ENDPOINT,
  type HnHit,
  hitTimestamp,
  hnItemUrl,
  hnSearchUrl,
  parseSearchResponse,
  searchHn,
  windowStartUnix,
} from "../src/source/hn.js";

const NOW = new Date("2026-08-22T13:45:12.345Z");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join("tests", "fixtures", "hn", `${name}.json`), "utf8"));
}

describe("hnSearchUrl", () => {
  it("defaults to relevance, stories, and a full page", () => {
    const url = new URL(hnSearchUrl({ query: "llm observability" }, NOW));
    expect(`${url.origin}${url.pathname}`).toBe(HN_SEARCH_ENDPOINT);
    expect(url.searchParams.get("query")).toBe("llm observability");
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("hitsPerPage")).toBe(String(HN_HITS_PER_PAGE));
    expect(url.searchParams.get("page")).toBe("0");
    // No --since means no window, rather than a window silently invented here.
    expect(url.searchParams.get("numericFilters")).toBeNull();
  });

  it("sorts by date against the other endpoint", () => {
    const url = new URL(hnSearchUrl({ query: "x", sort: "date" }, NOW));
    expect(`${url.origin}${url.pathname}`).toBe(HN_SEARCH_BY_DATE_ENDPOINT);
  });

  it("windows by --since as a created_at_i numeric filter", () => {
    const url = new URL(hnSearchUrl({ query: "x", sinceDays: 180 }, NOW));
    const filter = url.searchParams.get("numericFilters") ?? "";
    const [, seconds] = filter.split(">");
    expect(filter.startsWith("created_at_i>")).toBe(true);
    expect(new Date(Number(seconds) * 1000).toISOString()).toBe("2026-02-23T00:00:00.000Z");
  });

  it("floors the window to a UTC day so a same-day re-run builds the same url", () => {
    const morning = new Date("2026-08-22T00:00:01.000Z");
    const evening = new Date("2026-08-22T23:59:59.000Z");
    expect(windowStartUnix(30, morning)).toBe(windowStartUnix(30, evening));
    expect(hnSearchUrl({ query: "x", sinceDays: 30 }, morning)).toBe(
      hnSearchUrl({ query: "x", sinceDays: 30 }, evening),
    );
    // ...and a different day is a different url, or the window would never move.
    expect(windowStartUnix(30, new Date("2026-08-23T00:00:01.000Z"))).not.toBe(
      windowStartUnix(30, morning),
    );
  });

  it("caps hitsPerPage at Algolia's maximum", () => {
    const url = new URL(hnSearchUrl({ query: "x", hitsPerPage: 500 }, NOW));
    expect(url.searchParams.get("hitsPerPage")).toBe(String(HN_HITS_PER_PAGE));
  });

  it("passes tag filters through verbatim, including Algolia's OR syntax", () => {
    const url = new URL(hnSearchUrl({ query: "x", tags: "story,(show_hn,launch_hn)" }, NOW));
    expect(url.searchParams.get("tags")).toBe("story,(show_hn,launch_hn)");
  });

  it("paginates past page 1", () => {
    const url = new URL(hnSearchUrl({ query: "x", page: 3 }, NOW));
    expect(url.searchParams.get("page")).toBe("3");
  });
});

describe("expandQuery", () => {
  it("is deterministic, keeps the raw seed as its first arm, and labels each", () => {
    const arms = expandQuery("  llm observability  ");
    expect(arms).toEqual(expandQuery("llm observability"));
    expect(arms.map((a) => a.label)).toEqual(["raw", "show_hn", "launch", "funding"]);
    expect(arms[0]).toEqual({ label: "raw", query: "llm observability", tags: "story" });
    // Show HN is a tag filter, not a phrasing: the query text is untouched.
    expect(arms[1]).toEqual({
      label: "show_hn",
      query: "llm observability",
      tags: "story,show_hn",
    });
    expect(arms[2]?.query).toBe("llm observability launch");
  });
});

describe("hitTimestamp", () => {
  it("prefers the unix field, which cannot be half-parseable", () => {
    expect(hitTimestamp(1758999378, "yesterday-ish")).toBe("2025-09-27T18:56:18.000Z");
  });

  it("falls back to the ISO string when the unix field is unusable", () => {
    expect(hitTimestamp("1761528923" as unknown as number, "2025-10-27T01:35:23Z")).toBe(
      "2025-10-27T01:35:23.000Z",
    );
    expect(hitTimestamp(undefined, "2025-10-27T01:35:23Z")).toBe("2025-10-27T01:35:23.000Z");
  });

  it("is null when neither field is usable — never today's date", () => {
    expect(hitTimestamp(null, null)).toBeNull();
    expect(hitTimestamp(0, "not a date")).toBeNull();
  });
});

describe("parseSearchResponse", () => {
  it("reads a captured result page and carries the traction signal through", () => {
    const page = parseSearchResponse(fixture("search-page-0"));
    expect(page.page).toBe(0);
    expect(page.nb_pages).toBe(36);
    expect(page.nb_hits).toBe(177);
    expect(page.dropped).toEqual([]);
    expect(page.hits).toHaveLength(5);

    const first = page.hits[0];
    expect(first?.object_id).toBe("45398467");
    expect(first?.points).toBe(144);
    expect(first?.num_comments).toBe(44);
    expect(first?.created_at).toBe("2025-09-27T18:56:18.000Z");
    expect(first?.author).toBe("pranay01");
    expect(first?.url).toBe("https://signoz.io/blog/llm-observability-opentelemetry/");
    expect(first?.hn_url).toBe(hnItemUrl("45398467"));
    expect(first?.tags).toContain("story");
  });

  it("assembles multiple pages into one list, in page order", () => {
    const pages = [fixture("search-page-0"), fixture("search-page-1")].map(parseSearchResponse);
    expect(pages.map((p) => p.page)).toEqual([0, 1]);
    const ids = pages.flatMap((p) => p.hits.map((h) => h.object_id));
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("returns [] for an empty result set rather than throwing", () => {
    const page = parseSearchResponse(fixture("search-empty"));
    expect(page.hits).toEqual([]);
    expect(page.nb_hits).toBe(0);
    expect(page.nb_pages).toBe(0);
  });

  it("keeps null-url text posts, with the thread url still resolvable", () => {
    const page = parseSearchResponse(fixture("search-ask-hn"));
    expect(page.hits).toHaveLength(5);
    expect(page.hits.every((h) => h.url === null)).toBe(true);
    const allThreads = page.hits.every((h) =>
      h.hn_url.startsWith("https://news.ycombinator.com/item?id="),
    );
    expect(allThreads).toBe(true);
    expect(page.hits[0]?.title).toBe("Ask HN: Good LLM Observability Platforms?");
  });

  it("survives malformed hits: dates degrade to null, only the unreadable is dropped", () => {
    const page = parseSearchResponse(fixture("search-malformed"));
    expect(page.hits).toHaveLength(4);

    expect(page.hits[0]?.created_at).toBe("2025-09-27T18:56:18.000Z");
    expect(page.hits[1]?.created_at).toBeNull();
    expect(page.hits[2]?.created_at).toBe("2025-10-27T01:35:23.000Z");
    // Absent is null, not zero — a post with no score did not score nothing.
    expect(page.hits[3]?.points).toBeNull();
    expect(page.hits[3]?.num_comments).toBeNull();

    expect(page.dropped).toHaveLength(1);
    expect(page.dropped[0]?.index).toBe(4);
    expect(page.dropped[0]?.reason).toContain("objectID");
  });

  it("throws only when the payload is not a search response at all", () => {
    expect(() => parseSearchResponse({ hits: "<html>502 Bad Gateway</html>" })).toThrow(
      /not an HN Algolia search response/,
    );
    expect(() => parseSearchResponse(null)).toThrow(/not an HN Algolia search response/);
    // A response with no `hits` key is empty, not broken.
    expect(parseSearchResponse({ nbHits: 0 }).hits).toEqual([]);
  });
});

/** A hit is a shape, not a fixture, when the test is about one field of it. */
function hit(url: string | null, over: Partial<HnHit> = {}): HnHit {
  return {
    object_id: "1",
    hn_url: hnItemUrl("1"),
    title: "Show HN: a thing",
    url,
    author: "someone",
    points: 10,
    num_comments: 2,
    created_at: "2026-08-01T00:00:00.000Z",
    story_text: null,
    tags: ["story", "show_hn"],
    ...over,
  };
}

describe("classifyHit", () => {
  it("accepts a company site", () => {
    const verdict = classifyHit(hit("https://getfluiq.com"));
    expect(verdict).toMatchObject({ usable: true, kind: "company_site", host: "getfluiq.com" });
  });

  it("accepts a repo — for this thesis the repo is the product surface", () => {
    expect(classifyHit(hit("https://github.com/sublingual-ai/sublingual"))).toMatchObject({
      usable: true,
      kind: "code_repo",
    });
    expect(classifyHit(hit("https://someproject.github.io/docs"))).toMatchObject({
      usable: true,
      kind: "code_repo",
    });
  });

  it("rejects a personal blog, wherever it is hosted", () => {
    expect(classifyHit(hit("https://alice.substack.com/p/why-agents"))).toMatchObject({
      usable: false,
      kind: "content",
    });
    expect(classifyHit(hit("https://medium.com/@alice/why-agents-fail-1a2b"))).toMatchObject({
      usable: false,
      kind: "content",
    });
    expect(classifyHit(hit("https://alice.dev/2026/08/why-agents-fail"))).toMatchObject({
      usable: false,
      kind: "content",
    });
  });

  it("rejects a paper, by host or by extension", () => {
    expect(classifyHit(hit("https://arxiv.org/abs/2408.01234"))).toMatchObject({
      usable: false,
      kind: "paper",
    });
    // Extension beats host: a PDF on a company domain is still a paper.
    expect(classifyHit(hit("https://acme.ai/research/scaling.pdf"))).toMatchObject({
      usable: false,
      kind: "paper",
    });
  });

  it("rejects a discussion thread and HN's own urls", () => {
    expect(classifyHit(hit("https://news.ycombinator.com/item?id=1"))).toMatchObject({
      usable: false,
      kind: "aggregator",
    });
    expect(classifyHit(hit("https://www.reddit.com/r/LocalLLaMA/comments/abc/"))).toMatchObject({
      usable: false,
      kind: "aggregator",
    });
  });

  it("rejects a real company's blog post — the post is not the candidate", () => {
    const verdict = classifyHit(hit("https://signoz.io/blog/llm-observability-opentelemetry/"));
    expect(verdict.usable).toBe(false);
    expect(verdict.kind).toBe("content");
    expect(verdict.host).toBe("signoz.io");
  });

  it("rejects a text post with no link, and says so", () => {
    const verdict = classifyHit(hit(null));
    expect(verdict).toMatchObject({ usable: false, kind: "no_url", host: null });
    expect(verdict.reason).toMatch(/no link/);
  });

  it("rejects what it cannot parse instead of throwing", () => {
    expect(classifyHit(hit("not a url"))).toMatchObject({ usable: false, kind: "bad_url" });
    expect(classifyHit(hit("ftp://files.example.com/x"))).toMatchObject({
      usable: false,
      kind: "bad_url",
    });
  });

  it("strips www and matches subdomains, so one host is one verdict", () => {
    expect(classifyHit(hit("https://www.acme.ai/")).host).toBe("acme.ai");
    expect(classifyHit(hit("https://blog.medium.com/x")).kind).toBe("content");
  });

  // F2 and F4 — TICKET-0013. Two real urls from the gate's four topics, one
  // per rule. Both are narrow additions, not a smarter classifier: the gate
  // found the classes, not a general principle.
  it("rejects an ACM paper served from ACM's typesetting vendor (F2)", () => {
    const verdict = classifyHit(
      hit(
        "https://camps.aptaracorp.com/ACM_PMS/PMS/ACM/HCDS25/10/13a8f7c0-0a7e-11f0-ada9-16bb50361d1f/OUT/hcds25-10.html",
      ),
    );
    // Neither `acm.org` nor a `.pdf` extension is in that url, which is how it
    // reached a candidate list in the first place.
    expect(verdict).toMatchObject({ usable: false, kind: "paper" });
  });

  it("rejects a host that announces itself as a blog (F4)", () => {
    // The gate's own url: a personal blog on a domain `PERSONAL_HOSTS` cannot
    // enumerate, with a path `ARTICLE_PATH` cannot see.
    expect(
      classifyHit(hit("https://blog.zmalik.dev/p/who-will-observe-the-observability")),
    ).toMatchObject({
      usable: false,
      kind: "content",
    });
    // Whoever owns it: a company's own blog is not the company's own surface
    // either, which `ARTICLE_PATH` already said about `acme.dev/blog/x`.
    expect(classifyHit(hit("https://blog.acme.dev/launching-traces")).kind).toBe("content");
  });

  it("does not reject a `/p/<slug>` path on its own (F4, deliberately narrower)", () => {
    // The fix as written down also proposed treating `/p/<slug>` as an article.
    // It is one publisher's convention rather than a shape, and a wrong reject
    // leaves no trace anywhere in the output while a wrong accept is visible in
    // a memo. Pinned so the omission is a decision and not an oversight.
    expect(classifyHit(hit("https://acme.dev/p/pricing")).usable).toBe(true);
  });

  it("still accepts a company whose name merely starts with the letters `blog`", () => {
    expect(classifyHit(hit("https://blogstash.dev")).usable).toBe(true);
  });

  it("carries a reason on every rejection — the filter is auditable (ADR-0004)", () => {
    const urls = [null, "not a url", "https://arxiv.org/abs/1", "https://medium.com/@a/b"];
    for (const url of urls) {
      const verdict = classifyHit(hit(url));
      expect(verdict.usable).toBe(false);
      expect(verdict.reason.length).toBeGreaterThan(10);
    }
  });

  it("has a known false positive class, pinned here rather than hidden", () => {
    // A trade blog on its own domain with no article path. The url cannot tell
    // this from a company site, and the classifier errs towards accepting. It
    // is a fixture hit, so TICKET-0013's hand-check will meet it.
    const verdict = classifyHit(
      hit(
        "https://machinelearningmastery.com/llm-observability-tools-for-reliable-ai-applications/",
      ),
    );
    expect(verdict).toMatchObject({ usable: true, kind: "company_site" });
  });
});

describe("classifyHits", () => {
  it("splits a captured result page into the counts the probe threshold reads", () => {
    const page = parseSearchResponse(fixture("search-page-0"));
    const { usable, rejected } = classifyHits(page.hits);

    expect(usable.map((c) => c.hit.url)).toEqual([
      "https://github.com/torrix-ai/install",
      "https://github.com/sublingual-ai/sublingual",
    ]);
    expect(rejected.map((c) => c.classification.kind)).toEqual(["content", "no_url", "content"]);
    expect(usable.length + rejected.length).toBe(page.hits.length);
  });

  it("counts an Ask HN page as zero usable, with a reason on every hit", () => {
    const page = parseSearchResponse(fixture("search-ask-hn"));
    const { usable, rejected } = classifyHits(page.hits);
    expect(usable).toEqual([]);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((c) => c.classification.kind === "no_url")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchHn — the fetch half. Every test here drives a stub transport through
// the real `httpGet`, so url building, pagination and the cache-disabled path
// are the production ones; only the socket is fake (TESTING §4: offline, no key).
// ---------------------------------------------------------------------------

const FIXTURE_PAGE_SIZE = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that answers from a route table keyed by `label:page`, so a test
 * says what each arm's each page returns and nothing depends on call order.
 * An unrouted request is a test bug and says so rather than defaulting to empty.
 */
function router(routes: Record<string, Response | (() => Response)>) {
  const calls: { label: string; page: number; url: string }[] = [];
  const transport = async (url: string): Promise<Response> => {
    const params = new URL(url).searchParams;
    const query = params.get("query") ?? "";
    const tags = params.get("tags") ?? "";
    const label = tags.includes("show_hn")
      ? "show_hn"
      : query.endsWith(" launch")
        ? "launch"
        : query.endsWith(" raises seed funding")
          ? "funding"
          : "raw";
    const page = Number(params.get("page") ?? "0");
    calls.push({ label, page, url });
    const route = routes[`${label}:${page}`] ?? routes.default;
    if (!route) throw new Error(`no fixture routed for ${label}:${page}`);
    const response = typeof route === "function" ? route() : route;
    return response.clone();
  };
  return { transport, calls };
}

function searchOptions(transport: (url: string) => Promise<Response>, over = {}) {
  return {
    hitsPerPage: FIXTURE_PAGE_SIZE,
    now: () => NOW,
    // `cacheDir: ""` disables the on-disk cache: these tests are about
    // pagination, not about the cache, which has its own suite.
    http: { transport, cacheDir: "", retry: { retries: 0 }, sleep: async () => {} },
    ...over,
  };
}

describe("searchHn", () => {
  it("paginates past page 1 and runs all four expansion arms", async () => {
    const { transport, calls } = router({
      "raw:0": json(fixture("search-page-0")),
      "raw:1": json(fixture("search-page-1")),
      default: json(fixture("search-empty")),
    });
    const result = await searchHn("llm observability", searchOptions(transport));

    expect(result.pages_fetched).toBe(5); // raw's two, plus one each for the rest
    expect(result.arms.map((arm) => arm.label)).toEqual(["raw", "show_hn", "launch", "funding"]);
    expect(calls.filter((call) => call.label === "raw").map((call) => call.page)).toEqual([0, 1]);
    expect(result.hits).toHaveLength(10);
    expect(result.failures).toEqual([]);
  });

  it("carries the window and the arm's tags into every url it requests", async () => {
    const { transport, calls } = router({ default: json(fixture("search-empty")) });
    await searchHn("llm observability", searchOptions(transport, { sinceDays: 180 }));

    for (const call of calls) {
      const params = new URL(call.url).searchParams;
      expect(params.get("numericFilters")).toBe(`created_at_i>${windowStartUnix(180, NOW)}`);
    }
    const showHn = calls.find((call) => call.label === "show_hn");
    expect(new URL(showHn?.url ?? "").searchParams.get("tags")).toBe("story,show_hn");
  });

  it("dedups across arms and records every arm that found a hit", async () => {
    const page0 = fixture("search-page-0");
    const { transport } = router({
      "raw:0": json(page0),
      "show_hn:0": json(page0),
      default: json(fixture("search-empty")),
    });
    const result = await searchHn("llm observability", searchOptions(transport));

    expect(result.hits).toHaveLength(FIXTURE_PAGE_SIZE);
    expect(result.hits.every((sourced) => sourced.found_by.length === 2)).toBe(true);
    expect(result.hits[0]?.found_by).toEqual(["raw", "show_hn"]);

    // The arm returned five hits and contributed none: exactly the signal
    // TICKET-0013 needs to decide whether an arm earns its request budget.
    const showHn = result.arms.find((arm) => arm.label === "show_hn");
    expect(showHn?.hits).toBe(FIXTURE_PAGE_SIZE);
    expect(showHn?.new_hits).toBe(0);
  });

  it("returns [] for a seed nobody has posted about, rather than throwing", async () => {
    const { transport } = router({ default: json(fixture("search-empty")) });
    const result = await searchHn("qzxvnowaythisisareal term xyzzy", searchOptions(transport));

    expect(result.hits).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.arms.every((arm) => arm.hits === 0)).toBe(true);
  });

  it("stops an arm at the page count Algolia reports", async () => {
    const single = { ...(fixture("search-page-0") as object), nbPages: 1 };
    const { transport, calls } = router({
      "raw:0": json(single),
      default: json(fixture("search-empty")),
    });
    await searchHn("llm observability", searchOptions(transport));

    expect(calls.filter((call) => call.label === "raw")).toHaveLength(1);
  });

  it("stops an arm on a short page even when nbPages disagrees", async () => {
    // Four hits for a five-hit request: the last page, whatever the count says.
    const page0 = fixture("search-page-0") as { hits: unknown[] };
    const short = { ...page0, hits: page0.hits.slice(0, 4), nbPages: 36 };
    const { transport, calls } = router({
      "raw:0": json(short),
      default: json(fixture("search-empty")),
    });
    await searchHn("llm observability", searchOptions(transport));

    expect(calls.filter((call) => call.label === "raw")).toHaveLength(1);
  });

  it("records a source failure as data and keeps the arms that worked", async () => {
    const { transport } = router({
      "raw:0": json(fixture("search-page-0")),
      "raw:1": json({ error: "boom" }, 500),
      default: json(fixture("search-empty")),
    });
    const result = await searchHn("llm observability", searchOptions(transport));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ label: "raw", page: 1, status: 500 });
    // ARCHITECTURE §5 fails the *run* on a source failure — but that is
    // TICKET-0012's call to make, and it needs page 0's five hits to make it.
    expect(result.hits).toHaveLength(FIXTURE_PAGE_SIZE);
    expect(result.arms).toHaveLength(4);
  });

  it("treats a 200 that is not a search response as a failure, not a crash", async () => {
    const { transport, calls } = router({
      "raw:0": new Response("<html>gateway error</html>", { status: 200 }),
      default: json(fixture("search-empty")),
    });
    const result = await searchHn("llm observability", searchOptions(transport));

    expect(result.failures[0]?.status).toBe(200);
    expect(result.failures[0]?.reason).toMatch(/unreadable response/);
    // The arm stops rather than spending page 1 on the same broken endpoint.
    expect(calls.filter((call) => call.label === "raw")).toHaveLength(1);
    expect(result.arms).toHaveLength(4);
  });

  it("surfaces dropped hits from every page it read", async () => {
    const { transport } = router({
      "raw:0": json(fixture("search-malformed")),
      default: json(fixture("search-empty")),
    });
    const result = await searchHn("llm observability", searchOptions(transport));

    // Four of the malformed fixture's five survive; the one with no objectID
    // is dropped with a reason rather than taking the page down with it.
    expect(result.hits).toHaveLength(4);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBeTruthy();
  });

  it("classifies what it fetched — the probe's number, end to end", async () => {
    const { transport } = router({
      "raw:0": json(fixture("search-page-0")),
      default: json(fixture("search-empty")),
    });
    const result = await searchHn("llm observability", searchOptions(transport));
    const { usable, rejected } = classifyHits(result.hits.map((sourced) => sourced.hit));

    // Two GitHub repos usable; a signoz blog post, an InfoQ article and an
    // Ask HN post rejected. This is the count D-6's threshold is compared to.
    expect(usable).toHaveLength(2);
    expect(rejected.map((entry) => entry.classification.kind).sort()).toEqual([
      "content",
      "content",
      "no_url",
    ]);
  });
});
