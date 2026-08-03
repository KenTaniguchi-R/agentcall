import {
  appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  TOOL_EVENT_MAX_EVENTS, TOOL_EVENT_MAX_SPOOL_BYTES, writeToolHookEvent,
} from "../src/tool-telemetry-hook.js";
import { createToolEventSpool, TOOL_EVENT_MAX_SPOOL_FILES } from "../src/tool-telemetry-spool.js";

const privateState = mkdtempSync(join(tmpdir(), "agentcall-tool-spool-test-"));
afterAll(() => rmSync(privateState, { recursive: true, force: true }));
const spoolFor = (callId: string) => {
  let reads = 0;
  return createToolEventSpool(callId, privateState, () => reads++ === 0 ? 0 : 100_000)!;
};

const pre = (id: string, tool = "Bash") => JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_use_id: id,
  tool_input: { command: "printf secret-value" },
});

const post = (id: string, tool = "Bash", duration_ms?: number) => JSON.stringify({
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_use_id: id,
  tool_input: { command: "printf secret-value" },
  tool_response: { stdout: "secret-value" },
  ...(duration_ms === undefined ? {} : { duration_ms }),
});

describe("tool telemetry hook spool", () => {
  it("stores only bounded lifecycle identity, never arguments or results", () => {
    const spool = spoolFor("call-1");
    writeToolHookEvent(pre("tool-1"), "pre", {
      AGENTCALL_CALL_ID: "call-1", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file,
    }, () => 1_000);
    writeToolHookEvent(post("tool-1", "Bash", 25), "post", {
      AGENTCALL_CALL_ID: "call-1", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file,
    }, () => 1_025);

    const raw = readFileSync(spool.file, "utf8");
    expect(raw).not.toContain("printf");
    expect(raw).not.toContain("secret-value");
    expect(statSync(spool.file).mode & 0o777).toBe(0o600);
    expect(spool.collect()).toEqual([{
      callId: "call-1", toolCallId: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      toolName: "Bash", outcome: "success",
      startedAtMs: 1_000, endedAtMs: 1_025, durationMs: 25,
    }]);
  });

  it("pairs events regardless of line order and uses observed duration when absent", () => {
    const spool = spoolFor("call-2");
    writeToolHookEvent(post("tool-2"), "post", {
      AGENTCALL_CALL_ID: "call-2", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file,
    }, () => 1_150);
    writeToolHookEvent(pre("tool-2"), "pre", {
      AGENTCALL_CALL_ID: "call-2", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file,
    }, () => 1_000);

    expect(spool.collect()).toEqual([expect.objectContaining({
      outcome: "success", durationMs: 150, startedAtMs: 1_000, endedAtMs: 1_150,
    })]);
  });

  it("emits error outcomes but suppresses missing, duplicate, and mismatched pairs", () => {
    const spool = spoolFor("call-3");
    const env = { AGENTCALL_CALL_ID: "call-3", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file };
    writeToolHookEvent(pre("complete", "Read"), "pre", env, () => 2_000);
    writeToolHookEvent(JSON.stringify({
      hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_use_id: "complete",
      tool_input: { file_path: "/secret" }, error: "private failure detail", duration_ms: 10,
    }), "post", env, () => 2_010);
    writeToolHookEvent(pre("missing"), "pre", env, () => 2_000);
    writeToolHookEvent(pre("duplicate"), "pre", env, () => 2_000);
    writeToolHookEvent(pre("duplicate"), "pre", env, () => 2_001);
    writeToolHookEvent(post("duplicate"), "post", env, () => 2_010);
    writeToolHookEvent(pre("mismatch", "Read"), "pre", env, () => 2_000);
    writeToolHookEvent(post("mismatch", "Bash"), "post", env, () => 2_010);

    expect(spool.collect()).toEqual([expect.objectContaining({
      toolCallId: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      toolName: "Read", outcome: "error", durationMs: 10,
    })]);
  });

  it("does not export arbitrary tool names and bounds native duration to the observed pair", () => {
    const spool = spoolFor("call-untrusted");
    const env = { AGENTCALL_CALL_ID: "call-untrusted", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file };
    writeToolHookEvent(pre("duration", "Read"), "pre", env, () => 1_000);
    writeToolHookEvent(post("duration", "Read", 60_000), "post", env, () => 1_010);
    writeToolHookEvent(pre("covert", "prompt-fragment"), "pre", env, () => 1_000);
    writeToolHookEvent(post("covert", "prompt-fragment"), "post", env, () => 1_010);

    expect(spool.collect()).toEqual([expect.objectContaining({
      toolName: "Read", startedAtMs: 1_000, endedAtMs: 1_010, durationMs: 10,
    })]);
  });

  it("omits timestamps outside the spool lifetime", () => {
    const spool = spoolFor("call-time-bounds");
    const env = { AGENTCALL_CALL_ID: "call-time-bounds", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file };
    writeToolHookEvent(pre("past", "Read"), "pre", env, () => -1);
    writeToolHookEvent(post("past", "Read"), "post", env, () => 10);
    writeToolHookEvent(pre("future", "Read"), "pre", env, () => 10);
    writeToolHookEvent(post("future", "Read"), "post", env, () => 100_001);
    expect(spool.collect()).toEqual([]);
  });

  it("bounds hostile spool growth and deletes the file after collection", () => {
    const spool = spoolFor("call-4");
    appendFileSync(spool.file, "x".repeat(400_000));
    expect(spool.collect()).toEqual([]);
    expect(() => statSync(spool.file)).toThrow();
  });

  it("stops hook-side writes at the hard byte and event boundary", () => {
    const spool = spoolFor("call-bounded");
    const env = { AGENTCALL_CALL_ID: "call-bounded", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file };
    for (let index = 0; index < TOOL_EVENT_MAX_EVENTS + 100; index += 1) {
      writeToolHookEvent(pre(`tool-${index}`), "pre", env, () => index);
    }

    const raw = readFileSync(spool.file, "utf8");
    expect(statSync(spool.file).size).toBeLessThanOrEqual(TOOL_EVENT_MAX_SPOOL_BYTES);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(TOOL_EVENT_MAX_EVENTS);
  });

  it("suppresses the whole observation when the bounded event count is exceeded", () => {
    const spool = spoolFor("call-5");
    const event = JSON.stringify({
      v: 1, phase: "pre", call_id: "call-5", tool_use_id: "same",
      tool_name: "Read", at_ms: 1_000,
    });
    appendFileSync(spool.file, `${Array.from({ length: 513 }, () => event).join("\n")}\n`);
    expect(spool.collect()).toEqual([]);
  });

  it("rejects a FIFO replacement without blocking the hook", () => {
    const spool = spoolFor("call-fifo");
    unlinkSync(spool.file);
    execFileSync("mkfifo", [spool.file]);

    const started = Date.now();
    writeToolHookEvent(pre("tool-fifo"), "pre", {
      AGENTCALL_CALL_ID: "call-fifo", AGENTCALL_TOOL_TELEMETRY_FILE: spool.file,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(spool.collect()).toEqual([]);
  });

  it("rejects a forged mode-0600 replacement with sanitized-looking pairs", () => {
    const spool = spoolFor("call-forged");
    unlinkSync(spool.file);
    writeFileSync(spool.file, [
      JSON.stringify({
        v: 1, phase: "pre", call_id: "call-forged", tool_use_id: "secret-a", tool_name: "secret-b", at_ms: 1,
      }),
      JSON.stringify({
        v: 1, phase: "post", call_id: "call-forged", tool_use_id: "secret-a", tool_name: "secret-b",
        at_ms: 2, outcome: "success",
      }),
      "",
    ].join("\n"), { mode: 0o600 });

    expect(spool.collect()).toEqual([]);
  });

  it("bounds aggregate files left by abnormal previous exits", () => {
    const stale = Array.from({ length: TOOL_EVENT_MAX_SPOOL_FILES + 10 }, (_, index) =>
      createToolEventSpool(`stale-${index}`, privateState)!);
    const files = readdirSync(join(privateState, "tool-events"))
      .filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(TOOL_EVENT_MAX_SPOOL_FILES);
    for (const spool of stale) spool.dispose();
  });
});
