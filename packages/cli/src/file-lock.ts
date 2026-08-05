import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface FileLockOptions {
  waitMs?: number;
  retryMs?: number;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_RETRY_MS = 10;

/**
 * Serializes cross-process updates with an exclusive sidecar file.
 *
 * Existing locks are never removed by a waiter. A PID probe followed by an
 * unlink has a time-of-check/time-of-use race: the path may belong to a newer
 * owner by the time it is removed. Recovery is therefore explicit and manual.
 */
export async function withFileLock<T>(
  file: string,
  description: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lockFile = `${file}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      fd = openSync(lockFile, "wx", 0o600);
      try {
        writeFileSync(fd, owner);
      } catch (error) {
        closeSync(fd);
        fd = undefined;
        // Do not unlink by path after a failed write: another process could
        // replace our directory entry before cleanup. Leaving a lock for
        // explicit recovery is safer than deleting ownership we cannot prove.
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the ${description} lock at ${lockFile}. ` +
          "After confirming no AgentCall process is using this store, remove that lock file manually and retry.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  closeSync(fd);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    // Releasing must not throw over an error already on its way to the caller.
    // That error says what went wrong with the credential or trust-store write;
    // a failed release is the lesser fact, and it announces itself anyway on the
    // next acquire, which times out with an explicit manual-recovery message.
    try {
      releaseLock(lockFile, owner);
    } catch {
      // Deliberately dropped -- see above.
    }
    throw error;
  }

  // On the success path a failed release is worth surfacing: nothing else
  // reports a lock this process could not remove, and every later acquire pays
  // the full wait for it.
  releaseLock(lockFile, owner);
  return result;
}

/** Removes the lock, but only the exact random ownership token we created. */
function releaseLock(lockFile: string, owner: string): void {
  try {
    if (readFileSync(lockFile, "utf8") === owner) rmSync(lockFile, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
