import { describe, expect, it } from "vitest";
import type { HnHit, SourcedHit } from "../src/source/hn.js";
import {
  canonicaliseUrl,
  classifySite,
  dedupeHits,
  registrableDomain,
  siteKey,
} from "../src/source/resolve.js";

function hit(partial: Partial<HnHit> & { object_id: string }): HnHit {
  return {
    hn_url: `https://news.ycombinator.com/item?id=${partial.object_id}`,
    title: null,
    url: null,
    author: null,
    points: null,
    num_comments: null,
    created_at: null,
    story_text: null,
    tags: ["story"],
    ...partial,
  };
}

function sourced(
  partial: Partial<HnHit> & { object_id: string },
  ...found_by: string[]
): SourcedHit {
  return { hit: hit(partial), found_by: found_by.length > 0 ? found_by : ["raw"] };
}

describe("canonicaliseUrl", () => {
  // TESTING §3's list, one row each, plus the cases the list implies.
  const table: Array<[name: string, input: string, expected: string]> = [
    ["strips a www. prefix", "https://www.acme.dev/", "https://acme.dev"],
    ["upgrades http to https", "http://acme.dev", "https://acme.dev"],
    ["drops a trailing slash", "https://acme.dev/pricing/", "https://acme.dev/pricing"],
    ["keeps the root path empty", "https://acme.dev/", "https://acme.dev"],
    ["drops a directory index", "https://acme.dev/docs/index.html", "https://acme.dev/docs"],
    ["drops a bare index.html", "https://acme.dev/index.html", "https://acme.dev"],
    ["drops utm_ parameters", "https://acme.dev/?utm_source=hn&utm_medium=x", "https://acme.dev"],
    ["drops a ref parameter", "https://acme.dev/?ref=hackernews", "https://acme.dev"],
    ["drops a fragment", "https://acme.dev/docs#install", "https://acme.dev/docs"],
    ["lowercases the host only", "https://ACME.dev/Docs/Install", "https://acme.dev/Docs/Install"],
    ["keeps a meaningful parameter", "https://acme.dev/?plan=team", "https://acme.dev/?plan=team"],
    ["sorts surviving parameters", "https://acme.dev/?b=2&a=1", "https://acme.dev/?a=1&b=2"],
    ["collapses duplicate slashes", "https://acme.dev//docs//api", "https://acme.dev/docs/api"],
    ["drops a trailing dot on the host", "https://acme.dev./", "https://acme.dev"],
    ["drops the https default port", "https://acme.dev:443/x", "https://acme.dev/x"],
    ["keeps a non-default port", "http://acme.dev:8080/x", "https://acme.dev:8080/x"],
    ["trims surrounding whitespace", "  https://acme.dev/  ", "https://acme.dev"],
  ];

  for (const [name, input, expected] of table) {
    it(name, () => {
      expect(canonicaliseUrl(input)?.canonical_url).toBe(expected);
    });
  }

  it("returns null for a url that does not parse, rather than throwing", () => {
    // The input is a url a stranger typed into a submission form: bad data, not
    // a bug in the caller.
    expect(canonicaliseUrl("not a url")).toBeNull();
    expect(canonicaliseUrl("")).toBeNull();
  });

  it("returns null for a non-http scheme", () => {
    expect(canonicaliseUrl("ftp://acme.dev/x")).toBeNull();
    expect(canonicaliseUrl("mailto:hi@acme.dev")).toBeNull();
  });

  it("reports host, domain and path alongside the canonical url", () => {
    const site = canonicaliseUrl("https://www.Docs.acme.co.uk/guide/");
    expect(site).toMatchObject({
      canonical_url: "https://docs.acme.co.uk/guide",
      host: "docs.acme.co.uk",
      domain: "acme.co.uk",
      path: "/guide",
    });
  });
});

describe("registrableDomain", () => {
  const table: Array<[host: string, expected: string]> = [
    ["acme.dev", "acme.dev"],
    ["docs.acme.dev", "acme.dev"],
    ["a.b.c.acme.dev", "acme.dev"],
    ["acme.co.uk", "acme.co.uk"],
    ["blog.acme.co.uk", "acme.co.uk"],
    // Shared deploy hosts: the subdomain is the owner, so it is kept.
    ["tomhudson.github.io", "tomhudson.github.io"],
    ["acme.vercel.app", "acme.vercel.app"],
    ["acme.pages.dev", "acme.pages.dev"],
  ];
  for (const [host, expected] of table) {
    it(`${host} → ${expected}`, () => {
      expect(registrableDomain(host)).toBe(expected);
    });
  }
});

describe("siteKey", () => {
  it("collapses a subdomain onto its apex", () => {
    expect(siteKey("docs.acme.dev", "/guide")).toBe(siteKey("acme.dev", ""));
  });

  it("keys a repository on host, owner and repo", () => {
    expect(siteKey("github.com", "/acme/acme-cli")).toBe("github.com/acme/acme-cli");
    expect(siteKey("github.com", "/acme/acme-cli/blob/main/README.md")).toBe(
      "github.com/acme/acme-cli",
    );
  });

  it("does not collapse two repos from the same org", () => {
    // Deliberate, and the direction the file argues for: a visible duplicate
    // costs one analysis, a wrong collapse deletes a company silently.
    expect(siteKey("github.com", "/acme/one")).not.toBe(siteKey("github.com", "/acme/two"));
  });

  it("keeps every GitHub Pages project distinct", () => {
    expect(siteKey("alice.github.io", "")).not.toBe(siteKey("bob.github.io", ""));
  });
});

describe("classifySite", () => {
  const reject = (url: string) => classifySite(canonicaliseUrl(url) as never);

  it("rejects a link-in-bio host with a reason", () => {
    const verdict = reject("https://about.me/jane");
    expect(verdict.usable).toBe(false);
    expect(verdict.kind).toBe("personal_site");
    expect(verdict.reason).toContain("about.me");
  });

  it("rejects a tilde user directory", () => {
    expect(reject("https://cs.example.org/~jane/project").kind).toBe("personal_site");
  });

  it("rejects an academic host", () => {
    expect(reject("https://web.mit.edu/project").kind).toBe("personal_site");
  });

  it("accepts a startup deployed on a shared host", () => {
    // Narrow on purpose: early companies really do launch from vercel.app, and
    // rejecting one leaves no trace anywhere in the output.
    expect(reject("https://acme.vercel.app").usable).toBe(true);
    expect(reject("https://acme.pages.dev").usable).toBe(true);
  });

  it("accepts an ordinary company site", () => {
    expect(reject("https://acme.dev/pricing").usable).toBe(true);
  });
});

describe("dedupeHits", () => {
  it("collapses two posts about the same company into one site", () => {
    const { sites, rejected } = dedupeHits([
      sourced({ object_id: "1", url: "https://www.acme.dev/?utm_source=hn", points: 12 }, "raw"),
      sourced({ object_id: "2", url: "http://acme.dev/index.html", points: 340 }, "show_hn"),
    ]);
    expect(rejected).toEqual([]);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.posts.map((p) => p.hit.object_id)).toEqual(["2", "1"]);
    expect(sites[0]?.canonical_url).toBe("https://acme.dev");
  });

  it("keeps the highest-scoring post as the primary and both as provenance", () => {
    const { sites } = dedupeHits([
      sourced({ object_id: "low", url: "https://acme.dev", points: 3 }),
      sourced({ object_id: "high", url: "https://docs.acme.dev/guide", points: 300 }),
    ]);
    expect(sites[0]?.posts[0]?.hit.object_id).toBe("high");
    expect(sites[0]?.posts).toHaveLength(2);
    // The url the run will fetch follows the primary post, not discovery order.
    expect(sites[0]?.canonical_url).toBe("https://docs.acme.dev/guide");
  });

  it("breaks a points tie on the earliest post", () => {
    const { sites } = dedupeHits([
      sourced({
        object_id: "later",
        url: "https://acme.dev",
        points: 10,
        created_at: "2026-05-01T00:00:00.000Z",
      }),
      sourced({
        object_id: "first",
        url: "https://acme.dev/x",
        points: 10,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    expect(sites[0]?.posts[0]?.hit.object_id).toBe("first");
  });

  it("ranks a post with no score below one that has a score, without inventing a zero", () => {
    const { sites } = dedupeHits([
      sourced({ object_id: "unknown", url: "https://acme.dev" }),
      sourced({ object_id: "scored", url: "https://acme.dev/x", points: 1 }),
    ]);
    expect(sites[0]?.posts[0]?.hit.object_id).toBe("scored");
    expect(sites[0]?.posts[1]?.hit.points).toBeNull();
  });

  it("records which arms found each post", () => {
    const { sites } = dedupeHits([
      sourced({ object_id: "1", url: "https://acme.dev", points: 5 }, "raw", "launch"),
      sourced({ object_id: "2", url: "https://acme.dev/blog-free-path", points: 4 }, "funding"),
    ]);
    expect(sites[0]?.posts.flatMap((p) => p.found_by)).toEqual(["raw", "launch", "funding"]);
  });

  it("keeps unrelated companies apart", () => {
    const { sites } = dedupeHits([
      sourced({ object_id: "1", url: "https://acme.dev" }),
      sourced({ object_id: "2", url: "https://globex.io" }),
    ]);
    expect(sites).toHaveLength(2);
  });

  it("passes the url classifier's rejections through with their reason", () => {
    const { sites, rejected } = dedupeHits([
      sourced({ object_id: "ask", url: null }),
      sourced({ object_id: "paper", url: "https://arxiv.org/abs/2401.00001" }),
      sourced({ object_id: "site", url: "https://acme.dev" }),
    ]);
    expect(sites).toHaveLength(1);
    expect(rejected.map((r) => r.kind)).toEqual(["no_url", "paper"]);
    for (const entry of rejected) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it("adds the rejections only this layer can make", () => {
    const { rejected } = dedupeHits([sourced({ object_id: "1", url: "https://about.me/jane" })]);
    expect(rejected[0]).toMatchObject({ kind: "personal_site" });
  });

  it("carries the url classifier's kind onto the site", () => {
    const { sites } = dedupeHits([
      sourced({ object_id: "1", url: "https://github.com/acme/cli" }),
      sourced({ object_id: "2", url: "https://acme.dev" }),
    ]);
    expect(sites.map((s) => s.kind)).toEqual(["code_repo", "company_site"]);
  });

  it("returns sites in the order their first post was discovered", () => {
    const { sites } = dedupeHits([
      sourced({ object_id: "1", url: "https://globex.io" }),
      sourced({ object_id: "2", url: "https://acme.dev" }),
      sourced({ object_id: "3", url: "https://globex.io/x", points: 900 }),
    ]);
    expect(sites.map((s) => s.key)).toEqual(["globex.io", "acme.dev"]);
  });

  it("is empty in, empty out", () => {
    expect(dedupeHits([])).toEqual({ sites: [], rejected: [] });
  });
});
