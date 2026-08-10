import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import {
  claimExecution, executionEnvelopeDigest, loadExecutionJournal, markExecutionStarted, markExecutionTerminal,
} from "../src/execution-journal.js";

const roots: string[] = [];
function machine() {
  const root = mkdtempSync(join(tmpdir(), "agentcall-journal-"));
  roots.push(root);
  return getPaths(root, root);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable execution journal", () => {
  it("hashes the full encrypted envelope deterministically", () => {
    const envelope = { v: 1, direction: "request", ct: "ciphertext" };
    expect(executionEnvelopeDigest(envelope)).toMatch(/^[0-9a-f]{64}$/);
    expect(executionEnvelopeDigest(envelope)).toBe(executionEnvelopeDigest({ ...envelope }));
    expect(executionEnvelopeDigest({ ...envelope, ct: "different" })).not.toBe(executionEnvelopeDigest(envelope));
  });

  it("claims once and permits only an identical pre-start redelivery", async () => {
    const paths = machine();
    const first = await claimExecution(paths, "call-1", "a".repeat(64), 100);
    const retry = await claimExecution(paths, "call-1", "a".repeat(64), 101);
    expect(first).toEqual({ decision: "execute", state: "claimed" });
    expect(retry).toEqual({ decision: "execute", state: "claimed" });
    expect(loadExecutionJournal(paths)).toHaveLength(1);
    expect(statSync(paths.executionJournalFile).mode & 0o777).toBe(0o600);
  });

  it("rejects one call id rebound to different ciphertext", async () => {
    const paths = machine();
    await claimExecution(paths, "call-1", "a".repeat(64), 100);
    await expect(claimExecution(paths, "call-1", "b".repeat(64), 101)).resolves.toEqual({
      decision: "conflict", state: "claimed",
    });
  });

  it("never executes again after the process-start boundary", async () => {
    const paths = machine();
    await claimExecution(paths, "call-1", "a".repeat(64), 100);
    await markExecutionStarted(paths, "call-1", "a".repeat(64), 110);
    await expect(claimExecution(paths, "call-1", "a".repeat(64), 120)).resolves.toEqual({
      decision: "indeterminate", state: "started",
    });
    await markExecutionTerminal(paths, "call-1", "a".repeat(64), 130);
    await expect(claimExecution(paths, "call-1", "a".repeat(64), 140)).resolves.toEqual({
      decision: "terminal", state: "terminal",
    });
  });

  it("fails closed when the private store has loose permissions", async () => {
    const paths = machine();
    await claimExecution(paths, "call-1", "a".repeat(64), 100);
    chmodSync(paths.executionJournalFile, 0o644);
    expect(() => loadExecutionJournal(paths)).toThrow(/permission/i);
  });
});
