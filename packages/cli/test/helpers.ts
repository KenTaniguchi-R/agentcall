// Temp-dir helpers for packages/cli/test. Every helper here registers its
// own teardown so a test can't forget to clean up: `onTestFinished` when
// called from inside a running test (the common case — most temp dirs are
// created inside `it()`), falling back to `afterAll` when called during
// collection (module top-level, or inside a `describe()` body before any
// `it()` has run — `onTestFinished` throws in that position). Cleanup uses
// `rmSync(..., { force: true })`, which swallows a missing/already-removed
// path, so a failed rm can never fail the test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished } from "vitest";
import { getLinePaths, getMachinePaths, type LinePaths, type MachinePaths } from "../src/paths.js";

function registerCleanup(dir: string): void {
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    onTestFinished(cleanup);
  } catch {
    afterAll(cleanup);
  }
}

/** Fresh temp directory under the OS tmpdir, auto-removed after the test (or suite) that created it. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registerCleanup(dir);
  return dir;
}

// Fresh ~/.agentcall-shaped tmp root, used as both stateRoot and userHome so
// nothing in these tests can accidentally touch the real machine. Mirrors
// `freshMachine` in listener.test.ts, plus auto-cleanup.
export function tempMachine(prefix = "agentcall-m-"): MachinePaths {
  const root = tempDir(prefix);
  return getMachinePaths(root, root);
}

// No policy/task seeded — loadPolicy and loadTasks both fall back to their
// built-in defaults (default_clearance: "public", the built-in "ask" task),
// which is enough for a plain message to resolve. Mirrors `seededPaths` in
// listener.test.ts.
export function tempLine(name = "line", prefix = "agentcall-l-"): LinePaths {
  return getLinePaths(tempMachine(prefix), name);
}
