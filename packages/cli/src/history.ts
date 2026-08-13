import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import {
  isAbuseFlag, isAbuseSeverity, maxAbuseSeverity,
  signalForInboundStatus,
  type AbuseFlag, type AbuseSeverity,
} from "./abuse-signals.js";

const HISTORY_SCAN_BYTES = 4 * 1024 * 1024;
const GUARD_EVENT_TYPES = new Set(["tool_denied", "tool_flagged", "tool_attempt_flagged"]);

interface LocalHistoryEntry {
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
  flags?: AbuseFlag[];
  severity?: AbuseSeverity;
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
    (row.flags !== undefined &&
      (!Array.isArray(row.flags) || !row.flags.every(isAbuseFlag))) ||
    (row.severity !== undefined && !isAbuseSeverity(row.severity)) ||
    (row.duration_ms !== undefined &&
      (typeof row.duration_ms !== "number" || !Number.isFinite(row.duration_ms)))
  ) return undefined;
  const expectedSignal = signalForInboundStatus(row.status);
  if (row.flags !== undefined) {
    const flags = row.flags as AbuseFlag[];
    if (
      flags.length !== expectedSignal.flags.length ||
      flags.some((flag, index) => flag !== expectedSignal.flags[index])
    ) return undefined;
  }
  if (row.severity !== undefined && row.severity !== expectedSignal.severity) return undefined;
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
    ...(expectedSignal.flags.length > 0
      ? { flags: [...expectedSignal.flags] }
      : {}),
    ...(expectedSignal.severity ? { severity: expectedSignal.severity } : {}),
  };
}

// The guard's verdict field was renamed `allowed` -> `allowed_by_guard` (#415).
// tools.log is an append-only file on the owner's disk that nothing migrates, so
// every line written before that rename is still there and still has to read
// back. Both spellings are accepted here and nowhere else; the writer emits only
// the new one.
function guardVerdict(row: Record<string, unknown>): unknown {
  return row.allowed_by_guard !== undefined ? row.allowed_by_guard : row.allowed;
}

function validToolEvent(row: Record<string, unknown>): boolean {
  const verdict = guardVerdict(row);
  return row.type === "tool_call" && typeof row.ts === "string" &&
    typeof row.call_id === "string" && typeof row.tool === "string" &&
    (
      (typeof verdict === "boolean" && row.mode === undefined) ||
      // Legacy observe-mode rows recorded no verdict at all. Observe mode is
      // gone; these lines are not.
      (verdict === undefined && row.mode === "observe")
    );
}

interface LocalHistory {
  entries: LocalHistoryEntry[];
  malformed: number;
  truncatedFiles: string[];
}

// Structural, not `LinePaths`: this only ever reads the two logs, and both are
// per-line. Kept narrow so a caller cannot hand it a mismatched pair.
export function loadLocalHistory(
  paths: { callsLog: string; toolsLog: string },
  limit: number,
  options: { flaggedOnly?: boolean } = {},
): LocalHistory {
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
  const selected = new Map(calls.map((entry) => [entry.call_id, entry]));

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
    if (guardVerdict(row) === false) {
      entry.tools_denied++;
      entry.flags = [...new Set([...(entry.flags ?? []), "tool_policy_denial" as const])];
      entry.severity = maxAbuseSeverity(entry.severity, "high");
    }
  }

  const matching = options.flaggedOnly
    ? calls.filter((entry) => (entry.flags?.length ?? 0) > 0)
    : calls;
  const entries = matching.slice(-limit).reverse();

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
    if (entry.flags?.length) {
      lines.push(`  Flags: ${entry.flags.map(oneLine).join(", ")} (${entry.severity ?? "low"})`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
