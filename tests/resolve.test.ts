import { describe, expect, it } from "vitest";
import type { HnHit, SourcedHit } from "../src/source/hn.js";
import {
  canonicaliseUrl,
  classifySite,
  dedupeHits,
  registrableDomain,
  resolveSites,
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

// ---------------------------------------------------------------------------
// The network half. A stub transport, a temp cache dir and a fixed clock, so
// this runs offline on a fresh clone like the rest of the suite.
// ---------------------------------------------------------------------------

/** A transport that answers by url: a status, and where the response came from. */
function router(routes: Record<string, { status?: number; finalUrl?: string }>) {
  const asked: string[] = [];
  const transport = async (url: string): Promise<Response> => {
    asked.push(url);
    const route = routes[url];
    if (!route) throw new Error(`no route for ${url}`);
    // `Response.url` is read-only, so redirect landings are faked the way the
    // platform does: construct, then define the property.
    const response = new Response("<html><title>x</title></html>", {
      status: route.status ?? 200,
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(response, "url", { value: route.finalUrl ?? url });
    return response;
  };
  return { transport, asked };
}

function http(routes: Record<string, { status?: number; finalUrl?: string }>) {
  const { transport, asked } = router(routes);
  return {
    asked,
    options: {
      http: {
        transport,
        // No cache: these tests are about redirects, not about caching, and a
        // shared directory would leak state between them.
        cacheDir: "",
        retry: { retries: 0 },
        now: () => new Date("2026-08-22T10:00:00.000Z"),
        sleep: async () => {},
      },
    },
  };
}

describe("resolveSites", () => {
  it("leaves a site alone when the server answers where it was asked", async () => {
    const { sites: input } = dedupeHits([sourced({ object_id: "1", url: "https://acme.dev" })]);
    const { options } = http({ "https://acme.dev": {} });
    const { sites, rejected } = await resolveSites(input, options);
    expect(rejected).toEqual([]);
    expect(sites[0]?.canonical_url).toBe("https://acme.dev");
    expect(sites[0]?.resolution).toMatchObject({
      redirected: false,
      rekeyed: false,
      status: 200,
      reason: null,
    });
  });

  it("follows a redirect within one key without re-keying", async () => {
    // Canonicalisation had already collapsed `launch.acme.dev` onto its apex,
    // so this redirect changes the url the run fetches and nothing else.
    const { sites: input } = dedupeHits([
      sourced({ object_id: "1", url: "https://launch.acme.dev/hn" }),
    ]);
    const { options } = http({
      "https://launch.acme.dev/hn": { finalUrl: "https://www.acme.dev/?utm_source=hn" },
    });
    const { sites } = await resolveSites(input, options);
    expect(sites[0]?.key).toBe("acme.dev");
    expect(sites[0]?.canonical_url).toBe("https://acme.dev");
    expect(sites[0]?.resolution).toMatchObject({
      requested_url: "https://launch.acme.dev/hn",
      resolved_url: "https://acme.dev",
      redirected: true,
      rekeyed: false,
    });
  });

  it("re-keys a site onto a different company's domain when the redirect crosses one", async () => {
    const { sites: input } = dedupeHits([sourced({ object_id: "1", url: "https://tryacme.com" })]);
    const { options } = http({ "https://tryacme.com": { finalUrl: "https://acme.dev/" } });
    const { sites } = await resolveSites(input, options);
    expect(sites[0]?.key).toBe("acme.dev");
    expect(sites[0]?.host).toBe("acme.dev");
    expect(sites[0]?.resolution).toMatchObject({ redirected: true, rekeyed: true });
  });

  it("merges two sites that redirect to the same place, keeping both posts", async () => {
    // The failure this ticket exists to prevent: nothing in either url says
    // these are the same company until the redirect is followed.
    const { sites: input } = dedupeHits([
      sourced({ object_id: "old", url: "https://acme-labs.io", points: 20 }),
      sourced({ object_id: "new", url: "https://tryacme.com", points: 400 }),
    ]);
    expect(input).toHaveLength(2);
    const { options } = http({
      "https://acme-labs.io": { finalUrl: "https://acme.dev/" },
      "https://tryacme.com": { finalUrl: "https://acme.dev/" },
    });
    const { sites } = await resolveSites(input, options);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.key).toBe("acme.dev");
    // Re-ranked across the merge, so the strongest post of either group leads.
    expect(sites[0]?.posts.map((p) => p.hit.object_id)).toEqual(["new", "old"]);
  });

  it("rejects a site that lands somewhere the url classifier would have rejected", async () => {
    const { sites: input } = dedupeHits([sourced({ object_id: "1", url: "https://acme.link/x" })]);
    const { options } = http({
      "https://acme.link/x": { finalUrl: "https://medium.com/@jane/we-built-a-thing" },
    });
    const { sites, rejected } = await resolveSites(input, options);
    expect(sites).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.kind).toBe("content");
    expect(rejected[0]?.reason).toContain("redirected to");
  });

  it("rejects a redirect onto a personal host with this layer's own reason", async () => {
    const { sites: input } = dedupeHits([sourced({ object_id: "1", url: "https://acme.link/y" })]);
    const { options } = http({ "https://acme.link/y": { finalUrl: "https://about.me/jane" } });
    const { rejected } = await resolveSites(input, options);
    expect(rejected[0]?.kind).toBe("personal_site");
  });

  it("keeps a site whose request failed, with the reason on its resolution", async () => {
    // A company that 403s a bot user-agent is still a company. The evidence
    // fetch records the failure with a citation (ARCHITECTURE §5).
    const { sites: input } = dedupeHits([sourced({ object_id: "1", url: "https://acme.dev" })]);
    const { options } = http({ "https://acme.dev": { status: 403 } });
    const { sites, rejected } = await resolveSites(input, options);
    expect(rejected).toEqual([]);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.canonical_url).toBe("https://acme.dev");
    expect(sites[0]?.resolution).toMatchObject({ status: 403, redirected: false, rekeyed: false });
    expect(sites[0]?.resolution.reason).toContain("403");
  });

  it("rejects every post in a group it rejects, not just the primary", async () => {
    const { sites: input } = dedupeHits([
      sourced({ object_id: "a", url: "https://acme.link/z", points: 5 }),
      sourced({ object_id: "b", url: "https://acme.link/z?utm_source=hn", points: 9 }),
    ]);
    expect(input).toHaveLength(1);
    const { options } = http({ "https://acme.link/z": { finalUrl: "https://arxiv.org/abs/1" } });
    const { rejected } = await resolveSites(input, options);
    expect(rejected.map((r) => r.hit.object_id).sort()).toEqual(["a", "b"]);
  });

  it("makes one request per site, not per post", async () => {
    const { sites: input } = dedupeHits([
      sourced({ object_id: "1", url: "https://acme.dev" }),
      sourced({ object_id: "2", url: "https://www.acme.dev/pricing/" }),
      sourced({ object_id: "3", url: "https://globex.io" }),
    ]);
    const { options, asked } = http({ "https://acme.dev": {}, "https://globex.io": {} });
    await resolveSites(input, options);
    expect(asked).toEqual(["https://acme.dev", "https://globex.io"]);
  });

  it("is empty in, empty out, and makes no request", async () => {
    const { options, asked } = http({});
    expect(await resolveSites([], options)).toEqual({ sites: [], rejected: [] });
    expect(asked).toEqual([]);
  });
});
