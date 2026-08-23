/**
 * Exit codes. The contract is documented in the `--help` epilogue, because an
 * exit code nobody can find is an exit code nobody uses.
 *
 * The split that matters is 2 vs 3: a data gap is the world being thin, and the
 * operator's move is to widen the seed or the window. An invariant violation is
 * this code being wrong, and the operator's move is to file a bug. Collapsing
 * them into one non-zero would hide the difference at exactly the moment it
 * matters.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Bad invocation, or configuration the run needs and does not have. */
  USAGE: 1,
  /** The run completed but found too little to act on. Not a bug. */
  DATA_GAP: 2,
  /** A contract or citation check failed (ADR-0003). A bug, not a data gap. */
  INVARIANT: 3,
  /**
   * A stage this build does not have yet. Temporary scaffolding: it disappears
   * as tickets 0012, 0022, 0026 and 0027 land — 0027 is the last of them, and
   * `run` is the last caller. 70 is sysexits' EX_SOFTWARE.
   */
  UNIMPLEMENTED: 70,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
