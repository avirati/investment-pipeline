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
} as const;

/**
 * There was a fourth, `UNIMPLEMENTED: 70` (sysexits' `EX_SOFTWARE`) — the
 * scaffolding each stage ticket removed one caller from. TICKET-0027 wired
 * `run`, which was the last of them, and took the code with it. It is recorded
 * here rather than deleted silently because an exit code is a contract: 70 used
 * to mean something to anybody scripting against this CLI, and it now means
 * nothing at all.
 */

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
