import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { getMachinePaths } from "./paths.js";
import {
  TOOL_EVENT_MAX_DURATION_MS, TOOL_EVENT_MAX_EVENTS, TOOL_EVENT_MAX_ID_BYTES,
  TOOL_EVENT_MAX_NAME_BYTES, TOOL_EVENT_MAX_SPOOL_BYTES, isExportableToolName,
  type ToolHookEvent,
} from "./tool-telemetry-hook.js";

const MAX_LIFECYCLES = 256;
export const TOOL_EVENT_MAX_SPOOL_FILES = 64;

export interface ToolLifecycle {
  callId: string;
  toolCallId: string;
  toolName: string;
  outcome: "success" | "error" | "interrupted";
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
}

export interface ToolEventSpool {
  file: string;
  collect(): ToolLifecycle[];
  dispose(): void;
}

function validEvent(
  value: unknown,
  callId: string,
  createdAtMs: number,
  collectedAtMs: number,
): value is ToolHookEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Partial<ToolHookEvent>;
  return event.v === 1
    && (event.phase === "pre" || event.phase === "post")
    && event.call_id === callId
    && typeof event.tool_use_id === "string" && event.tool_use_id.length > 0
    && Buffer.byteLength(event.tool_use_id) <= TOOL_EVENT_MAX_ID_BYTES
    && typeof event.tool_name === "string" && event.tool_name.length > 0
    && Buffer.byteLength(event.tool_name) <= TOOL_EVENT_MAX_NAME_BYTES
    && typeof event.at_ms === "number" && Number.isSafeInteger(event.at_ms)
    && event.at_ms >= createdAtMs && event.at_ms <= collectedAtMs
    && (event.phase === "pre"
      ? event.outcome === undefined
      : event.outcome === "success" || event.outcome === "error" || event.outcome === "interrupted")
    && (event.duration_ms === undefined
      || (typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms)
        && event.duration_ms >= 0 && event.duration_ms <= TOOL_EVENT_MAX_DURATION_MS));
}

interface SpoolIdentity { dev: number; ino: number }

function readBounded(file: string, identity: SpoolIdentity): string {
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1
        || opened.dev !== identity.dev || opened.ino !== identity.ino) return "";
    const buffer = Buffer.allocUnsafe(TOOL_EVENT_MAX_SPOOL_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > TOOL_EVENT_MAX_SPOOL_BYTES) return "";
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function removeIfSame(file: string, identity: SpoolIdentity): void {
  try {
    const current = lstatSync(file);
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(file);
  } catch { /* absent, replaced, or inaccessible */ }
}

function collect(
  file: string,
  callId: string,
  identity: SpoolIdentity,
  idKey: Buffer,
  createdAtMs: number,
  collectedAtMs: number,
): ToolLifecycle[] {
  try {
    const raw = readBounded(file, identity);
    if (raw === "") return [];
    const pre = new Map<string, ToolHookEvent>();
    const post = new Map<string, ToolHookEvent>();
    const ambiguous = new Set<string>();
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > TOOL_EVENT_MAX_EVENTS) return [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const event: unknown = JSON.parse(line.trimEnd());
        if (!validEvent(event, callId, createdAtMs, collectedAtMs)) continue;
        const target = event.phase === "pre" ? pre : post;
        if (target.has(event.tool_use_id)) {
          ambiguous.add(event.tool_use_id);
          continue;
        }
        target.set(event.tool_use_id, event);
      } catch { /* malformed local observations are ignored */ }
    }
    const lifecycles: ToolLifecycle[] = [];
    for (const [toolCallId, start] of pre) {
      if (lifecycles.length >= MAX_LIFECYCLES) break;
      if (ambiguous.has(toolCallId)) continue;
      const end = post.get(toolCallId);
      if (!end || end.tool_name !== start.tool_name || end.at_ms < start.at_ms || !end.outcome
          || !isExportableToolName(start.tool_name)) continue;
      const observedDurationMs = end.at_ms - start.at_ms;
      const durationMs = end.duration_ms !== undefined && end.duration_ms <= observedDurationMs
        ? end.duration_ms
        : observedDurationMs;
      const startedAtMs = end.duration_ms !== undefined && end.duration_ms <= observedDurationMs
        ? end.at_ms - durationMs
        : start.at_ms;
      lifecycles.push({
        callId,
        toolCallId: `hmac-sha256:${createHmac("sha256", idKey).update(toolCallId).digest("hex")}`,
        toolName: start.tool_name,
        outcome: end.outcome,
        startedAtMs,
        endedAtMs: end.at_ms,
        durationMs,
      });
    }
    return lifecycles;
  } catch {
    return [];
  } finally {
    removeIfSame(file, identity);
  }
}

function pruneSpoolDir(spoolDir: string): void {
  const candidates = readdirSync(spoolDir, { withFileTypes: true })
    .filter((entry) => /^\d+-[0-9a-f-]{36}\.jsonl$/.test(entry.name))
    .flatMap((entry) => {
      const file = join(spoolDir, entry.name);
      try {
        const stat = lstatSync(file);
        return stat.isDirectory() ? [] : [{ file, mtimeMs: stat.mtimeMs }];
      } catch { return []; }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const stale of candidates.slice(0, Math.max(0, candidates.length - TOOL_EVENT_MAX_SPOOL_FILES + 1))) {
    try { unlinkSync(stale.file); } catch { /* best-effort stale cleanup */ }
  }
}

export function createToolEventSpool(
  callId: string,
  privateStateDir: string = getMachinePaths().dir,
  now: () => number = Date.now,
): ToolEventSpool | undefined {
  try {
    const spoolDir = join(privateStateDir, "tool-events");
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    chmodSync(spoolDir, 0o700);
    pruneSpoolDir(spoolDir);
    const file = join(spoolDir, `${process.pid}-${randomUUID()}.jsonl`);
    writeFileSync(file, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const created = statSync(file);
    const identity = { dev: created.dev, ino: created.ino };
    const idKey = randomBytes(32);
    const createdAtMs = now();
    let consumed = false;
    const dispose = () => {
      if (consumed) return;
      consumed = true;
      removeIfSame(file, identity);
    };
    return {
      file,
      collect: () => {
        if (consumed) return [];
        consumed = true;
        return collect(file, callId, identity, idKey, createdAtMs, now());
      },
      dispose,
    };
  } catch {
    return undefined;
  }
}
