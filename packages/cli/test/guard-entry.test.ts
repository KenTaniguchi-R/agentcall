import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_TIMEOUT_S } from "../src/runner.js";
import { tempDir } from "./helpers.js";

// The entry is a real process — that is the whole point of the file, and the
// only way to measure what the timeout has to cover.
const ENTRY = join(process.cwd(), "dist", "guard-entry.js");

// The line name every test in this file runs under, unless it is
// specifically exercising the "no line" fail-closed path. Per-line layout:
// logs land at <home>/.agentcall/lines/<LINE>/{tools,calls}.log, not the flat
// legacy <home>/.agentcall/{tools,calls}.log.
const LINE = "test-line";
const logPath = (home: string, file: "tools.log" | "calls.log") =>
  join(home, ".agentcall", "lines", LINE, file);
// Line-independent: MachinePaths.listenerLog, not under any line's directory.
// It's the only log reachable before a line name is known, which is exactly
// the situation the "no AGENTCALL_LINE" fail-closed path is in.
const listenerLogPath = (home: string) => join(home, ".agentcall", "listener.log");


// Seeds the line's sensitivity map. Without one every path classifies `secret`
// and even an ordinary read is refused — the inversion #372 introduces, and the
// reason these fixtures now have to say what the agent may reach rather than
// relying on an allow-by-default floor.
function seedMap(home: string, roots: string[]): string {
  const dir = join(home, ".agentcall", "lines", LINE);
  // 0o700 to match what the CLI itself creates: the log-permission assertions
  // below check the directory the guard writes into, and a 0o755 fixture would
  // fail them for a reason that has nothing to do with the guard.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "sensitivity.json"), JSON.stringify({
    sources: roots.map((path) => ({ path, sensitivity: "internal" })),
  }));
  return home;
}

type Run = { status: number; stdout: string; stderr: string };

function runEntry(input: string, home: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const env = { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc", AGENTCALL_LINE: LINE, AGENTCALL_CLEARANCE: "internal", ...extraEnv };
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

// Explicitly omits AGENTCALL_LINE rather than overriding it with a falsy
// value — `run`'s extraEnv spread can only override the key, not delete it,
// and an absent env var is a materially different case from an empty string.
function runWithoutLine(input: string, home: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc", AGENTCALL_CLEARANCE: "internal", ...extraEnv };
  delete env.AGENTCALL_LINE;
  try {
    const stdout = execFileSync(process.execPath, [ENTRY], {
      input, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function one(home: string, body: string): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const child = execFile(
      process.execPath, [ENTRY],
      { env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc", AGENTCALL_LINE: LINE, AGENTCALL_CLEARANCE: "internal" } },
      (err) => (err ? fail(err) : ok()),
    );
    child.stdin?.end(body);
  });
}

describe("guard-entry as a real process", () => {
  it("allows an ordinary read and writes tools.log", () => {
    const home = tempDir("guard-");
    seedMap(home, [home]);
    const r = run(
      { tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home },
      home,
      { AGENTCALL_CORRELATION_ID: "a".repeat(32) },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const tools = readFileSync(logPath(home, "tools.log"), "utf8").trim();
    expect(JSON.parse(tools)).toMatchObject({
      type: "tool_call", call_id: "call-abc", correlation_id: "a".repeat(32), allowed: true,
    });
    expect(statSync(join(home, ".agentcall")).mode & 0o777).toBe(0o700);
    // Per-line now: the log lives under lines/<name>/, not flat in .agentcall.
    expect(statSync(logPath(home, "tools.log")).mode & 0o777).toBe(0o600);
  });

  it("spools a stable pre-tool id without arguments and without changing the verdict", () => {
    const home = tempDir("guard-");
    seedMap(home, [home]);
    const spool = join(home, "tool-events.jsonl");
    writeFileSync(spool, "", { mode: 0o600 });
    const r = run({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "toolu_123",
      tool_input: { file_path: join(home, "private-name.ts") },
      cwd: home,
    }, home, { AGENTCALL_TOOL_TELEMETRY_FILE: spool });
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    const event = JSON.parse(readFileSync(spool, "utf8").trim());
    expect(event).toMatchObject({
      phase: "pre", call_id: "call-abc", tool_use_id: "toolu_123", tool_name: "Read",
    });
    expect(JSON.stringify(event)).not.toContain("private-name.ts");
  });

  it("denies a credential read and emits the structured decision", () => {
    const home = tempDir("guard-");
    const r = run({ tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id_rsa") }, cwd: home }, home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const calls = readFileSync(logPath(home, "calls.log"), "utf8").trim();
    expect(JSON.parse(calls)).toMatchObject({ type: "tool_denied" });
  });

  it("denies a file-shaped read outside AGENTCALL_ALLOWED_ROOT", () => {
    const home = tempDir("guard-");
    const allowed = join(home, "code", "payments");
    const r = run(
      { tool_name: "Read", tool_input: { file_path: join(home, "code", "payroll", "salary.ts") }, cwd: allowed },
      home,
      { AGENTCALL_ALLOWED_ROOT: allowed },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("exits 2 on unparseable input", () => {
    const home = tempDir("guard-");
    const r = runRaw("{not json", home);
    expect(r.status).toBe(2);
  });

  // Codex only treats exit 2 as blocking when stderr carries a reason; with
  // an empty stderr it records a failed hook and runs the tool. The bare
  // `process.exit(2)` this file used to end on therefore failed OPEN there.
  it("exits 2 with a reason on stderr, which is what makes it blocking", () => {
    const home = tempDir("guard-");
    const r = runRaw("{not json", home);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).not.toBe("");
  });

  it("observes without denying when AGENTCALL_GUARD_MODE is observe", () => {
    const home = tempDir("guard-");
    const r = run(
      { tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id_rsa") }, cwd: home },
      home,
      { AGENTCALL_GUARD_MODE: "observe" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const calls = readFileSync(logPath(home, "calls.log"), "utf8").trim();
    expect(JSON.parse(calls)).toMatchObject({ type: "tool_attempt_flagged" });
  });

  // An unrecognised value must not silently downgrade enforcement.
  it("enforces when the mode env var is set to anything unrecognised", () => {
    const home = tempDir("guard-");
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
    const home = tempDir("guard-");
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => one(home, body)));
    expect(Date.now() - started).toBeLessThan(GUARD_TIMEOUT_S * 1000);
  });

  it("writes one tools.log line per concurrent call, losing none", async () => {
    const home = tempDir("guard-");
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    await Promise.all(Array.from({ length: 8 }, () => one(home, body)));
    const lines = readFileSync(logPath(home, "tools.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(8);
    // Interleaved appends must still parse: a torn line means the audit trail
    // cannot be trusted, which is the whole point of the second stream.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

// The guard runs as a subprocess of the answering agent with no other way to
// learn which line's call it is policing. An absent or malformed
// AGENTCALL_LINE must fail closed rather than guess — silently auditing
// against the wrong line, or the wrong line's tasksDir denial not applying,
// is a worse failure mode than blocking the tool call.
describe("guard-entry requires AGENTCALL_LINE", () => {
  // The single event that means "the guard is unwired" must not be the one
  // event that leaves no trace: there's no per-line tools.log to write to
  // (there's no line), but the line-independent listenerLog is reachable and
  // records a guard_unwired entry so this failure mode is diagnosable rather
  // than silent.
  it("fails closed, writes no per-line log, but records guard_unwired in listenerLog", () => {
    const home = tempDir("guard-");
    const r = runWithoutLine(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home }),
      home,
    );
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).not.toBe("");
    expect(() => readFileSync(logPath(home, "tools.log"), "utf8")).toThrow();
    const listenerLog = readFileSync(listenerLogPath(home), "utf8").trim();
    expect(JSON.parse(listenerLog)).toMatchObject({ type: "guard_unwired", call_id: "call-abc" });
  });

  it("fails closed and records guard_unwired on a malformed line name too", () => {
    const home = tempDir("guard-");
    seedMap(home, [home]);
    const r = run(
      { tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home },
      home,
      { AGENTCALL_LINE: "../evil" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).not.toBe("");
    const listenerLog = readFileSync(listenerLogPath(home), "utf8").trim();
    expect(JSON.parse(listenerLog)).toMatchObject({ type: "guard_unwired" });
  });

  // Unconditional on mode: a missing AGENTCALL_LINE is a wiring bug, not an
  // ordinary decide() failure, so it is not eligible for observe mode's
  // fail-open treatment (which exists so a broken guard doesn't take a
  // healthy codex spawn down with it).
  it("fails closed even when AGENTCALL_GUARD_MODE is observe", () => {
    const home = tempDir("guard-");
    const r = runWithoutLine(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home }),
      home,
      { AGENTCALL_GUARD_MODE: "observe" },
    );
    expect(r.status).toBe(2);
  });
});
