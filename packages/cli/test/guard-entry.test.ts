import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_TIMEOUT_S } from "../src/runner.js";

// The entry is a real process — that is the whole point of the file, and the
// only way to measure what the timeout has to cover.
const ENTRY = join(process.cwd(), "dist", "guard-entry.js");

function run(payload: object, home: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [ENTRY], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" },
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { status: err.status, stdout: err.stdout ?? "" };
  }
}

describe("guard-entry as a real process", () => {
  it("allows an ordinary read and writes tools.log", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run({ tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home }, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const tools = readFileSync(join(home, ".agentcall", "tools.log"), "utf8").trim();
    expect(JSON.parse(tools)).toMatchObject({ type: "tool_call", call_id: "call-abc", allowed: true });
  });

  it("denies a credential read and emits the structured decision", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run({ tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id_rsa") }, cwd: home }, home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const calls = readFileSync(join(home, ".agentcall", "calls.log"), "utf8").trim();
    expect(JSON.parse(calls)).toMatchObject({ type: "tool_denied" });
  });

  it("exits 2 on unparseable input", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run("not json" as unknown as object, home);
    expect(r.status).toBe(2);
  });

  // Guards the fail-open-on-timeout path, and does it under concurrency:
  // Copilot's documented bug is specifically parallel — the timeout expires,
  // the CLI stops waiting, and the tool runs anyway. Timing decide() would
  // pass while this path was slow, because the cost is process startup.
  // Asserted against the REGISTERED timeout, not an arbitrary number.
  it("completes inside the registered timeout with 8 hooks in flight", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    const one = () => new Promise<void>((ok, fail) => {
      const child = execFile(
        process.execPath, [ENTRY],
        { env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" } },
        (err) => (err ? fail(err) : ok()),
      );
      child.stdin?.end(body);
    });
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, one));
    expect(Date.now() - started).toBeLessThan(GUARD_TIMEOUT_S * 1000);
  });

  it("writes one tools.log line per concurrent call, losing none", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    const one = () => new Promise<void>((ok, fail) => {
      const child = execFile(
        process.execPath, [ENTRY],
        { env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" } },
        (err) => (err ? fail(err) : ok()),
      );
      child.stdin?.end(body);
    });
    await Promise.all(Array.from({ length: 8 }, one));
    const lines = readFileSync(join(home, ".agentcall", "tools.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(8);
    // Interleaved appends must still parse: a torn line means the audit trail
    // cannot be trusted, which is the whole point of the second stream.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
