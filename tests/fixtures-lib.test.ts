import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveMalformedPage,
  findSecrets,
  HEADER_ALLOWLIST,
  HN_DEFECTS,
  normaliseHtml,
  normaliseJson,
  pickHeaders,
  sha256,
} from "../scripts/fixtures.js";

const fixture = (...parts: string[]): string =>
  readFileSync(join(import.meta.dirname, "fixtures", ...parts), "utf8");

describe("findSecrets", () => {
  it.each([
    ["github-token", "ghp_0123456789abcdefghijABCDEFGHIJ"],
    ["github-fine-grained-token", "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ"],
    ["anthropic-key", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["openai-key", "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["aws-access-key-id", "AKIAIOSFODNN7EXAMPLE"],
    ["bearer-token", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ"],
  ])("catches a %s in a body", (rule, secret) => {
    const findings = findSecrets(`{"note":"x","value":"${secret}"}`);
    expect(findings.map((f) => f.rule)).toContain(rule);
  });

  it("catches a credential header only at the start of a line", () => {
    expect(findSecrets("authorization: token abc").map((f) => f.rule)).toContain(
      "credential-header",
    );
    // A page that merely talks about the header is not a leak.
    expect(findSecrets("Send an authorization header with your request.")).toEqual([]);
  });

  it("catches an assigned secret whatever the punctuation", () => {
    for (const line of [
      'api_key: "0123456789abcdef01"',
      "apiKey='0123456789abcdef01'",
      "ACCESS_TOKEN=0123456789abcdef01",
      '"private-key": "0123456789abcdef01"',
    ]) {
      expect(findSecrets(line), line).not.toEqual([]);
    }
  });

  it("does not report the match itself, only a fingerprint", () => {
    const secret = "ghp_0123456789abcdefghijABCDEFGHIJ";
    const found = findSecrets(`leaked=${secret}`);
    const serialised = JSON.stringify(found);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(secret.slice(4, 20));
    expect(found[0]?.fingerprint).toMatch(/^\d+b\/[0-9a-f]{8}$/);
  });

  it("fingerprints the same secret identically and different secrets differently", () => {
    const one = findSecrets("ghp_0123456789abcdefghijABCDEFGHIJ")[0]?.fingerprint;
    const same = findSecrets("x ghp_0123456789abcdefghijABCDEFGHIJ")[0]?.fingerprint;
    const other = findSecrets("ghp_zzzzzzzzzzzzzzzzzzzzZZZZZZZZZZ")[0]?.fingerprint;
    expect(one).toBe(same);
    expect(one).not.toBe(other);
  });

  it("is clean over every committed fixture body", () => {
    for (const name of ["search-page-0", "search-page-1", "search-empty", "search-ask-hn"]) {
      expect(findSecrets(fixture("hn", `${name}.json`)), name).toEqual([]);
    }
    expect(findSecrets(fixture("company-site.html"))).toEqual([]);
  });

  it("finds nothing in ordinary prose", () => {
    expect(findSecrets("Coroot is an observability company founded in 2021.")).toEqual([]);
  });
});

describe("pickHeaders", () => {
  it("keeps only the allowlist and lowercases the names", () => {
    expect(
      pickHeaders({
        "Content-Type": "application/json",
        ETag: 'W/"abc"',
        "set-cookie": "session=1",
        "x-served-by": "cache-lhr",
      }),
    ).toEqual({ "content-type": "application/json", etag: 'W/"abc"' });
  });

  it("drops an allowlisted header whose value trips the scan", () => {
    expect(pickHeaders({ etag: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ" })).toEqual({});
  });

  it("names three headers and no credential-carrying one", () => {
    expect([...HEADER_ALLOWLIST]).toEqual(["content-type", "etag", "last-modified"]);
  });
});

describe("normalisation", () => {
  it("re-indents json and keeps the server's key order", () => {
    const out = normaliseJson('{"b":1,"a":{"d":2,"c":3}}');
    expect(out).toBe('{\n  "b": 1,\n  "a": {\n    "d": 2,\n    "c": 3\n  }\n}\n');
  });

  it("is idempotent, so a re-capture of an unchanged response is an empty diff", () => {
    const once = normaliseJson(fixture("hn", "search-empty.json"));
    expect(normaliseJson(once)).toBe(once);
  });

  it("refuses a body that is not json", () => {
    expect(() => normaliseJson("<!doctype html><title>502</title>")).toThrow();
  });

  it("leaves html verbatim apart from a trailing newline", () => {
    expect(normaliseHtml("<p>hi</p>")).toBe("<p>hi</p>\n");
    expect(normaliseHtml("<p>hi</p>\n")).toBe("<p>hi</p>\n");
  });

  it("hashes the text it is given", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("deriveMalformedPage", () => {
  const source = JSON.parse(fixture("hn", "search-page-0.json"));

  it("reproduces the committed malformed fixture byte for byte", () => {
    expect(normaliseJson(JSON.stringify(deriveMalformedPage(source)))).toBe(
      fixture("hn", "search-malformed.json"),
    );
  });

  it("does not mutate the page it was given", () => {
    const before = JSON.stringify(source);
    deriveMalformedPage(source);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("carries one defect per hit, in order", () => {
    expect(HN_DEFECTS.map((d) => d.hit)).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses a page with fewer hits than the defect table needs", () => {
    expect(() => deriveMalformedPage({ hits: [{}, {}] })).toThrow(/hit 2/);
  });

  it("refuses a response with no hits array", () => {
    expect(() => deriveMalformedPage({ nbHits: 0 })).toThrow(/no `hits` array/);
  });
});
