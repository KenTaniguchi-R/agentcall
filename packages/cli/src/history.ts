import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";

const HISTORY_SCAN_BYTES = 4 * 1024 * 1024;
const GUARD_EVENT_TYPES = new Set(["tool_denied", "tool_flagged", "tool_attempt_flagged"]);

export interface LocalHistoryEntry {
  ts: string;
  call_id: string;
  from: string;
  message: string;
  reply?: string;
  task?: string;
  status: string;
  duration_ms?: number;
  tool_attempts: number;
  tools_denied: number;
}

type JsonLines = {
  records: Record<string, unknown>[];
  malformed: number;
  truncated: boolean;
};

function readRecentJsonLines(file: string): JsonLines {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], malformed: 0, truncated: false };
    }
    throw error;
  }

  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - HISTORY_SCAN_BYTES);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstCompleteLine = text.indexOf("\n");
      text = firstCompleteLine === -1 ? "" : text.slice(firstCompleteLine + 1);
    }

    const records: Record<string, unknown>[] = [];
    let malformed = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          records.push(value as Record<string, unknown>);
        } else {
          malformed++;
        }
      } catch {
        malformed++;
      }
    }
    return { records, malformed, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function validGuardEvent(row: Record<string, unknown>): boolean {
  return typeof row.type === "string" && GUARD_EVENT_TYPES.has(row.type) &&
    typeof row.ts === "string" && typeof row.call_id === "string" &&
    typeof row.tool === "string" && typeof row.rule === "string" &&
    typeof row.detail === "string";
}

function toCallEntry(row: Record<string, unknown>): LocalHistoryEntry | undefined {
  if (
    typeof row.ts !== "string" || typeof row.call_id !== "string" ||
    typeof row.from !== "string" || typeof row.message !== "string" ||
    typeof row.status !== "string" ||
    (row.reply !== undefined && typeof row.reply !== "string") ||
    (row.task !== undefined && typeof row.task !== "string") ||
    (row.duration_ms !== undefined &&
      (typeof row.duration_ms !== "number" || !Number.isFinite(row.duration_ms)))
  ) return undefined;
  return {
    ts: row.ts,
    call_id: row.call_id,
    from: row.from,
    message: row.message,
    ...(typeof row.reply === "string" ? { reply: row.reply } : {}),
    ...(typeof row.task === "string" ? { task: row.task } : {}),
    status: row.status,
    ...(typeof row.duration_ms === "number" ? { duration_ms: row.duration_ms } : {}),
    tool_attempts: 0,
    tools_denied: 0,
  };
}

function validToolEvent(row: Record<string, unknown>): boolean {
  return row.type === "tool_call" && typeof row.ts === "string" &&
    typeof row.call_id === "string" && typeof row.tool === "string" &&
    (typeof row.allowed === "boolean" || row.mode === "observe");
}

export interface LocalHistory {
  entries: LocalHistoryEntry[];
  malformed: number;
  truncatedFiles: string[];
}

// Structural, not `LinePaths`: this only ever reads the two logs, and both are
// per-line. Kept narrow so a caller cannot hand it a mismatched pair.
export function loadLocalHistory(paths: { callsLog: string; toolsLog: string }, limit: number): LocalHistory {
  const callsLog = readRecentJsonLines(paths.callsLog);
  let malformed = callsLog.malformed;
  const calls: LocalHistoryEntry[] = [];
  for (const row of callsLog.records) {
    if (row.type !== undefined) {
      if (!validGuardEvent(row)) malformed++;
      continue;
    }
    const entry = toCallEntry(row);
    if (entry) calls.push(entry);
    else malformed++;
  }
  const entries = calls.slice(-limit).reverse();
  const selected = new Map(entries.map((entry) => [entry.call_id, entry]));

  const toolsLog = readRecentJsonLines(paths.toolsLog);
  malformed += toolsLog.malformed;
  for (const row of toolsLog.records) {
    if (!validToolEvent(row)) {
      malformed++;
      continue;
    }
    const entry = selected.get(row.call_id as string);
    if (!entry) continue;
    entry.tool_attempts++;
    if (row.allowed === false) entry.tools_denied++;
  }

  return {
    entries,
    malformed,
    truncatedFiles: [
      ...(callsLog.truncated ? [basename(paths.callsLog)] : []),
      ...(toolsLog.truncated ? [basename(paths.toolsLog)] : []),
    ],
  };
}

function oneLine(value: string): string {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

export function renderLocalHistory(entries: LocalHistoryEntry[]): string {
  if (entries.length === 0) return "No local call history.";
  return entries.map((entry) => {
    const duration = entry.duration_ms === undefined ? "" : `  ${entry.duration_ms}ms`;
    const lines = [
      `${oneLine(entry.ts)}  ${oneLine(entry.from)}  ${oneLine(entry.task ?? "ask")}  ${oneLine(entry.status)}${duration}`,
      `  Asked: ${oneLine(entry.message)}`,
    ];
    if (entry.reply !== undefined) lines.push(`  Replied: ${oneLine(entry.reply)}`);
    lines.push(`  Tools: ${entry.tool_attempts} attempts, ${entry.tools_denied} denied`);
    return lines.join("\n");
  }).join("\n\n");
}
