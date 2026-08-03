import {
  closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, writeSync,
} from "node:fs";

export const TOOL_EVENT_MAX_NAME_BYTES = 128;
export const TOOL_EVENT_MAX_ID_BYTES = 256;
export const TOOL_EVENT_MAX_CALL_ID_BYTES = 128;
export const TOOL_EVENT_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
export const TOOL_EVENT_MAX_EVENTS = 512;
export const TOOL_EVENT_MAX_SPOOL_BYTES = 256 * 1_024;
const EXPORTABLE_TOOL_NAMES = new Set([
  "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "Skill", "AskUserQuestion",
  "Shell", "shell", "apply_patch", "view_image", "exec_command", "write_stdin",
  "functions.exec", "functions.exec_command", "functions.apply_patch", "functions.view_image",
]);

export function isExportableToolName(value: string): boolean {
  return EXPORTABLE_TOOL_NAMES.has(value);
}

export type ToolHookEvent = {
  v: 1;
  phase: "pre" | "post";
  call_id: string;
  tool_use_id: string;
  tool_name: string;
  at_ms: number;
  outcome?: "success" | "error" | "interrupted";
  duration_ms?: number;
};

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value) > maxBytes) return undefined;
  return value;
}

/**
 * Best-effort hook-side writer. It deliberately extracts only stable lifecycle
 * identity and bounded outcome data; arguments, results, paths, and error text
 * never reach the spool or the exporter.
 */
export function writeToolHookEvent(
  raw: string,
  phase: "pre" | "post",
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): void {
  try {
    const file = env.AGENTCALL_TOOL_TELEMETRY_FILE;
    const callId = boundedString(env.AGENTCALL_CALL_ID, TOOL_EVENT_MAX_CALL_ID_BYTES);
    if (!file || !callId) return;
    const input = JSON.parse(raw) as Record<string, unknown>;
    const eventName = input.hook_event_name;
    if (phase === "pre" && eventName !== "PreToolUse") return;
    if (phase === "post" && eventName !== "PostToolUse" && eventName !== "PostToolUseFailure") return;
    const toolUseId = boundedString(input.tool_use_id, TOOL_EVENT_MAX_ID_BYTES);
    const toolName = boundedString(input.tool_name, TOOL_EVENT_MAX_NAME_BYTES);
    if (!toolUseId || !toolName || !isExportableToolName(toolName)) return;
    const event: ToolHookEvent = {
      v: 1,
      phase,
      call_id: callId,
      tool_use_id: toolUseId,
      tool_name: toolName,
      at_ms: now(),
    };
    if (phase === "post") {
      event.outcome = eventName === "PostToolUse"
        ? "success"
        : input.is_interrupt === true ? "interrupted" : "error";
      if (typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms)
          && input.duration_ms >= 0 && input.duration_ms <= TOOL_EVENT_MAX_DURATION_MS) {
        event.duration_ms = input.duration_ms;
      }
    }
    const serialized = JSON.stringify(event);
    const record = `${serialized}\n`;
    const recordBytes = Buffer.byteLength(record);
    if (recordBytes > TOOL_EVENT_MAX_SPOOL_BYTES) return;
    const fd = openSync(
      file,
      constants.O_RDWR | constants.O_APPEND | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) return;
      const before = opened.size;
      if (before + recordBytes > TOOL_EVENT_MAX_SPOOL_BYTES) return;
      const existing = Buffer.allocUnsafe(before);
      if (before > 0 && readSync(fd, existing, 0, before, 0) !== before) return;
      const eventCount = before === 0 ? 0 : existing.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
      if (eventCount >= TOOL_EVENT_MAX_EVENTS) return;
      writeSync(fd, record, undefined, "utf8");
      // Concurrent hook processes can both observe the final free byte/event
      // slot. Recheck after the atomic O_APPEND write and roll back this
      // best-effort observation if either hard boundary was crossed.
      const after = fstatSync(fd).size;
      const complete = Buffer.allocUnsafe(Math.min(after, TOOL_EVENT_MAX_SPOOL_BYTES + 1));
      const read = readSync(fd, complete, 0, complete.length, 0);
      const completeEvents = complete.subarray(0, read)
        .reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
      if (after > TOOL_EVENT_MAX_SPOOL_BYTES || completeEvents > TOOL_EVENT_MAX_EVENTS) {
        ftruncateSync(fd, before);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Telemetry must never change a guard verdict or tool outcome.
  }
}
