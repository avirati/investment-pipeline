import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Evidence } from "../src/contracts/index.js";
import {
  cacheKey,
  extractHtml,
  fetchEvidence,
  fetchFailedEvidence,
  type HttpFailure,
  type HttpOptions,
  type HttpResult,
  type HttpSuccess,
  httpGet,
  isFetchableUrl,
  looksLikeHtml,
  retryAfterMs,
  USER_AGENT,
} from "../src/evidence/fetch.js";
import { EVIDENCE_TEXT_LIMIT, evidenceId } from "../src/evidence/store.js";

const URL_ = "https://example.com/about";
const AT = new Date("2026-08-22T10:00:00.000Z");

const dirs: string[] = [];

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "http-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A transport that replays a queued script and records what it was asked. */
function stub(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    // The last entry repeats, so "always 503" is `stub(down())`.
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (!next) throw new Error("stub transport was given no responses");
    return next.clone();
  };
  return { transport, calls };
}

/** Records sleeps instead of taking them, so a 30s Retry-After costs nothing. */
function clock() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

function options(over: Partial<HttpOptions> = {}): HttpOptions {
  return {
    cacheDir: cacheDir(),
    now: () => AT,
    sleep: async () => {},
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
    ...over,
  };
}

function ok(result: HttpResult): HttpSuccess {
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`);
  return result;
}

function failed(result: HttpResult): HttpFailure {
  if (result.ok) throw new Error(`expected failure, got HTTP ${result.status}`);
  return result;
}

describe("isFetchableUrl", () => {
  it("accepts http and https", () => {
    expect(isFetchableUrl("https://example.com")).toBe(true);
    expect(isFetchableUrl("http://example.com/x?y=1")).toBe(true);
  });

  it("rejects other schemes and non-urls", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com", "/about", "example.com", ""]) {
      expect(isFetchableUrl(url), url).toBe(false);
    }
  });
});

describe("cacheKey", () => {
  it("is stable per url and method, and differs across both", () => {
    expect(cacheKey(URL_)).toBe(cacheKey(URL_));
    expect(cacheKey(`${URL_}?x=1`)).not.toBe(cacheKey(URL_));
    expect(cacheKey(URL_, "HEAD")).not.toBe(cacheKey(URL_, "GET"));
  });
});

describe("retryAfterMs", () => {
  it("reads the seconds form", () => {
    expect(retryAfterMs("120", AT)).toBe(120_000);
    expect(retryAfterMs("0", AT)).toBe(0);
  });

  it("reads the http-date form, relative to now", () => {
    expect(retryAfterMs("Sat, 22 Aug 2026 10:00:30 GMT", AT)).toBe(30_000);
  });

  it("never returns a negative wait for a date in the past", () => {
    expect(retryAfterMs("Sat, 22 Aug 2026 09:00:00 GMT", AT)).toBe(0);
  });

  it("is undefined when absent or unparseable, so ordinary backoff applies", () => {
    expect(retryAfterMs(null, AT)).toBeUndefined();
    expect(retryAfterMs("", AT)).toBeUndefined();
    expect(retryAfterMs("soon", AT)).toBeUndefined();
  });
});

describe("httpGet", () => {
  it("returns the body, status and headers of a 200", async () => {
    const { transport, calls } = stub(
      new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = ok(await httpGet(URL_, options({ transport })));

    expect(result.body).toBe("<html>hi</html>");
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("text/html");
    expect(result.retrieved_at).toBe(AT.toISOString());
    expect(result.from_cache).toBe(false);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("sends a descriptive user-agent", async () => {
    const { transport, calls } = stub(new Response("hi", { status: 200 }));
    await httpGet(URL_, options({ transport }));

    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get("user-agent")).toBe(USER_AGENT);
  });

  it("throws on a url that is not http(s) — that is a caller bug, not a fetch failure", async () => {
    const { transport, calls } = stub(new Response("hi", { status: 200 }));
    await expect(httpGet("file:///etc/passwd", options({ transport }))).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  describe("cache", () => {
    it("serves the second call from disk without a second request", async () => {
      const opts = options({ transport: stub(new Response("first", { status: 200 })).transport });
      const first = ok(await httpGet(URL_, opts));

      const second = stub(new Response("second", { status: 200 }));
      const hit = ok(await httpGet(URL_, { ...opts, transport: second.transport }));

      expect(second.calls).toHaveLength(0);
      expect(hit.body).toBe("first");
      expect(hit.from_cache).toBe(true);
      expect(hit.attempts).toBe(0);
      expect(hit.retrieved_at).toBe(first.retrieved_at);
    });

    it("replays retrieved_at, so a warm cache produces the same evidence id", async () => {
      const opts = options({ transport: stub(new Response("body", { status: 200 })).transport });
      const first = ok(await httpGet(URL_, opts));
      const later = ok(
        await httpGet(URL_, { ...opts, now: () => new Date("2026-08-22T18:00:00.000Z") }),
      );

      expect(evidenceId(later.url, later.retrieved_at)).toBe(
        evidenceId(first.url, first.retrieved_at),
      );
    });

    it("re-fetches an entry older than the max age rather than misdate the run", async () => {
      const opts = options({ transport: stub(new Response("stale", { status: 200 })).transport });
      await httpGet(URL_, opts);

      const fresh = stub(new Response("fresh", { status: 200 }));
      const day = new Date(AT.getTime() + 25 * 60 * 60 * 1000);
      const result = ok(
        await httpGet(URL_, { ...opts, transport: fresh.transport, now: () => day }),
      );

      expect(fresh.calls).toHaveLength(1);
      expect(result.body).toBe("fresh");
      expect(result.retrieved_at).toBe(day.toISOString());
    });

    it("treats a corrupt entry as a miss rather than an error", async () => {
      const dir = cacheDir();
      writeFileSync(join(dir, `${cacheKey(URL_)}.json`), "{ not json");

      const { transport, calls } = stub(new Response("live", { status: 200 }));
      const result = ok(await httpGet(URL_, options({ cacheDir: dir, transport })));

      expect(calls).toHaveLength(1);
      expect(result.body).toBe("live");
    });

    it("caches a 404 — a dead page is a stable fact — but not a 503", async () => {
      const dir = cacheDir();
      await httpGet(URL_, options({ cacheDir: dir, transport: stub(gone()).transport }));
      expect(readdirSync(dir)).toHaveLength(1);

      const other = "https://example.com/down";
      await httpGet(other, options({ cacheDir: dir, transport: stub(down()).transport }));
      expect(readdirSync(dir)).toHaveLength(1);
    });

    it("writes nothing when the cache is disabled", async () => {
      const dir = cacheDir();
      const { transport, calls } = stub(new Response("body", { status: 200 }));
      await httpGet(URL_, options({ cacheDir: "", transport }));
      await httpGet(URL_, options({ cacheDir: "", transport }));

      expect(calls).toHaveLength(2);
      expect(readdirSync(dir)).toHaveLength(0);
    });
  });

  describe("retries", () => {
    it("retries a 429 and returns the response that follows", async () => {
      const { transport, calls } = stub(
        new Response("slow down", { status: 429 }),
        new Response("body", { status: 200 }),
      );
      const result = ok(await httpGet(URL_, options({ transport })));

      expect(calls).toHaveLength(2);
      expect(result.attempts).toBe(2);
      expect(result.body).toBe("body");
    });

    it("waits the server's Retry-After before the next attempt", async () => {
      const { slept, sleep } = clock();
      const { transport } = stub(
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
        new Response("body", { status: 200 }),
      );
      ok(await httpGet(URL_, options({ transport, sleep })));

      expect(slept).toEqual([2000]);
    });

    it("gives up instead of sleeping when Retry-After exceeds the cap", async () => {
      const { slept, sleep } = clock();
      const { transport, calls } = stub(
        new Response("slow down", { status: 429, headers: { "retry-after": "600" } }),
        new Response("body", { status: 200 }),
      );
      const result = failed(
        await httpGet(URL_, options({ transport, sleep, retry: { retries: 3, minTimeout: 0 } })),
      );

      expect(slept).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(result.status).toBe(429);
    });

    it("stops at the retry budget and reports how many attempts it made", async () => {
      const { transport, calls } = stub(down());
      const result = failed(
        await httpGet(URL_, options({ transport, retry: { retries: 2, minTimeout: 0 } })),
      );

      expect(calls).toHaveLength(3);
      expect(result.attempts).toBe(3);
      expect(result.status).toBe(503);
      expect(result.reason).toBe("HTTP 503 after 3 attempts");
    });

    it("does not retry a 404", async () => {
      const { transport, calls } = stub(gone());
      const result = failed(await httpGet(URL_, options({ transport })));

      expect(calls).toHaveLength(1);
      expect(result.status).toBe(404);
      expect(result.reason).toBe("HTTP 404");
    });
  });

  describe("failures", () => {
    it("returns a result rather than throwing when the transport does", async () => {
      const { transport, calls } = stub(new Error("getaddrinfo ENOTFOUND example.com"));
      const result = failed(await httpGet(URL_, options({ transport })));

      expect(calls).toHaveLength(2);
      expect(result.status).toBe(0);
      expect(result.reason).toContain("ENOTFOUND");
      expect(result.reason).toContain("2 attempts");
    });

    it("returns a result when the body cannot be read", async () => {
      const torn = new Response("body", { status: 200 });
      Object.defineProperty(torn, "text", {
        value: async () => {
          throw new Error("terminated");
        },
      });
      const result = failed(await httpGet(URL_, options({ transport: async () => torn })));

      expect(result.status).toBe(200);
      expect(result.reason).toContain("terminated");
    });
  });
});

describe("fetchFailedEvidence", () => {
  it("turns a failure into a valid, addressable fetch_failed record", async () => {
    const { transport } = stub(gone());
    const result = failed(await httpGet(URL_, options({ transport })));
    const evidence = fetchFailedEvidence(result);

    expect(Evidence.safeParse(evidence).success).toBe(true);
    expect(evidence.type).toBe("fetch_failed");
    expect(evidence.id).toBe(evidenceId(URL_, result.retrieved_at));
    expect(evidence.status).toBe(404);
    expect(evidence.title).toBeNull();
    expect(evidence.text).toBe("HTTP 404");
    expect(evidence.meta.attempts).toBe(1);
  });

  it("records a dead host as evidence, not as an absence", async () => {
    const { transport } = stub(new Error("getaddrinfo ENOTFOUND example.com"));
    const evidence = fetchFailedEvidence(failed(await httpGet(URL_, options({ transport }))));

    expect(evidence.status).toBe(0);
    expect(evidence.text).toContain("ENOTFOUND");
  });
});

function gone(): Response {
  return new Response("not found", { status: 404 });
}

function down(): Response {
  return new Response("unavailable", { status: 503 });
}

// --- HTML → text (TICKET-0008, second half) --------------------------------

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "company-site.html"), "utf8");

/** A 200 carrying markup, which is what `fetchEvidence` decides to extract on. */
function page(body = FIXTURE, contentType = "text/html; charset=utf-8"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("extractHtml", () => {
  it("keeps the main content of the committed fixture page", () => {
    const { text } = extractHtml(FIXTURE);

    expect(text).toContain("groups");
    expect(text).toContain("Priya Raghavan");
    expect(text).toContain("Eleven design partners");
  });

  it("strips nav, footer, aside, script and style", () => {
    const { text } = extractHtml(FIXTURE);

    // Chrome that repeats on every page of the site, and would otherwise be
    // extracted once per candidate url and cited as if it said something.
    expect(text).not.toContain("Careers");
    expect(text).not.toContain("Privacy Policy");
    expect(text).not.toContain("Cookie Settings");
    expect(text).not.toContain("© 2026");
    expect(text).not.toContain("newsletter");
    // Source, not prose.
    expect(text).not.toContain("dataLayer");
    expect(text).not.toContain("font-family");
  });

  it("reads the title and the og: tags", () => {
    const { title, meta } = extractHtml(FIXTURE);

    expect(title).toBe("Ravenlake — infrastructure for on-call teams");
    expect(meta.og_title).toBe("Ravenlake");
    expect(meta.og_site_name).toBe("Ravenlake");
    expect(meta.canonical).toBe("https://ravenlake.example/");
    expect(meta.main_selector).toBe("main");
  });

  it("leads the text with the description, because the model reads text not meta", () => {
    const { text } = extractHtml(FIXTURE);

    expect(text.startsWith("Ranked, deduplicated incidents for on-call teams.")).toBe(true);
  });

  it("does not repeat a description the body already contains", () => {
    const same = "We build ranked incident triage.";
    const { text } = extractHtml(
      `<html><head><meta name="description" content="${same}"></head>` +
        `<body><main><p>${same}</p><p>${"x".repeat(300)}</p></main></body></html>`,
    );

    expect(text.split(same)).toHaveLength(2);
  });

  it("separates block elements instead of mashing them into one word", () => {
    const { text } = extractHtml(
      "<body><p>About</p><p>Contact</p><div>Team<br>Careers</div></body>",
    );

    expect(text).toBe("About\nContact\nTeam\nCareers");
  });

  it("collapses tabs, non-breaking spaces and blank lines", () => {
    const { text } = extractHtml("<body><p>a\t\tb&nbsp;&nbsp;c</p><p>  </p><p>d</p></body>");

    expect(text).toBe("a b c\nd");
  });

  describe("choosing the main block", () => {
    const filler = `<p>${"word ".repeat(80)}</p>`;

    it("falls back to body when no main-ish block exists", () => {
      const { text, meta } = extractHtml(`<body><div>${filler}</div></body>`);

      expect(meta.main_selector).toBe("body");
      expect(text).toContain("word");
    });

    it("falls back to body when the main block is an empty client-rendered shell", () => {
      // A marketing site that renders client-side ships `<main id="root"></main>`.
      // Selecting it would extract nothing from a page that does say what the
      // company does — in its server-rendered header.
      const { text, meta } = extractHtml(`<body><header>${filler}</header><main></main></body>`);

      expect(meta.main_selector).toBe("body");
      expect(text).toContain("word");
    });

    it("prefers <main> over the surrounding page", () => {
      const { text, meta } = extractHtml(`<body><div>chrome</div><main>${filler}</main></body>`);

      expect(meta.main_selector).toBe("main");
      expect(text).not.toContain("chrome");
    });
  });

  it("returns empty rather than throwing on markup that is not a page", () => {
    expect(extractHtml("").text).toBe("");
    expect(extractHtml("<<<not html").title).toBeNull();
    expect(extractHtml("<html><head><title>  </title></head></html>").title).toBeNull();
  });

  it("falls back from <title> to og:title to <h1>", () => {
    expect(extractHtml('<head><meta property="og:title" content="Og"></head>').title).toBe("Og");
    expect(extractHtml("<body><h1>Heading</h1></body>").title).toBe("Heading");
  });
});

describe("looksLikeHtml", () => {
  it("believes the content type first", () => {
    expect(looksLikeHtml("{}", "text/html; charset=utf-8")).toBe(true);
    expect(looksLikeHtml("<!doctype html>", "application/json")).toBe(false);
  });

  it("sniffs the body when the content type is absent or plain", () => {
    expect(looksLikeHtml("<!doctype html><html>", undefined)).toBe(true);
    expect(looksLikeHtml('{"hits":[]}', undefined)).toBe(false);
    expect(looksLikeHtml("  <html lang=en>", "text/plain")).toBe(true);
  });
});

describe("fetchEvidence", () => {
  it("turns a company page into a valid, addressable record", async () => {
    const { transport } = stub(page());
    const evidence = await fetchEvidence(URL_, "company_site", options({ transport }));

    expect(Evidence.safeParse(evidence).success).toBe(true);
    expect(evidence.type).toBe("company_site");
    expect(evidence.id).toBe(evidenceId(URL_, evidence.retrieved_at));
    expect(evidence.title).toBe("Ravenlake — infrastructure for on-call teams");
    expect(evidence.text).toContain("Priya Raghavan");
    expect(evidence.text).not.toContain("Privacy Policy");
    expect(evidence.meta.extracted).toBe(true);
    expect(evidence.meta.main_selector).toBe("main");
  });

  it("passes a JSON body through unextracted, for the API adapters", async () => {
    const body = '{"hits":[{"title":"Show HN: Ravenlake"}]}';
    const { transport } = stub(page(body, "application/json"));
    const evidence = await fetchEvidence(URL_, "hn_item", options({ transport }));

    expect(evidence.text).toBe(body);
    expect(evidence.title).toBeNull();
    expect(evidence.meta.extracted).toBe(false);
  });

  it("records a failure as fetch_failed rather than throwing", async () => {
    const { transport } = stub(gone());
    const evidence = await fetchEvidence(URL_, "company_site", options({ transport }));

    expect(evidence.type).toBe("fetch_failed");
    expect(evidence.status).toBe(404);
    expect(evidence.text).toBe("HTTP 404");
  });

  it("gives the same evidence id on a cache hit, so a re-run does not duplicate", async () => {
    const shared = options({ transport: stub(page()).transport });
    const first = await fetchEvidence(URL_, "company_site", shared);
    const { transport, calls } = stub(page("<html><body>different</body></html>"));
    const second = await fetchEvidence(URL_, "company_site", { ...shared, transport });

    expect(calls).toHaveLength(0);
    expect(second.id).toBe(first.id);
    expect(second.meta.from_cache).toBe(true);
  });

  it("truncates an oversized page and says so", async () => {
    const huge = `<body><main><p>${"long ".repeat(4000)}</p></main></body>`;
    const { transport } = stub(page(huge));
    const evidence = await fetchEvidence(URL_, "company_site", options({ transport }));

    expect(evidence.text.length).toBeLessThanOrEqual(EVIDENCE_TEXT_LIMIT);
    expect(evidence.meta.text_truncated).toBe(true);
  });

  it("records where a redirect actually landed without changing the id", async () => {
    const redirected = page();
    Object.defineProperty(redirected, "url", { value: "https://www.example.com/about" });
    const evidence = await fetchEvidence(
      URL_,
      "company_site",
      options({ transport: async () => redirected }),
    );

    expect(evidence.url).toBe(URL_);
    expect(evidence.meta.final_url).toBe("https://www.example.com/about");
  });
});
