import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_TIMEOUT_S } from "../src/runner.js";

// The entry is a real process — that is the whole point of the file, and the
// only way to measure what the timeout has to cover.
const ENTRY = join(process.cwd(), "dist", "guard-entry.js");

type Run = { status: number; stdout: string; stderr: string };

function runEntry(input: string, home: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const env = { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc", ...extraEnv };
  try {
    // Pipe stderr rather than inheriting it, so the reason text can be
    // asserted — it is what makes exit 2 blocking rather than "hook failed".
    const stdout = execFileSync(process.execPath, [ENTRY], {
      input, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const run = (payload: object, home: string, extraEnv?: NodeJS.ProcessEnv): Run =>
  runEntry(JSON.stringify(payload), home, extraEnv);

const runRaw = (raw: string, home: string): Run => runEntry(raw, home);

function one(home: string, body: string): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const child = execFile(
      process.execPath, [ENTRY],
      { env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" } },
      (err) => (err ? fail(err) : ok()),
    );
    child.stdin?.end(body);
  });
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
    const r = runRaw("{not json", home);
    expect(r.status).toBe(2);
  });

  // Codex only treats exit 2 as blocking when stderr carries a reason; with
  // an empty stderr it records a failed hook and runs the tool. The bare
  // `process.exit(2)` this file used to end on therefore failed OPEN there.
  it("exits 2 with a reason on stderr, which is what makes it blocking", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = runRaw("{not json", home);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).not.toBe("");
  });

  it("observes without denying when AGENTCALL_GUARD_MODE is observe", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run(
      { tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id_rsa") }, cwd: home },
      home,
      { AGENTCALL_GUARD_MODE: "observe" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const calls = readFileSync(join(home, ".agentcall", "calls.log"), "utf8").trim();
    expect(JSON.parse(calls)).toMatchObject({ type: "tool_attempt_flagged" });
  });

  // An unrecognised value must not silently downgrade enforcement.
  it("enforces when the mode env var is set to anything unrecognised", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run(
      { tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id_rsa") }, cwd: home },
      home,
      { AGENTCALL_GUARD_MODE: "off" },
    );
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
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
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => one(home, body)));
    expect(Date.now() - started).toBeLessThan(GUARD_TIMEOUT_S * 1000);
  });

  it("writes one tools.log line per concurrent call, losing none", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    await Promise.all(Array.from({ length: 8 }, () => one(home, body)));
    const lines = readFileSync(join(home, ".agentcall", "tools.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(8);
    // Interleaved appends must still parse: a torn line means the audit trail
    // cannot be trusted, which is the whole point of the second stream.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
