import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_ID_PATTERN, Evidence } from "../src/contracts/index.js";
import {
  EVIDENCE_TEXT_LIMIT,
  type EvidenceStore,
  evidenceId,
  evidenceStore,
  makeEvidence,
  TRUNCATION_MARKER,
  truncateText,
} from "../src/evidence/store.js";

const URL = "https://example.com/about";
const AT = "2026-08-22T10:00:00.000Z";

const roots: string[] = [];

function store(runId = "run-1"): EvidenceStore {
  const root = mkdtempSync(join(tmpdir(), "evidence-"));
  roots.push(root);
  return evidenceStore(runId, root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<Parameters<typeof makeEvidence>[0]> = {}) {
  return makeEvidence({
    url: URL,
    type: "company_site",
    retrieved_at: AT,
    status: 200,
    title: "About",
    text: "Two founders, both ex-Stripe.",
    ...overrides,
  });
}

describe("evidenceId", () => {
  it("is 16 hex characters and matches the contract's pattern", () => {
    expect(evidenceId(URL, AT)).toMatch(EVIDENCE_ID_PATTERN);
  });

  it("is stable for the same url and timestamp", () => {
    expect(evidenceId(URL, AT)).toBe(evidenceId(URL, AT));
  });

  it("differs when either input changes", () => {
    const base = evidenceId(URL, AT);
    expect(evidenceId(`${URL}?x=1`, AT)).not.toBe(base);
    expect(evidenceId(URL, "2026-08-22T10:00:01.000Z")).not.toBe(base);
  });
});

describe("truncateText", () => {
  it("leaves text within the limit untouched", () => {
    const short = "x".repeat(EVIDENCE_TEXT_LIMIT);
    expect(truncateText(short)).toEqual({
      text: short,
      truncated: false,
      original_length: EVIDENCE_TEXT_LIMIT,
    });
  });

  it("cuts to the limit with the marker inside the budget", () => {
    const long = "x".repeat(EVIDENCE_TEXT_LIMIT + 500);
    const cut = truncateText(long);
    expect(cut.truncated).toBe(true);
    expect(cut.original_length).toBe(EVIDENCE_TEXT_LIMIT + 500);
    expect(cut.text.length).toBeLessThanOrEqual(EVIDENCE_TEXT_LIMIT);
    expect(cut.text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe("makeEvidence", () => {
  it("computes the id from url and retrieved_at", () => {
    expect(record().id).toBe(evidenceId(URL, AT));
  });

  it("records truncation in meta even when nothing was cut", () => {
    const kept = record();
    expect(kept.meta.text_truncated).toBe(false);
    expect(kept.meta.text_original_length).toBe("Two founders, both ex-Stripe.".length);

    const cut = record({ text: "y".repeat(EVIDENCE_TEXT_LIMIT + 1) });
    expect(cut.meta.text_truncated).toBe(true);
    expect(cut.meta.text_original_length).toBe(EVIDENCE_TEXT_LIMIT + 1);
    expect(cut.text.length).toBeLessThanOrEqual(EVIDENCE_TEXT_LIMIT);
  });

  it("keeps adapter meta alongside the store's own keys", () => {
    expect(record({ meta: { stars: 412 } }).meta).toMatchObject({
      stars: 412,
      text_truncated: false,
    });
  });

  it("carries a failed fetch as a record, not an absence", () => {
    const failed = record({
      type: "fetch_failed",
      status: 0,
      title: null,
      text: "ENOTFOUND",
    });
    expect(failed.type).toBe("fetch_failed");
    expect(failed.title).toBeNull();
  });

  it("rejects input the contract would reject", () => {
    expect(() => record({ url: "not-a-url" })).toThrow();
  });
});

describe("write", () => {
  it("writes one file per record, named by its id", () => {
    const s = store();
    const evidence = record();
    const result = s.write(evidence);

    expect(result.written).toBe(true);
    expect(result.path).toBe(join(s.dir, `${evidence.id}.json`));
    expect(readdirSync(s.dir)).toEqual([`${evidence.id}.json`]);
  });

  it("round-trips through the Evidence schema", () => {
    const s = store();
    const evidence = record({ meta: { points: 91 } });
    s.write(evidence);
    const onDisk = JSON.parse(readFileSync(s.path(evidence.id), "utf8"));
    expect(Evidence.parse(onDisk)).toEqual(evidence);
  });

  it("is a no-op the second time, not a duplicate", () => {
    const s = store();
    const evidence = record();
    s.write(evidence);
    const before = readFileSync(s.path(evidence.id), "utf8");

    expect(s.write(evidence).written).toBe(false);
    expect(readdirSync(s.dir)).toHaveLength(1);
    expect(readFileSync(s.path(evidence.id), "utf8")).toBe(before);
  });

  it("refuses a record whose id does not address its own content", () => {
    const s = store();
    const forged = { ...record(), id: "0".repeat(16) };
    expect(() => s.write(forged)).toThrow(/does not address its own content/);
    expect(() => readdirSync(s.dir)).toThrow();
  });
});

describe("read", () => {
  it("returns the record it wrote", () => {
    const s = store();
    const evidence = record();
    s.write(evidence);
    expect(s.read(evidence.id)).toEqual({ ok: true, evidence });
  });

  it("misses rather than throws on an unknown id", () => {
    const s = store();
    const result = s.read("a".repeat(16));
    expect(result).toMatchObject({ ok: false, miss: "not_found" });
  });

  it("misses on an id that is not an id, without touching the filesystem", () => {
    const s = store();
    expect(s.read("../../../etc/passwd")).toMatchObject({ ok: false, miss: "not_found" });
    expect(s.read("")).toMatchObject({ ok: false, miss: "not_found" });
  });

  it("distinguishes a file that is not a record from a file that is not there", () => {
    const s = store();
    const evidence = record();
    s.write(evidence);
    writeFileSync(s.path(evidence.id), "{ not json");
    expect(s.read(evidence.id)).toMatchObject({ ok: false, miss: "invalid" });

    writeFileSync(s.path(evidence.id), JSON.stringify({ schema_version: 1 }));
    expect(s.read(evidence.id)).toMatchObject({ ok: false, miss: "invalid" });
  });

  it("rejects a record filed under the wrong id", () => {
    const s = store();
    const evidence = record();
    const wrongName = "b".repeat(16);
    s.write(evidence);
    writeFileSync(s.path(wrongName), JSON.stringify(evidence));
    expect(s.read(wrongName)).toMatchObject({ ok: false, miss: "invalid" });
  });
});
