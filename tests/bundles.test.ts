import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BundleError,
  bundleStore,
  fromStoredBundle,
  toStoredBundle,
} from "../src/analyse/bundles.js";
import type { Bundle } from "../src/analyse/gather.js";
import {
  BUNDLE_SCHEMA_VERSION,
  CANDIDATE_SCHEMA_VERSION,
  type Candidate,
  type Evidence,
  StoredBundle,
} from "../src/contracts/index.js";
import { evidenceStore, makeEvidence } from "../src/evidence/store.js";

/**
 * TICKET-0028's blocker — STATE inconsistency 84, and 70 with it.
 *
 * The property under test is not "a bundle round-trips"; it is **what a replay
 * can and cannot recover**. Evidence is referenced and comes back out of the
 * store byte-identical; signals, the join, people and failures are derived from
 * payloads the repo does not keep, so they have to survive in the artifact or
 * they are gone. Both halves get a test, and so does every way the artifact can
 * be absent — because the failure this fixes was silent, and a silent failure
 * that comes back is one nobody notices twice.
 */

const AT = "2026-08-23T09:00:00.000Z";
const RUN_ID = "2026-08-23-ai-agent-infrastructure";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bundles-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CANDIDATE: Candidate = {
  schema_version: CANDIDATE_SCHEMA_VERSION,
  slug: "coroot",
  name: "Coroot",
  url: "https://coroot.com/",
  one_liner: "eBPF observability",
  provenance: [
    {
      source: "hn",
      query: "eBPF observability",
      at: AT,
      ref: "41000001",
      title: "Show HN: Coroot",
      posted_url: "https://coroot.com/",
      posted_at: "2026-08-01T09:00:00.000Z",
    },
  ],
};

function record(url: string, text: string): Evidence {
  return makeEvidence({
    url,
    type: "company_site",
    retrieved_at: AT,
    status: 200,
    title: null,
    text,
    meta: {},
  });
}

const HOME = record("https://coroot.com/", "eBPF observability for microservices");
const ABOUT = record("https://coroot.com/about", "Founded by two engineers");

function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    slug: "coroot",
    candidate: CANDIDATE,
    join: {
      site: { url: "https://coroot.com/", from: "candidate_url" },
      github: { ref: { owner: "coroot", repo: "coroot", from: "github.com" }, from: "site_link" },
    },
    evidence: [HOME, ABOUT],
    signals: [
      { key: "github.stars", value: 5321, as_of: AT, evidence_id: HOME.id },
      {
        key: "github.commits_90d",
        value: 214,
        as_of: AT,
        evidence_id: ABOUT.id,
        derived_from: "stats/commit_activity",
      },
    ],
    unknowns: [{ key: "funding.raised_usd", reason: "no funding page" }],
    people: [
      {
        name: "Peter Zaitsev",
        role: "co-founder",
        matched: "role element after name",
        context: "Peter Zaitsev, co-founder",
      },
    ],
    requests: { github: 5, site: 2, hn: 1 },
    failures: [{ pool: "site", url: "https://coroot.com/team", status: 404, reason: "not found" }],
    ...over,
  };
}

/** A store with both records already in it, as the gather that wrote them left it. */
function storeWith(root: string, records: readonly Evidence[] = [HOME, ABOUT]) {
  const store = evidenceStore(RUN_ID, root);
  for (const entry of records) store.write(entry);
  return store;
}

describe("toStoredBundle", () => {
  it("references evidence by id in gather order, and copies no text", () => {
    const stored = toStoredBundle(RUN_ID, bundle(), AT);

    expect(stored.schema_version).toBe(BUNDLE_SCHEMA_VERSION);
    expect(stored.evidence_ids).toEqual([HOME.id, ABOUT.id]);
    // Order is the contract: `bundleItems` is the prompt's input and the LLM
    // cache key hashes it, so a bundle that came back reordered would miss a
    // cache entry it should hit.
    expect(JSON.stringify(stored)).not.toContain("eBPF observability for microservices");
  });

  it("keeps what the store cannot give back — signals, join, people, failures", () => {
    const stored = toStoredBundle(RUN_ID, bundle(), AT);

    expect(stored.signals.map((signal) => signal.key)).toEqual([
      "github.stars",
      "github.commits_90d",
    ]);
    expect(stored.signals[1]?.derived_from).toBe("stats/commit_activity");
    expect(stored.join.github?.ref.owner).toBe("coroot");
    expect(stored.people[0]?.name).toBe("Peter Zaitsev");
    expect(stored.failures[0]?.status).toBe(404);
    expect(stored.requests).toEqual({ github: 5, site: 2, hn: 1 });
  });

  it("refuses to write a bundle that is not one", () => {
    const broken = bundle({ candidate: { ...CANDIDATE, slug: "" } });
    expect(() => toStoredBundle(RUN_ID, broken, AT)).toThrow();
  });
});

describe("fromStoredBundle", () => {
  it("rehydrates the evidence the ids name, in the order they were stored", () => {
    const root = scratch();
    const store = storeWith(root);
    const back = fromStoredBundle(toStoredBundle(RUN_ID, bundle(), AT), store);

    expect(back.evidence.map((entry) => entry.id)).toEqual([HOME.id, ABOUT.id]);
    expect(back.evidence[0]?.text).toBe(HOME.text);
  });

  it("comes back equal to the bundle it was made from", () => {
    const root = scratch();
    const original = bundle();
    const back = fromStoredBundle(toStoredBundle(RUN_ID, original, AT), storeWith(root));

    expect(back).toEqual(original);
  });

  it("leaves an absent derived_from absent rather than undefined", () => {
    const root = scratch();
    const back = fromStoredBundle(toStoredBundle(RUN_ID, bundle(), AT), storeWith(root));

    expect(Object.hasOwn(back.signals[0] ?? {}, "derived_from")).toBe(false);
    expect(back.signals[1]?.derived_from).toBe("stats/commit_activity");
  });

  it("fails the run when the store has lost a record the bundle names", () => {
    const root = scratch();
    // Only one of the two written: a run directory that lost half of itself.
    const store = storeWith(root, [HOME]);

    const error = (() => {
      try {
        fromStoredBundle(toStoredBundle(RUN_ID, bundle(), AT), store);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(BundleError);
    expect((error as BundleError).message).toContain(ABOUT.id);
    expect((error as BundleError).message).toContain("without --replay");
  });
});

describe("bundleStore", () => {
  it("writes runs/<id>/bundles/<slug>.json, and reads it back as a bundle", () => {
    const root = scratch();
    const bundles = bundleStore(RUN_ID, root);
    const written = bundles.write(bundle(), AT);

    expect(written.path).toBe(join(root, RUN_ID, "bundles", "coroot.json"));
    expect(bundles.has("coroot")).toBe(true);
    expect(StoredBundle.parse(JSON.parse(readFileSync(written.path, "utf8"))).slug).toBe("coroot");
    expect(bundles.read("coroot", storeWith(root)).slug).toBe("coroot");
  });

  it("overwrites, unlike an evidence record — a re-gather is a newer look", () => {
    const root = scratch();
    const bundles = bundleStore(RUN_ID, root);
    bundles.write(bundle(), AT);
    const second = bundles.write(bundle({ requests: { github: 1, site: 1, hn: 1 } }), AT);

    expect(second.stored.requests.github).toBe(1);
    expect(bundles.read("coroot", storeWith(root)).requests.github).toBe(1);
  });

  it("names --replay in the message when the run predates bundles", () => {
    const root = scratch();
    const error = (() => {
      try {
        bundleStore(RUN_ID, root).read("coroot", storeWith(root));
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(BundleError);
    expect((error as BundleError).message).toContain("bundles were an artifact");
  });

  it("refuses a file that is not a bundle, naming what did not fit", () => {
    const root = scratch();
    const dir = join(root, RUN_ID, "bundles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "coroot.json"), '{"schema_version":1,"slug":"coroot"}\n');

    const error = (() => {
      try {
        bundleStore(RUN_ID, root).read("coroot", storeWith(root));
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(BundleError);
    expect((error as BundleError).message).toContain("run_id");
  });

  it("refuses a slug that is not a directory-safe name", () => {
    const bundles = bundleStore(RUN_ID, scratch());
    expect(() => bundles.path("../etc")).toThrow(BundleError);
    expect(() => bundles.path("Coroot")).toThrow(BundleError);
  });
});
