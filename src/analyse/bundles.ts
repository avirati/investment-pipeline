import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_SCHEMA_VERSION,
  type StoredBundle,
  StoredBundle as StoredBundleSchema,
} from "../contracts/index.js";
import type { EvidenceStore } from "../evidence/store.js";
import { RUNS_ROOT } from "../run.js";
import type { Bundle } from "./gather.js";

/**
 * `runs/<run_id>/bundles/<slug>.json`, written and read (STATE inconsistencies
 * 70 and 84).
 *
 * This is the seam that makes a replay cost nothing. Before it, `--replay`
 * suspended the HTTP cache's staleness rule and swapped in a transport that
 * refuses — which stops a replay *spending*, and does nothing about a replay
 * on a clone where the cache it was going to read is not there. The record of
 * what was gathered had to be re-derived from the network on every look.
 *
 * Now stage 2a's output is a file like every other stage boundary in this
 * pipeline (ADR-0001), and a replay reads it. The two halves of a bundle are
 * stored differently on purpose:
 *
 * - **Evidence lives in the store**, referenced by id. It is already
 *   content-addressed and already committed, and a second copy inside the
 *   bundle would be a second thing to keep in step.
 * - **Everything the adapters derived** — the join, the signals the rubric
 *   scores, the unknowns, the people, the failures, the request counts — lives
 *   here, because it is computed from payloads the repo does not keep. This is
 *   the part that could not be reconstructed, and it is the reason (c) was the
 *   principled fix rather than committing `.cache/http/`.
 */

/** A run directory that cannot answer a replay. The operator's, so exit 1. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export interface BundleStore {
  readonly run_id: string;
  readonly dir: string;
  path(slug: string): string;
  has(slug: string): boolean;
  /** Serialise and write. `gathered_at` is stamped by the caller's clock. */
  write(bundle: Bundle, gatheredAt: string): { path: string; stored: StoredBundle };
  /** Read one back as a `Bundle`, rehydrating its evidence through `store`. */
  read(slug: string, store: EvidenceStore): Bundle;
}

/** The in-memory bundle as the artifact. Evidence becomes ids, in order. */
export function toStoredBundle(runId: string, bundle: Bundle, gatheredAt: string): StoredBundle {
  return StoredBundleSchema.parse({
    schema_version: BUNDLE_SCHEMA_VERSION,
    run_id: runId,
    slug: bundle.slug,
    gathered_at: gatheredAt,
    candidate: bundle.candidate,
    join: bundle.join,
    evidence_ids: bundle.evidence.map((record) => record.id),
    signals: bundle.signals,
    unknowns: bundle.unknowns,
    people: bundle.people,
    requests: bundle.requests,
    failures: bundle.failures,
  });
}

/**
 * The artifact as a bundle again.
 *
 * A referenced record that is not in the store is fatal for the run rather
 * than for the candidate, and that is the one judgement call in this file. A
 * bundle naming an id the store does not have is not a thin candidate — it is
 * a run directory that has lost half of itself, and every other candidate in
 * it is as likely to be missing something. Failing the whole replay says so
 * once; failing one candidate would say it fifteen times and look like fifteen
 * thin companies.
 */
export function fromStoredBundle(stored: StoredBundle, store: EvidenceStore): Bundle {
  const evidence = stored.evidence_ids.map((id) => {
    const read = store.read(id);
    if (!read.ok) {
      throw new BundleError(
        `bundle '${stored.slug}' cites evidence '${id}' and ${store.dir} ` +
          `${read.miss === "not_found" ? "does not have it" : `cannot read it (${read.miss}: ${read.detail})`} — ` +
          `re-run './pipeline analyse --run ${stored.run_id}' without --replay`,
      );
    }
    return read.evidence;
  });

  return {
    slug: stored.slug,
    candidate: stored.candidate,
    join: stored.join,
    evidence,
    signals: stored.signals.map((signal) =>
      // `exactOptionalPropertyTypes`: an absent `derived_from` has to stay
      // absent rather than become `undefined`, or a read signal stops being a
      // `Signal`.
      signal.derived_from === undefined
        ? {
            key: signal.key,
            value: signal.value,
            as_of: signal.as_of,
            evidence_id: signal.evidence_id,
          }
        : { ...signal, derived_from: signal.derived_from },
    ),
    unknowns: stored.unknowns,
    people: stored.people.map((person) => ({
      ...person,
      // The stored `matched` is a string; the in-memory type is a union of the
      // two rules that can produce a person. Narrowing here rather than in the
      // schema keeps the artifact readable when a third rule is added and an
      // old bundle is replayed against new code.
      matched: person.matched as Bundle["people"][number]["matched"],
    })),
    requests: stored.requests,
    failures: stored.failures,
  };
}

/** Open the bundle directory for one run. Nothing is created until a `write`. */
export function bundleStore(runId: string, root = RUNS_ROOT): BundleStore {
  const dir = join(root, runId, "bundles");

  const path = (slug: string): string => {
    // A slug reaches a `join`, and it comes from stage 1's output rather than
    // from an operator — but `Candidate.slug` is the same kind of value
    // `validateRunId` refuses to sanitise, and for the same reason.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new BundleError(`not a usable candidate slug: '${slug}'`);
    }
    return join(dir, `${slug}.json`);
  };

  return {
    run_id: runId,
    dir,
    path,
    has: (slug) => existsSync(path(slug)),
    write: (bundle, gatheredAt) => {
      const stored = toStoredBundle(runId, bundle, gatheredAt);
      const file = path(stored.slug);
      mkdirSync(dir, { recursive: true });
      // Overwritten rather than write-once, unlike an evidence record: a
      // re-gather of the same candidate is a *newer* look at it, and the ids
      // it names are the ones the analysis beside it will cite.
      writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
      return { path: file, stored };
    },
    read: (slug, store) => {
      const file = path(slug);
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new BundleError(
          `${file} does not exist — this run was gathered before bundles were an ` +
            `artifact, or stage 2 did not finish. Re-run './pipeline analyse --run ${runId}' without --replay`,
        );
      }
      const parsed = StoredBundleSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new BundleError(
          `${file} is not a bundle (schema v${BUNDLE_SCHEMA_VERSION}): ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
      }
      return fromStoredBundle(parsed.data, store);
    },
  };
}
