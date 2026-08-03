import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { getMachinePaths } from "./paths.js";
import {
  TOOL_EVENT_MAX_DURATION_MS, TOOL_EVENT_MAX_EVENTS, TOOL_EVENT_MAX_ID_BYTES,
  TOOL_EVENT_MAX_NAME_BYTES, TOOL_EVENT_MAX_SPOOL_BYTES, isExportableToolName,
  type ToolHookEvent,
} from "./tool-telemetry-hook.js";

const MAX_LIFECYCLES = 256;
export const TOOL_EVENT_MAX_SPOOL_FILES = 64;
const TOOL_EVENT_STALE_FILE_MS = 60 * 60 * 1_000;

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

type UnlinkFile = (file: string) => void;

function removeIfSame(
  file: string,
  identity: SpoolIdentity,
  unlinkFile: UnlinkFile = unlinkSync,
): boolean {
  try {
    const current = lstatSync(file);
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    unlinkFile(file);
    return true;
  } catch {
    return false;
  }
}

function collect(
  file: string,
  callId: string,
  identity: SpoolIdentity,
  idKey: Buffer,
  createdAtMs: number,
  collectedAtMs: number,
  unlinkFile: UnlinkFile,
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
    removeIfSame(file, identity, unlinkFile);
  }
}

function sameIdentity(file: string, identity: SpoolIdentity): boolean {
  try {
    const current = lstatSync(file);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

function createInFixedSlot(
  spoolDir: string,
  unlinkFile: UnlinkFile,
): { file: string; identity: SpoolIdentity } | undefined {
  const firstSlot = randomBytes(2).readUInt16BE() % TOOL_EVENT_MAX_SPOOL_FILES;
  // A successful stale removal gets one retry of the same slot. The separate
  // attempts bound prevents an attacker racing replacements from keeping this
  // synchronous listener path alive indefinitely.
  for (let offset = 0, attempts = 0;
    offset < TOOL_EVENT_MAX_SPOOL_FILES && attempts < TOOL_EVENT_MAX_SPOOL_FILES * 2;
    offset += 1, attempts += 1) {
    const slot = (firstSlot + offset) % TOOL_EVENT_MAX_SPOOL_FILES;
    const file = join(spoolDir, `slot-${slot}.jsonl`);
    try {
      writeFileSync(file, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      const created = lstatSync(file);
      if (!created.isFile() || (created.mode & 0o777) !== 0o600 || created.nlink !== 1) {
        removeIfSame(file, created, unlinkFile);
        continue;
      }
      return { file, identity: { dev: created.dev, ino: created.ino } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") continue;
      try {
        const occupied = lstatSync(file);
        if (occupied.isFile() && occupied.nlink === 1
            && Date.now() - occupied.mtimeMs > TOOL_EVENT_STALE_FILE_MS) {
          if (removeIfSame(file, occupied, unlinkFile)) offset -= 1;
        }
      } catch { /* another process changed the slot; retry the next one */ }
    }
  }
  return undefined;
}

export function createToolEventSpool(
  callId: string,
  privateStateDir: string = getMachinePaths().dir,
  now: () => number = Date.now,
  unlinkFile: UnlinkFile = unlinkSync,
): ToolEventSpool | undefined {
  try {
    const spoolDir = join(privateStateDir, "tool-events");
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const dirFd = openSync(
      spoolDir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    let directoryIdentity: SpoolIdentity;
    try {
      const openedDir = fstatSync(dirFd);
      if (!openedDir.isDirectory()) return undefined;
      fchmodSync(dirFd, 0o700);
      directoryIdentity = { dev: openedDir.dev, ino: openedDir.ino };
      if (!sameIdentity(spoolDir, directoryIdentity)) return undefined;
    } finally {
      closeSync(dirFd);
    }
    const allocated = createInFixedSlot(spoolDir, unlinkFile);
    if (!allocated) return undefined;
    const { file, identity } = allocated;
    if (!sameIdentity(spoolDir, directoryIdentity)) {
      removeIfSame(file, identity, unlinkFile);
      return undefined;
    }
    const idKey = randomBytes(32);
    const createdAtMs = now();
    let consumed = false;
    const dispose = () => {
      if (consumed) return;
      consumed = true;
      removeIfSame(file, identity, unlinkFile);
    };
    return {
      file,
      collect: () => {
        if (consumed) return [];
        consumed = true;
        return collect(file, callId, identity, idKey, createdAtMs, now(), unlinkFile);
      },
      dispose,
    };
  } catch {
    return undefined;
  }
}
