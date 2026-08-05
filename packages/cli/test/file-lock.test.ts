import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/file-lock.js";

let root: string;
let file: string;
let lockFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcall-file-lock-"));
  file = join(root, "config.json");
  lockFile = `${file}.lock`;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Replacing the lock file with a directory makes the ownership read fail with
// EISDIR — a non-ENOENT cleanup failure, reproducible without stubbing fs.
function breakLockCleanup(): void {
  rmSync(lockFile, { force: true });
  mkdirSync(lockFile);
}

describe("withFileLock", () => {
  it("runs the operation under an exclusive lock and releases it", async () => {
    const result = await withFileLock(file, "test store", async () => {
      expect(existsSync(lockFile)).toBe(true);
      return "value";
    });

    expect(result).toBe("value");
    expect(existsSync(lockFile)).toBe(false);
  });

  it("propagates the operation's error and releases the lock", async () => {
    await expect(
      withFileLock(file, "test store", async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    expect(existsSync(lockFile)).toBe(false);
  });

  it("keeps the operation's error when releasing the lock also fails", async () => {
    // The failure this guards: a cleanup error replacing the error the caller
    // needs. `withFileLock` wraps credential and trust-store writes, so the
    // lost error is the one that says what actually went wrong with the write.
    await expect(
      withFileLock(file, "test store", async () => {
        breakLockCleanup();
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
  });

  it("reports a failed release when the operation itself succeeded", async () => {
    // Deliberate, and unchanged: nothing else will report a lock this process
    // could not release, and every later acquire pays the full wait for it.
    await expect(
      withFileLock(file, "test store", async () => {
        breakLockCleanup();
        return "value";
      }),
    ).rejects.toThrow(/EISDIR/);
  });

  it("tolerates a lock already removed by something else", async () => {
    const result = await withFileLock(file, "test store", async () => {
      rmSync(lockFile, { force: true });
      return "value";
    });

    expect(result).toBe("value");
  });

  it("never removes a lock owned by another process", async () => {
    const result = await withFileLock(file, "test store", async () => {
      writeFileSync(lockFile, "4242:not-our-token");
      return "value";
    });

    expect(result).toBe("value");
    expect(readFileSync(lockFile, "utf8")).toBe("4242:not-our-token");
  });

  it("times out rather than stealing a lock held by someone else", async () => {
    writeFileSync(lockFile, "4242:not-our-token");

    await expect(
      withFileLock(file, "test store", async () => "value", { waitMs: 20, retryMs: 1 }),
    ).rejects.toThrow(/Timed out waiting for the test store lock/);

    expect(readFileSync(lockFile, "utf8")).toBe("4242:not-our-token");
  });
});
