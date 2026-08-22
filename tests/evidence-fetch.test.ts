import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Evidence } from "../src/contracts/index.js";
import {
  cacheKey,
  fetchFailedEvidence,
  type HttpFailure,
  type HttpOptions,
  type HttpResult,
  type HttpSuccess,
  httpGet,
  isFetchableUrl,
  retryAfterMs,
  USER_AGENT,
} from "../src/evidence/fetch.js";
import { evidenceId } from "../src/evidence/store.js";

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
