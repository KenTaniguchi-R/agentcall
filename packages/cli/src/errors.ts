// One spelling for "turn an unknown throw into something a human can read",
// and one for the command-level "print it and exit non-zero".
//
// These used to be written out at every catch site, in three forms that all
// behaved identically: `e instanceof Error ? e.message : String(e)`,
// `String(e instanceof Error ? e.message : e)`, and an ApiError-first variant
// whose extra branch was redundant because ApiError extends Error. Having
// three spellings meant reading each one to confirm it was the same as the
// others; having one means the question doesn't come up.

/** The human-readable text of an unknown throw. Never throws itself. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Commands set `process.exitCode` rather than calling `process.exit`, so
// buffered stdout still flushes and `runCli` can read the code back out.
/** Report a failed command: message to stderr, exit code 1. */
export function fail(error: unknown, hint?: string): void {
  console.error(hint ? `${errorMessage(error)}\n${hint}` : errorMessage(error));
  process.exitCode = 1;
}
