import {
  A2AListTasksResponse,
  A2ATask,
  A2ATaskState,
  type A2AListTasksResponseType,
  type A2ATaskStateType,
  type A2ATaskType,
  type CallStatusType,
  type HpkeEnvelopeType,
} from "@benree/agentcall-shared";
import type { TeamCallPrincipal } from "./call-lifecycle.js";

export type PersistedTask = {
  call_id: string;
  correlation_id: string;
  from: string;
  org: string;
  to: string;
  deadline: number;
  state: CallStatusType["state"];
  task_state: A2ATaskStateType;
  created_at: number;
  updated_at: number;
  principal?: TeamCallPrincipal;
  outcome_envelope?: HpkeEnvelopeType;
};

export type TaskListQuery = {
  status?: A2ATaskStateType;
  pageSize: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: number;
  includeArtifacts: boolean;
};

type Cursor = { createdAt: number; id: string };
const TERMINAL_TASK_STATES = new Set<A2ATaskStateType>([
  "TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED",
]);

export function taskBelongsToCaller(task: PersistedTask, caller: string): boolean {
  return task.from === caller;
}

export function taskState(task: PersistedTask): A2ATaskStateType {
  return task.task_state;
}

export function taskIsTerminal(task: PersistedTask): boolean {
  return TERMINAL_TASK_STATES.has(taskState(task));
}

export function taskCreatedAt(task: PersistedTask): number {
  return task.created_at;
}

export function taskUpdatedAt(task: PersistedTask): number {
  return task.updated_at;
}

export function toA2ATask(task: PersistedTask): A2ATaskType {
  const projected: A2ATaskType = {
    id: task.call_id,
    status: {
      state: taskState(task),
      timestamp: new Date(taskUpdatedAt(task)).toISOString(),
    },
  };
  return A2ATask.parse(projected);
}

export function updateTask(
  task: PersistedTask,
  update: Partial<Pick<PersistedTask, "task_state" | "outcome_envelope">>,
  now = Date.now(),
): PersistedTask {
  return { ...task, ...update, updated_at: now };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function queryFingerprint(query: TaskListQuery): string {
  return JSON.stringify({
    status: query.status ?? null,
    pageSize: query.pageSize,
    historyLength: query.historyLength ?? null,
    statusTimestampAfter: query.statusTimestampAfter ?? null,
    includeArtifacts: query.includeArtifacts,
  });
}

async function importCursorKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

async function encodeCursor(
  task: PersistedTask, caller: string, query: TaskListQuery, key: string, scope: string,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify([
    taskCreatedAt(task), task.call_id, caller, scope, queryFingerprint(query),
  ]));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importCursorKey(key), payload));
  return `${base64Url(payload)}.${base64Url(signature)}`;
}

async function decodeCursor(
  value: string | undefined, caller: string, query: TaskListQuery, key: string, scope: string,
): Promise<Cursor | undefined | null> {
  if (!value) return undefined;
  if (value.length > 1024) return null;
  const [payloadValue, signatureValue, extra] = value.split(".");
  if (!payloadValue || !signatureValue || extra !== undefined) return null;
  const payload = decodeBase64Url(payloadValue);
  const signature = decodeBase64Url(signatureValue);
  if (!payload || !signature) return null;
  try {
    if (!await crypto.subtle.verify(
      "HMAC",
      await importCursorKey(key),
      signature as Uint8Array<ArrayBuffer>,
      payload as Uint8Array<ArrayBuffer>,
    )) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payload));
    if (
      !Array.isArray(parsed) || parsed.length !== 5 ||
      typeof parsed[0] !== "number" || !Number.isFinite(parsed[0]) ||
      typeof parsed[1] !== "string" || parsed[1].length < 1 || parsed[1].length > 128 ||
      parsed[2] !== caller || parsed[3] !== scope || parsed[4] !== queryFingerprint(query)
    ) return null;
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

function afterCursor(task: PersistedTask, cursor: Cursor): boolean {
  const createdAt = taskCreatedAt(task);
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && task.call_id > cursor.id);
}

export async function listCallerTasks(
  allTasks: Iterable<PersistedTask>,
  caller: string,
  query: TaskListQuery,
  cursorKey: string,
  cursorScope: string,
): Promise<A2AListTasksResponseType | null> {
  const cursor = await decodeCursor(query.pageToken, caller, query, cursorKey, cursorScope);
  if (cursor === null) return null;

  // A HandleDO stores calls for every caller to one callee. This predicate is
  // the authorization boundary, not merely a display filter: GetTask uses the
  // same taskBelongsToCaller function, so point reads and listing cannot drift
  // into different visibility rules.
  const visible = [...allTasks]
    .filter((task) => taskBelongsToCaller(task, caller))
    .filter((task) => query.status === undefined || taskState(task) === query.status)
    .filter((task) => query.statusTimestampAfter === undefined || taskUpdatedAt(task) >= query.statusTimestampAfter)
    // Pagination must use immutable fields. Sorting by updated_at can move an
    // unseen task ahead of a page cursor when its lifecycle state changes,
    // causing that task to be skipped permanently.
    .sort((a, b) => taskCreatedAt(b) - taskCreatedAt(a) || a.call_id.localeCompare(b.call_id));

  const remaining = cursor ? visible.filter((task) => afterCursor(task, cursor)) : visible;
  const selected = remaining.slice(0, query.pageSize);
  const response: A2AListTasksResponseType = {
    tasks: selected.map((task) => toA2ATask(task)),
    nextPageToken: remaining.length > selected.length && selected.length > 0
      ? await encodeCursor(selected[selected.length - 1]!, caller, query, cursorKey, cursorScope)
      : "",
    pageSize: query.pageSize,
    totalSize: visible.length,
  };
  return A2AListTasksResponse.parse(response);
}

export function validHistoryLength(url: URL): boolean {
  const value = url.searchParams.get("historyLength");
  return value === null || (/^\d+$/.test(value) && Number(value) <= 2_147_483_647);
}

function parseRfc3339Timestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionalDigits = match[7] ?? "";
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]! ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  // Persisted task timestamps have millisecond precision. Rounding a positive
  // sub-millisecond lower bound upward preserves statusTimestampAfter instead
  // of accidentally including a task from the preceding millisecond.
  return timestamp + (/[1-9]/.test(fractionalDigits.slice(3)) ? 1 : 0);
}

export function parseTaskListQuery(url: URL): TaskListQuery | null {
  const contextId = url.searchParams.get("contextId") ?? undefined;
  // Context identifiers are encrypted call content after the Stage 2C cutover.
  // The relay cannot filter by a value it must not learn.
  if (contextId !== undefined) return null;
  const statusValue = url.searchParams.get("status") ?? undefined;
  const status = statusValue === undefined ? undefined : A2ATaskState.safeParse(statusValue);
  if (status && !status.success) return null;

  const pageSizeValue = url.searchParams.get("pageSize");
  const pageSize = pageSizeValue === null ? 50 : Number(pageSizeValue);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return null;

  if (!validHistoryLength(url)) return null;
  const historyLengthValue = url.searchParams.get("historyLength");

  const timestampValue = url.searchParams.get("statusTimestampAfter");
  const parsedTimestamp = timestampValue === null ? undefined : parseRfc3339Timestamp(timestampValue);
  if (parsedTimestamp === null) return null;

  const includeValue = url.searchParams.get("includeArtifacts");
  if (includeValue !== null && includeValue !== "true" && includeValue !== "false") return null;

  return {
    status: status?.data,
    pageSize,
    pageToken: url.searchParams.get("pageToken") ?? undefined,
    historyLength: historyLengthValue === null ? undefined : Number(historyLengthValue),
    statusTimestampAfter: parsedTimestamp,
    includeArtifacts: includeValue === "true",
  };
}
