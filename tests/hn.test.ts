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
