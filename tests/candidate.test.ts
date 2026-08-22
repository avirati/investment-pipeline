import { describe, expect, it } from "vitest";
import { Candidate } from "../src/contracts/index.js";
import {
  cleanTitle,
  deriveName,
  fallbackName,
  looksLikeName,
  MAX_NAME_LENGTH,
  slugFor,
  toCandidates,
} from "../src/source/candidate.js";
import type { HnHit } from "../src/source/hn.js";
import { canonicaliseUrl, type ResolvedSite, type SitePost } from "../src/source/resolve.js";

const AT = "2026-08-22T09:00:00.000Z";
const POSTED_AT = "2026-08-10T11:22:33.000Z";
const CONTEXT = { query: "LLM observability", at: AT };

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

/** A site as `dedupeHits` would have produced it, from a url and its posts. */
function site(url: string, ...posts: Array<Partial<HnHit> & { object_id: string }>): ResolvedSite {
  const canonical = canonicaliseUrl(url);
  if (canonical === null) throw new Error(`test url does not canonicalise: ${url}`);
  const sitePosts: SitePost[] = (posts.length > 0 ? posts : [{ object_id: "1" }]).map((partial) => {
    const full = hit({ url, ...partial });
    return {
      hit: full,
      found_by: ["raw"],
      posted_url: full.url ?? url,
      canonical_url: canonical.canonical_url,
    };
  });
  return {
    key: canonical.key,
    canonical_url: canonical.canonical_url,
    host: canonical.host,
    domain: canonical.domain,
    kind: canonical.key.includes("/") ? "code_repo" : "company_site",
    posts: sitePosts,
  };
}

const named = (url: string, title: string | null) =>
  deriveName(site(url), {
    hit: hit({ object_id: "1", url, title }),
    found_by: ["raw"],
    posted_url: url,
    canonical_url: url,
  });

describe("deriveName — a title is read as a name only when its shape marks one", () => {
  it("takes the head of a Show HN title and the tail as the one-liner", () => {
    expect(
      named("https://acmetraces.dev", "Show HN: Acme Traces – OTel-native LLM tracing"),
    ).toEqual({ name: "Acme Traces", one_liner: "OTel-native LLM tracing", named_by: "title" });
  });

  it.each([
    ["an em dash", "Show HN: Acme — tracing for LLM apps"],
    ["a spaced hyphen", "Show HN: Acme - tracing for LLM apps"],
    ["a colon", "Acme: tracing for LLM apps"],
    ["a pipe", "Acme | tracing for LLM apps"],
    ["a Launch HN prefix and a batch tag", "Launch HN: Acme (YC W24) – tracing for LLM apps"],
  ])("splits on %s", (_case, title) => {
    const derived = named("https://acmetraces.dev", title);
    expect(derived.name).toBe("Acme");
    expect(derived.one_liner).toBe("tracing for LLM apps");
  });

  // Rule 2. A sentence describes the company; it does not name it, and the
  // domain is never wrong where "We Rewrote Our Tracer" would be.
  it.each([
    "We rewrote our tracing pipeline in Rust and it got faster",
    "An open-source alternative to Datadog for LLM calls",
    "How we cut p99 latency by 40%",
  ])("falls back to the domain for a sentence: %j", (title) => {
    const derived = named("https://acmetraces.dev", title);
    expect(derived).toEqual({ name: "acmetraces.dev", one_liner: title, named_by: "domain" });
  });

  it("falls back when there is no separator at all, keeping the title as the one-liner", () => {
    expect(named("https://acmetraces.dev", "Show HN: Tracing that understands prompts")).toEqual({
      name: "acmetraces.dev",
      one_liner: "Tracing that understands prompts",
      named_by: "domain",
    });
  });

  it("falls back when the head is too long to be a name", () => {
    const head = "A".repeat(MAX_NAME_LENGTH + 1);
    expect(named("https://acmetraces.dev", `${head}: tracing`).named_by).toBe("domain");
  });

  it("says nothing rather than guessing when the post has no title", () => {
    expect(named("https://acmetraces.dev", null)).toEqual({
      name: "acmetraces.dev",
      one_liner: "",
      named_by: "domain",
    });
  });

  it("names a repo by owner/repo when its title does not name it", () => {
    expect(
      named("https://github.com/acme/traces", "Our tracing library is now open source"),
    ).toEqual({
      name: "acme/traces",
      one_liner: "Our tracing library is now open source",
      named_by: "domain",
    });
  });

  it("does not split a hyphenated word", () => {
    expect(named("https://acmetraces.dev", "Acme-Traces: re-ranking for traces").name).toBe(
      "Acme-Traces",
    );
  });
});

describe("looksLikeName and cleanTitle", () => {
  it("collapses whitespace and leaves the words alone", () => {
    expect(cleanTitle("  Show HN:   Acme  Traces ")).toBe("Show HN: Acme Traces");
    expect(cleanTitle(null)).toBe("");
  });

  it.each(["Acme", "Acme Traces", "Postgres Language Server", "v0"])("accepts %j", (head) => {
    expect(looksLikeName(head)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["punctuation only", "!!!"],
    ["more words than a name has", "we built a tracer for llm calls"],
    // The documented cost of the sentence-opener rule: a real name that opens
    // with an article falls back to its domain rather than risking a clause.
    ["a name starting with an article", "The Browser Company"],
  ])("rejects %s", (_case, head) => {
    expect(looksLikeName(head)).toBe(false);
  });
});

describe("fallbackName", () => {
  it("is the repository path on a code host and the domain everywhere else", () => {
    expect(fallbackName(site("https://github.com/acme/traces"))).toBe("acme/traces");
    expect(fallbackName(site("https://acmetraces.dev/pricing"))).toBe("acmetraces.dev");
    expect(fallbackName(site("https://acme.github.io"))).toBe("acme.github.io");
  });
});

// F1 — TICKET-0013. The gate produced `torrix-ai/install` and
// `betterdb-inc/monitor` as candidate names: worse than plain, because
// `install` and `monitor` read as the product.
describe("nameFromKey drops a repo slug that is a word rather than a name (F1)", () => {
  it("keeps the owner when the slug is generic", () => {
    // Both real, from the gate's `LLM observability` run. Lowercase because
    // the name is lifted from the dedup key and the key is lowercased for
    // identity — so `BetterDB-inc` prints as `betterdb-inc`. A real loss of
    // fidelity, and cheaper than letting the name and the grouping drift.
    expect(fallbackName(site("https://github.com/torrix-ai/install"))).toBe("torrix-ai");
    expect(fallbackName(site("https://github.com/BetterDB-inc/monitor"))).toBe("betterdb-inc");
  });

  it("keeps the owner when the slug repeats it", () => {
    expect(fallbackName(site("https://github.com/Rocketgraph/rocketgraph"))).toBe("rocketgraph");
  });

  it("keeps a distinctive slug, which is the word that names the thing", () => {
    // Also real, and the reason the list is short: dropping these would lose
    // the only word that tells two repos from one owner apart.
    expect(fallbackName(site("https://github.com/nullswan/bpfsnitch"))).toBe("nullswan/bpfsnitch");
    expect(fallbackName(site("https://github.com/liquidos-ai/AutoAgents"))).toBe(
      "liquidos-ai/autoagents",
    );
    expect(fallbackName(site("https://github.com/yantrikos/yantrikdb-server"))).toBe(
      "yantrikos/yantrikdb-server",
    );
  });

  it("does not touch an ordinary domain", () => {
    expect(fallbackName(site("https://monitor.dev"))).toBe("monitor.dev");
  });
});

describe("slugFor", () => {
  it("slugifies the name, and the fallback when the name has no ASCII in it", () => {
    expect(slugFor("Acme Traces", "acmetraces.dev", new Set())).toBe("acme-traces");
    expect(slugFor("観測", "acmetraces.dev", new Set())).toBe("acmetraces-dev");
    expect(slugFor("観測", "観測", new Set())).toBe("candidate");
  });

  it("takes a numeric suffix on a collision, so two Acmes stay tellable apart", () => {
    const taken = new Set(["acme", "acme-2"]);
    expect(slugFor("Acme", "acme.dev", taken)).toBe("acme-3");
  });

  it("does not reserve the slug it returns — the caller records it after parsing", () => {
    const taken = new Set<string>();
    expect(slugFor("Acme", "acme.dev", taken)).toBe("acme");
    expect(taken.size).toBe(0);
  });
});

describe("toCandidates", () => {
  it("produces a contract-valid candidate per site, in discovery order", () => {
    const { candidates, dropped } = toCandidates(
      [
        site("https://acmetraces.dev", {
          object_id: "41",
          title: "Show HN: Acme Traces – OTel-native LLM tracing",
          created_at: POSTED_AT,
        }),
        site("https://github.com/beta/probe", {
          object_id: "42",
          title: "Probe: trace your agents",
        }),
      ],
      CONTEXT,
    );
    expect(dropped).toEqual([]);
    expect(candidates.map((c) => c.slug)).toEqual(["acme-traces", "probe"]);
    for (const candidate of candidates) {
      expect(Candidate.safeParse(candidate).success).toBe(true);
    }
  });

  // The whole reason the contract was bumped: a collapse must leave a trace.
  it("records every post that pointed at the company, primary first", () => {
    const [candidate] = toCandidates(
      [
        site(
          "https://acmetraces.dev",
          { object_id: "41", title: "Show HN: Acme Traces – tracing", created_at: POSTED_AT },
          { object_id: "40", title: "Acme Traces is now open source" },
        ),
      ],
      CONTEXT,
    ).candidates;
    expect(candidate?.provenance).toHaveLength(2);
    expect(candidate?.provenance.map((p) => p.ref)).toEqual(["41", "40"]);
    expect(candidate?.provenance[0]).toMatchObject({
      source: "hn",
      query: "LLM observability",
      at: AT,
      title: "Show HN: Acme Traces – tracing",
      posted_url: "https://acmetraces.dev",
      posted_at: POSTED_AT,
    });
  });

  // Invariant 4: the run clock is a fact about the run, and writing it into
  // `posted_at` would be inventing a post date the source never gave.
  it("writes a missing post date as null rather than as the run clock", () => {
    const [candidate] = toCandidates([site("https://acmetraces.dev")], CONTEXT).candidates;
    expect(candidate?.provenance[0]?.posted_at).toBeNull();
    expect(candidate?.provenance[0]?.at).toBe(AT);
  });

  it("carries the posted url beside the resolved one, so a redirect is visible", () => {
    const resolved = site("https://acmetraces.dev", { object_id: "41" });
    const posted = "https://acme-traces.launch.page/?utm_source=hn";
    resolved.posts = resolved.posts.map((post) => ({ ...post, posted_url: posted }));
    const [candidate] = toCandidates([resolved], CONTEXT).candidates;
    expect(candidate?.url).toBe("https://acmetraces.dev");
    expect(candidate?.provenance[0]?.posted_url).toBe(
      "https://acme-traces.launch.page/?utm_source=hn",
    );
  });

  it("has no source-native ref for a url-list seed", () => {
    const [candidate] = toCandidates([site("https://acmetraces.dev")], {
      ...CONTEXT,
      source: "url_list",
    }).candidates;
    expect(candidate?.provenance[0]).toMatchObject({ source: "url_list", ref: null });
  });

  it("gives two same-named companies distinct slugs", () => {
    const { candidates } = toCandidates(
      [
        site("https://acme.dev", { object_id: "1", title: "Acme: tracing" }),
        site("https://acme.io", { object_id: "2", title: "Acme: also tracing" }),
      ],
      CONTEXT,
    );
    expect(candidates.map((c) => c.slug)).toEqual(["acme", "acme-2"]);
  });

  // One malformed site is not a dead run, and a dropped one must not push the
  // next real candidate's slug to `-2`.
  it("drops a site that cannot become a candidate and keeps the rest", () => {
    const broken = site("https://acme.dev", { object_id: "1", title: "Acme: tracing" });
    broken.canonical_url = "not-a-url";
    const { candidates, dropped } = toCandidates(
      [broken, site("https://acme.io", { object_id: "2", title: "Acme: also tracing" })],
      CONTEXT,
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.key).toBe("acme.dev");
    expect(candidates.map((c) => c.slug)).toEqual(["acme"]);
  });
});
