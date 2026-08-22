/**
 * What stage 2's adapters emit alongside evidence (TICKET-0015, extracted here
 * in TICKET-0016 so both adapters share one definition rather than two that
 * drift). Nothing in this file talks to a network or knows what a repository or
 * a company page is: it is the shape a dated, citable metric has, and the one
 * function that is allowed to produce one.
 *
 * The rule it exists to hold is CLAUDE.md invariant 4 — missing data lowers
 * coverage and never becomes a zero — and SPEC D3's corollary that an undated
 * claim scores 0, which makes an undated metric a trap rather than merely
 * useless. `collector` is the only way a metric leaves an adapter, so both are
 * structural rather than remembered.
 */

/** Atoms, like `Fact.value`: a metric is a number, a name or a flag. */
export type SignalValue = string | number | boolean;

/**
 * One dated, citable metric. Not a `Fact` — a fact is the model's output
 * surface and carries a statement and a confidence (`src/contracts/fact.ts`).
 * This is the mechanical layer underneath: read off an API payload or computed
 * from one by arithmetic, with no model involved and nothing to be confident
 * about. TICKET-0021's rubric is what turns these into a score.
 */
export interface Signal {
  /** What the rubric switches on, e.g. `github.stars`. */
  key: string;
  value: SignalValue;
  /**
   * When this was true. Rule 1: SPEC D3 scores an undated claim at 0, so every
   * metric leaves here pinned to a moment. For an observation — a star count —
   * that is the moment it was retrieved, which is also what makes a re-run over
   * a warm cache reproduce the same numbers rather than drifting.
   */
  as_of: string;
  /** The record this was read off. Every signal resolves to a citation. */
  evidence_id: string;
  /** Set when the number was computed rather than read. */
  derived_from?: string;
}

/** A metric that could not be produced, and why. Never a zero (invariant 4). */
export interface UnknownSignal {
  key: string;
  reason: string;
}

export interface SignalSet {
  signals: Signal[];
  unknowns: UnknownSignal[];
}

/**
 * Collect signals for one evidence record. `add` is the only way a metric gets
 * out of this module, which is how rule 1 stays structural rather than
 * remembered: a value that is null, blank or not a finite number becomes an
 * `unknown` with a reason instead of a signal.
 */
export function collector(evidenceId: string, at: string) {
  const signals: Signal[] = [];
  const unknowns: UnknownSignal[] = [];

  const add = (
    key: string,
    value: SignalValue | null | undefined,
    missing: string,
    derivedFrom?: string,
  ): void => {
    const empty =
      value === null ||
      value === undefined ||
      value === "" ||
      (typeof value === "number" && !Number.isFinite(value));
    if (empty) {
      unknowns.push({ key, reason: missing });
      return;
    }
    signals.push({
      key,
      value,
      as_of: at,
      evidence_id: evidenceId,
      ...(derivedFrom ? { derived_from: derivedFrom } : {}),
    });
  };

  return { signals, unknowns, add };
}
