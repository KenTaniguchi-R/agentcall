import { DurableObject } from "cloudflare:workers";
import {
  a2aError, CallerFrame, ListenerToRelayFrame, MAX_MESSAGE_BYTES, MAX_REPLY_BYTES,
  RATE_LIMIT_PER_HOUR, RELAY_CALL_TIMEOUT_MS, safeParseFrame, sanitizeDetail,
  standardError, type CallStatusType, type ErrorCodeType, type OrgAuditEvent,
} from "@benree/agentcall-shared";
import {
  listCallerTasks, parseTaskListQuery, taskBelongsToCaller, taskIsTerminal,
  toA2ATask, updateTask, validHistoryLength, type PersistedTask,
} from "./task-store.js";
import { MAX_RETAINED_ORG_AUDIT_EVENTS } from "./events.js";

type CallerAttachment = {
  kind: "caller";
  from: string;
  org?: string;
  to?: string;
  actorIp?: string;
  actorCountry?: string;
  groups: string[];
  call_id?: string;
  correlation_id?: string;
  timeoutMs?: number;
};
type ListenerAttachment = {
  kind: "listener";
  org?: string;
  handle?: string;
  actorIp?: string;
  actorCountry?: string;
};

type CallAuditEvent = Extract<OrgAuditEvent, `call.${string}`>;
type CallAuditIntent = {
  eventKey: string;
  event: CallAuditEvent;
  action: "C" | "U";
  org: string;
  actor: string;
  actorType: "handle" | "system";
  targetId: string;
  actorIp: string | null;
  actorCountry: string | null;
  description: string;
  at: number;
};

type CancelResolution = { kind: "canceled"; task: PersistedTask } | { kind: "not_cancelable" };

const STATUS_RANK: Record<CallStatusType["state"], number> = {
  ringing: 0,
  answered: 1,
  working: 2,
};

export const RATE_LIMIT_WINDOW_MS = 3_600_000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 60_000;
const RATE_LIMIT_PRUNE_PAGE_SIZE = 128;
export const RATE_LIMIT_PRUNE_MAX_PAGES = 4;
const RATE_LIMIT_PREFIX = "rl:";
const RATE_LIMIT_PRUNED_AT_KEY = "meta:rl-pruned-at";
const RATE_LIMIT_MAINTENANCE_KEY = "meta:rl-maintenance";
const RATE_LIMIT_PRUNE_CONTINUE_DELAY_MS = 1_000;
const CANCEL_CONFIRM_TIMEOUT_MS = 10_000;
const CALL_AUDIT_PREFIX = "audit:";
const CALL_AUDIT_RETRY_MS = 1_000;
// A D1 batch counts every statement against the per-Worker-invocation query
// limit (50 on Workers Free). In the worst case each intent belongs to a
// different org and needs its own retention trim, so 24 intents use at most 48
// statements and leave two queries of headroom.
const CALL_AUDIT_DRAIN_LIMIT = 24;
const CALL_AUDIT_RANK: Record<CallAuditEvent, number> = {
  "call.submit": 0,
  "call.accept": 1,
  "call.complete": 2,
  "call.fail": 2,
  "call.cancel": 2,
  "call.timeout": 2,
};
const A2A_HEADERS = { "Content-Type": "application/a2a+json" } as const;
type RateLimitMaintenance = { cursor: string; due: number };

export interface RateLimitStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
  put<T>(key: string, value: T): Promise<void>;
}

export async function readRateLimitMaintenance(
  storage: RateLimitStorage,
): Promise<RateLimitMaintenance | undefined> {
  const stored = await storage.get<unknown>(RATE_LIMIT_MAINTENANCE_KEY);
  if (stored === undefined) return undefined;
  if (
    typeof stored === "object" && stored !== null &&
    typeof (stored as Partial<RateLimitMaintenance>).cursor === "string" &&
    typeof (stored as Partial<RateLimitMaintenance>).due === "number" &&
    Number.isFinite((stored as Partial<RateLimitMaintenance>).due)
  ) {
    return stored as RateLimitMaintenance;
  }
  await storage.delete([RATE_LIMIT_MAINTENANCE_KEY]);
  return undefined;
}

async function pruneStaleRateLimitKeys(storage: RateLimitStorage, now: number): Promise<boolean> {
  const storedLastPrunedAt = await storage.get<unknown>(RATE_LIMIT_PRUNED_AT_KEY);
  const lastPrunedAt = typeof storedLastPrunedAt === "number" && Number.isFinite(storedLastPrunedAt)
    ? storedLastPrunedAt
    : undefined;
  const maintenance = await readRateLimitMaintenance(storage);
  const cursor = maintenance?.cursor;
  if (cursor === undefined && lastPrunedAt !== undefined && now - lastPrunedAt < RATE_LIMIT_PRUNE_INTERVAL_MS) {
    return false;
  }

  let startAfter = cursor;
  let complete = false;
  for (let pageNumber = 0; pageNumber < RATE_LIMIT_PRUNE_MAX_PAGES; pageNumber++) {
    const page = await storage.list<number[]>({
      prefix: RATE_LIMIT_PREFIX,
      startAfter,
      limit: RATE_LIMIT_PRUNE_PAGE_SIZE,
    });
    if (page.size === 0) {
      complete = true;
      break;
    }

    const keys = [...page.keys()];
    startAfter = keys[keys.length - 1]!;
    const stale = [...page.entries()]
      .filter(([, stamps]) => !Array.isArray(stamps) || !stamps.some(
        (stamp) => typeof stamp === "number" && Number.isFinite(stamp) && now - stamp < RATE_LIMIT_WINDOW_MS,
      ))
      .map(([key]) => key);
    if (stale.length > 0) await storage.delete(stale);
    if (page.size < RATE_LIMIT_PRUNE_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  await storage.put(RATE_LIMIT_PRUNED_AT_KEY, now);
  if (complete) {
    await storage.delete([RATE_LIMIT_MAINTENANCE_KEY]);
    return false;
  }

  // The cursor can temporarily contain one `rl:<handle>` key, but only while
  // a scheduled bounded continuation is draining the sweep. It is deleted as
  // soon as the end of the prefix is reached, never retained as an audit log.
  await storage.put<RateLimitMaintenance>(RATE_LIMIT_MAINTENANCE_KEY, {
    cursor: startAfter!,
    due: now + RATE_LIMIT_PRUNE_CONTINUE_DELAY_MS,
  });
  return true;
}

export async function readLiveRateLimitStamps(
  storage: RateLimitStorage, caller: string, now: number,
): Promise<number[]> {
  const stored = await storage.get<unknown>(`${RATE_LIMIT_PREFIX}${caller}`);
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (stamp): stamp is number => typeof stamp === "number" && Number.isFinite(stamp) && now - stamp < RATE_LIMIT_WINDOW_MS,
  );
}

export async function recordRateLimitHit(
  storage: RateLimitStorage, caller: string, liveStamps: number[], now: number,
): Promise<boolean> {
  const needsContinuation = await pruneStaleRateLimitKeys(storage, now);
  await storage.put(`${RATE_LIMIT_PREFIX}${caller}`, [...liveStamps, now]);
  return needsContinuation;
}

export async function continueRateLimitMaintenance(
  storage: RateLimitStorage, now: number,
): Promise<boolean> {
  const maintenance = await readRateLimitMaintenance(storage);
  if (!maintenance || maintenance.due > now) return false;
  return pruneStaleRateLimitKeys(storage, now);
}

/**
 * Clamp a caller-requested (test-only) timeout so it can only SHORTEN the
 * deadline, never extend it past RELAY_CALL_TIMEOUT_MS. Prevents a client
 * from passing an oversized test_timeout_ms to dodge the real cap.
 */
export function clampTimeoutMs(requestedMs: number | undefined): number {
  return Math.min(requestedMs ?? RELAY_CALL_TIMEOUT_MS, RELAY_CALL_TIMEOUT_MS);
}

/**
 * Truncate text to at most maxBytes of UTF-8, cutting on a code-point
 * boundary rather than a UTF-16 code-unit boundary — a naive
 * `text.slice(0, maxBytes)` can split a multi-byte character (e.g. CJK)
 * and either overshoot the byte cap or corrupt the string.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const sliced = bytes.slice(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(sliced).replace(/�+$/, "");
}

function callAuditIntent(
  event: CallAuditEvent,
  task: PersistedTask,
  actor: string,
  actorType: "handle" | "system",
  source: { actorIp?: string; actorCountry?: string },
  at: number,
): CallAuditIntent | undefined {
  if (!task.org || !task.to) return undefined;
  const description = event === "call.submit"
    ? `${task.from} submitted call ${task.call_id} to ${task.to}`
    : event === "call.accept"
      ? `${task.to} accepted call ${task.call_id} from ${task.from}`
      : event === "call.complete"
        ? `${task.to} completed call ${task.call_id} from ${task.from}`
        : event === "call.fail"
          ? `${task.to} failed call ${task.call_id} from ${task.from}`
          : event === "call.cancel"
            ? `${task.to} confirmed cancellation of call ${task.call_id} from ${task.from}`
            : `The relay expired call ${task.call_id} from ${task.from} to ${task.to}`;
  return {
    eventKey: `${task.org}:${task.call_id}:${event}`,
    event,
    action: event === "call.submit" ? "C" : "U",
    org: task.org,
    actor,
    actorType,
    targetId: task.call_id,
    actorIp: source.actorIp ?? null,
    actorCountry: source.actorCountry ?? null,
    description,
    at,
  };
}

export class HandleDO extends DurableObject {
  private readonly cancelWaiters = new Map<string, Set<(result: CancelResolution) => void>>();
  private readonly db: D1Database;

  constructor(ctx: DurableObjectState, env: { DB: D1Database }) {
    super(ctx, env as never);
    this.db = env.DB;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ online: this.ctx.getWebSockets("listener").length > 0 });
    }
    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role");
      if (role !== "listen" && role !== "call") {
        return new Response("bad role", { status: 400 });
      }
      const from = req.headers.get("X-Verified-From") ?? "";
      const org = req.headers.get("X-Verified-Org") || undefined;
      const target = req.headers.get("X-Verified-Target") || undefined;
      const actorIp = req.headers.get("X-Verified-Actor-IP") || undefined;
      const actorCountry = req.headers.get("X-Verified-Actor-Country") || undefined;
      let groups: string[] = [];
      try {
        const parsed = JSON.parse(req.headers.get("X-Verified-Groups") ?? "[]");
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) groups = parsed;
      } catch { /* malformed internal attestation fails closed to no groups */ }
      const testTimeout = Number(url.searchParams.get("test_timeout_ms") || "") || undefined;
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (role === "listen") {
        for (const old of this.ctx.getWebSockets("listener")) old.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["listener"]);
        server.serializeAttachment({
          kind: "listener", org, handle: target, actorIp, actorCountry,
        } satisfies ListenerAttachment);
      } else {
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({
          kind: "caller", from, org, to: target, actorIp, actorCountry,
          groups, timeoutMs: testTimeout,
        } satisfies CallerAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/tasks" && req.method === "GET") {
      const caller = req.headers.get("X-Verified-From") ?? "";
      if (!caller) return this.standardTaskError(401, "unauthorized");
      const query = parseTaskListQuery(url);
      if (!query) return this.standardTaskError(400, "invalid task list parameters");
      const tasks = await this.ctx.storage.list<PersistedTask>({ prefix: "call:" });
      const cursorKey = req.headers.get("X-Task-Cursor-Key") ?? "";
      const cursorScope = req.headers.get("X-Task-Cursor-Scope") ?? "";
      if (!cursorKey || !cursorScope) return this.standardTaskError(401, "unauthorized");
      const result = await listCallerTasks(tasks.values(), caller, query, cursorKey, cursorScope);
      if (!result) return this.standardTaskError(400, "invalid page token");
      return Response.json(result, { headers: A2A_HEADERS });
    }
    const cancelMatch = /^\/tasks\/([^/]+):cancel$/.exec(url.pathname);
    if (cancelMatch && req.method === "POST") {
      return this.cancelTask(decodeURIComponent(cancelMatch[1]!), req.headers.get("X-Verified-From") ?? "");
    }
    const getMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
    if (getMatch && req.method === "GET") {
      const caller = req.headers.get("X-Verified-From") ?? "";
      if (!caller) return this.standardTaskError(401, "unauthorized");
      if (!validHistoryLength(url)) return this.standardTaskError(400, "invalid historyLength");
      const task = await this.ctx.storage.get<PersistedTask>(`call:${decodeURIComponent(getMatch[1]!)}`);
      if (!task || !taskBelongsToCaller(task, caller)) return this.taskNotFound();
      return Response.json(toA2ATask(task), { headers: A2A_HEADERS });
    }
    return new Response("not found", { status: 404 });
  }

  private standardTaskError(status: number, message: string): Response {
    return Response.json(standardError(status, message).body, { status, headers: A2A_HEADERS });
  }

  private taskNotFound(): Response {
    const error = a2aError("TaskNotFound", "task does not exist or is not accessible");
    return Response.json(error.body, { status: error.status, headers: A2A_HEADERS });
  }

  private taskNotCancelable(): Response {
    const error = a2aError("TaskNotCancelable", "task cannot be canceled");
    return Response.json(error.body, { status: error.status, headers: A2A_HEADERS });
  }

  private settleCancellation(callId: string, result: CancelResolution): void {
    const waiters = this.cancelWaiters.get(callId);
    if (!waiters) return;
    this.cancelWaiters.delete(callId);
    for (const resolve of waiters) resolve(result);
  }

  private async cancelTask(callId: string, caller: string): Promise<Response> {
    if (!caller) return this.standardTaskError(401, "unauthorized");
    const task = await this.ctx.storage.get<PersistedTask>(`call:${callId}`);
    if (!task || !taskBelongsToCaller(task, caller)) return this.taskNotFound();
    if (taskIsTerminal(task)) return this.taskNotCancelable();
    const listener = this.ctx.getWebSockets("listener")[0];
    if (!listener) return this.taskNotCancelable();

    const firstRequest = !this.cancelWaiters.has(callId);
    const resultPromise = new Promise<CancelResolution>((resolve) => {
      const waiters = this.cancelWaiters.get(callId) ?? new Set();
      let waiter: (result: CancelResolution) => void;
      const timeout = setTimeout(() => {
        const current = this.cancelWaiters.get(callId);
        current?.delete(waiter);
        if (current?.size === 0) this.cancelWaiters.delete(callId);
        resolve({ kind: "not_cancelable" });
      }, Math.min(CANCEL_CONFIRM_TIMEOUT_MS, Math.max(1, task.deadline - Date.now())));
      waiter = (settled) => {
        clearTimeout(timeout);
        resolve(settled);
      };
      waiters.add(waiter);
      this.cancelWaiters.set(callId, waiters);
    });
    if (firstRequest) this.send(listener, { type: "cancel_call", call_id: callId });
    const result = await resultPromise;

    return result.kind === "canceled"
      ? Response.json(toA2ATask(result.task), { headers: A2A_HEADERS })
      : this.taskNotCancelable();
  }

  private send(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* socket gone */ }
  }

  private fail(
    ws: WebSocket,
    code: ErrorCodeType,
    detail?: string,
    offered?: string[],
    close = true,
    context: { call_id?: string; correlation_id?: string } = {},
  ): void {
    this.send(ws, { type: "call_error", code, detail, offered, ...context });
    if (close) { try { ws.close(1000, code); } catch { /* already closed */ } }
  }

  private callerFor(callId: string): WebSocket | undefined {
    return this.ctx.getWebSockets("caller").find(
      (w) => (w.deserializeAttachment() as CallerAttachment | null)?.call_id === callId,
    );
  }

  private async persistTaskWithAudit(task: PersistedTask, intent?: CallAuditIntent): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put<PersistedTask>(`call:${task.call_id}`, task);
      if (intent) {
        await txn.put<CallAuditIntent>(this.auditOutboxKey(intent), intent);
        await this.armAuditRetry(txn);
      }
    });
    await this.flushAuditOutbox();
  }

  private async armAuditRetry(txn: DurableObjectTransaction): Promise<void> {
    const retryAt = Date.now() + CALL_AUDIT_RETRY_MS;
    const current = await txn.getAlarm();
    if (current === null || current > retryAt) await txn.setAlarm(retryAt);
  }

  private auditOutboxKey(intent: CallAuditIntent): string {
    // Storage.list is lexicographic. Preserve lifecycle order when two
    // transitions share one millisecond so D1 IDs cannot invert submit/accept
    // or accepted/terminal evidence with identical event timestamps.
    return `${CALL_AUDIT_PREFIX}${String(intent.at).padStart(16, "0")}:${CALL_AUDIT_RANK[intent.event]}:${intent.eventKey}`;
  }

  private async flushAuditOutbox(): Promise<void> {
    const pending = await this.ctx.storage.list<CallAuditIntent>({
      prefix: CALL_AUDIT_PREFIX,
      limit: CALL_AUDIT_DRAIN_LIMIT,
    });
    if (pending.size === 0) return;
    try {
      const orgs = [...new Set([...pending.values()].map((intent) => intent.org))];
      await this.db.batch([
        ...[...pending.values()].map((intent) => this.db.prepare(
          "INSERT INTO org_events (event_key, event, action_type, org, actor, actor_type, " +
            "target_type, target_id, target_role, actor_ip, actor_country, description, at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'call', ?, NULL, ?, ?, ?, ?) " +
            "ON CONFLICT(event_key) DO NOTHING",
        ).bind(
          intent.eventKey, intent.event, intent.action, intent.org, intent.actor, intent.actorType,
          intent.targetId, intent.actorIp, intent.actorCountry, intent.description, intent.at,
        )),
        ...orgs.map((org) => this.db.prepare(
          "DELETE FROM org_events WHERE org = ? AND id NOT IN (" +
            "SELECT id FROM org_events WHERE org = ? ORDER BY id DESC LIMIT ?)",
        ).bind(org, org, MAX_RETAINED_ORG_AUDIT_EVENTS)),
      ]);
      await this.ctx.storage.delete([...pending.keys()]);
      await this.scheduleNextAlarm();
    } catch (error) {
      // Keep the atomic outbox entry for alarm retry. Never log SQL or bound
      // tenant values because platform wrappers can include both.
      console.error("call audit delivery failure", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      await this.ctx.storage.setAlarm(Date.now() + CALL_AUDIT_RETRY_MS);
    }
  }

  private async expireTask(
    callId: string,
    now: number,
  ): Promise<{ task: PersistedTask; timedOut: boolean } | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      // Alarm snapshots can go stale while another task's D1 delivery yields.
      // Re-read and decide inside the same transaction that deletes/enqueues so
      // a concurrent terminal completion can never be overwritten by timeout.
      const current = await txn.get<PersistedTask>(`call:${callId}`);
      if (!current || current.deadline > now) return;
      await txn.delete(`call:${callId}`);
      if (taskIsTerminal(current)) {
        return { task: current, timedOut: false };
      }
      const intent = callAuditIntent("call.timeout", current, "relay", "system", {}, now);
      if (intent) {
        await txn.put<CallAuditIntent>(this.auditOutboxKey(intent), intent);
        await this.armAuditRetry(txn);
      }
      return { task: current, timedOut: true };
    });
  }

  private async advanceCall(
    record: PersistedTask,
    state: CallStatusType["state"],
    caller: WebSocket | undefined,
    listener: ListenerAttachment,
  ): Promise<void> {
    const current = record.state ?? "ringing";
    if (STATUS_RANK[state] <= STATUS_RANK[current]) return;
    // Persist before fan-out so a DO restart or duplicate/out-of-order frame
    // cannot move the caller backward after it has observed a later state.
    const next = {
      ...record,
      state,
      task_state: state === "working" ? "TASK_STATE_WORKING" : (record.task_state ?? "TASK_STATE_SUBMITTED"),
      updated_at: Date.now(),
    } satisfies PersistedTask;
    // Starting work from ringing is an implicit acceptance (including the
    // legacy call_answer path), so it must not leave a lifecycle gap. A later
    // explicit acceptance is rank-rejected and cannot duplicate the event.
    const accepted = state === "answered" || (state === "working" && current === "ringing")
      ? callAuditIntent("call.accept", next, record.to ?? listener.handle ?? "", "handle", listener, next.updated_at!)
      : undefined;
    if (accepted) await this.persistTaskWithAudit(next, accepted);
    else await this.ctx.storage.put<PersistedTask>(`call:${record.call_id}`, next);
    if (caller) {
      this.send(caller, {
        type: "call_status", state, call_id: record.call_id,
        correlation_id: record.correlation_id,
      });
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as CallerAttachment | ListenerAttachment | null;
    if (!att) return;

    if (att.kind === "caller") {
      if (att.call_id) {
        return this.fail(ws, "protocol_error", undefined, undefined, true, {
          call_id: att.call_id,
          correlation_id: att.correlation_id,
        });
      }
      const frame = safeParseFrame(CallerFrame, raw);
      if (!frame) return this.fail(ws, "protocol_error");
      // New callers always mint this. During mixed-version overlap, minting at
      // the first new relay preserves delivery and gives the new listener a
      // bounded application join key even when the old caller omitted it.
      const correlation_id = frame.correlation_id ?? crypto.randomUUID().replaceAll("-", "");

      // Rate limit is checked before the size check so an over-budget caller
      // is turned away before an oversized-message parse/response cycle, but
      // an oversized frame still charges one unit of the hourly budget
      // below — otherwise unlimited oversized frames could be sent for free
      // without ever tripping the limit.
      const now = Date.now();
      const stamps = await readLiveRateLimitStamps(this.ctx.storage, att.from, now);
      if (stamps.length >= RATE_LIMIT_PER_HOUR) {
        return this.fail(ws, "rate_limited", undefined, undefined, true, { correlation_id });
      }

      if (new TextEncoder().encode(frame.message).byteLength > MAX_MESSAGE_BYTES) {
        const needsContinuation = await recordRateLimitHit(this.ctx.storage, att.from, stamps, now);
        if (needsContinuation) await this.scheduleNextAlarm();
        return this.fail(ws, "message_too_large", undefined, undefined, true, { correlation_id });
      }
      const listener = this.ctx.getWebSockets("listener")[0];
      if (!listener) return this.fail(ws, "offline", undefined, undefined, true, { correlation_id });

      await recordRateLimitHit(this.ctx.storage, att.from, stamps, now);
      const call_id = crypto.randomUUID();
      const deadline = now + clampTimeoutMs(att.timeoutMs);
      ws.serializeAttachment({ ...att, call_id, correlation_id });
      const task = {
        call_id, correlation_id, from: att.from, org: att.org, to: att.to, deadline, state: "ringing",
        task_state: "TASK_STATE_SUBMITTED", created_at: now, updated_at: now,
        context_id: frame.context_id,
      } satisfies PersistedTask;
      await this.persistTaskWithAudit(
        task,
        callAuditIntent("call.submit", task, att.from, "handle", att, now),
      );
      await this.scheduleNextAlarm();
      this.send(ws, { type: "call_status", state: "ringing", call_id, correlation_id });
      this.send(listener, {
        type: "incoming_call", call_id, correlation_id, traceparent: frame.traceparent,
        from: att.from, groups: att.groups,
        message: frame.message, context_id: frame.context_id, task: frame.task,
      });
      return;
    }

    // listener frames
    const frame = safeParseFrame(ListenerToRelayFrame, raw);
    if (!frame) return;
    const record = await this.ctx.storage.get<PersistedTask>(`call:${frame.call_id}`);
    if (!record) return; // stale/unknown call
    if (taskIsTerminal(record)) return; // duplicate/out-of-order terminal frame
    const caller = this.callerFor(frame.call_id);

    if (frame.type === "call_accepted") {
      await this.advanceCall(record, "answered", caller, att);
      return;
    }
    if (frame.type === "call_answer" || frame.type === "call_started") {
      // Legacy call_answer was emitted only once the job started, so preserve
      // that truth when old listeners overlap a new relay deployment.
      await this.advanceCall(record, "working", caller, att);
      return;
    }
    if (frame.type === "call_cancelled") {
      // Confirmation means a pending job was removed or the running process
      // was observed exited. Only now is it honest to publish a terminal
      // cancellation. The task record remains until its original deadline.
      const canceled = updateTask(record, { task_state: "TASK_STATE_CANCELED" });
      // Persist terminal truth before fan-out. Once a caller observes a
      // terminal response, a concurrent GetTask must never move backward.
      await this.persistTaskWithAudit(
        canceled,
        callAuditIntent("call.cancel", canceled, record.to ?? att.handle ?? "", "handle", att, canceled.updated_at!),
      );
      if (caller) {
        this.fail(caller, "canceled", undefined, undefined, true, {
          call_id: frame.call_id, correlation_id: record.correlation_id,
        });
      }
      this.settleCancellation(frame.call_id, { kind: "canceled", task: canceled });
      return;
    }
    if (frame.type === "call_not_cancelled") {
      // Cancellation is two-phase. A refusal is not terminal: completion may
      // still win and must be allowed to deliver its result. The producer of
      // cancel_call arrives with the durable A2A task store in #9; handling the
      // acknowledgement here keeps the listener/relay link complete first.
      this.settleCancellation(frame.call_id, { kind: "not_cancelable" });
      return;
    }
    if (frame.type === "call_result") {
      const text = truncateUtf8Bytes(frame.text, MAX_REPLY_BYTES);
      const completed = updateTask(record, {
        task_state: "TASK_STATE_COMPLETED",
        context_id: frame.context_id ?? record.context_id,
        result_text: text,
      });
      await this.persistTaskWithAudit(
        completed,
        callAuditIntent("call.complete", completed, record.to ?? att.handle ?? "", "handle", att, completed.updated_at!),
      );
      if (caller) {
        this.send(caller, {
          type: "call_reply", call_id: frame.call_id, correlation_id: record.correlation_id,
          text, context_id: frame.context_id, task: frame.task,
        });
        try { caller.close(1000, "done"); } catch { /* closed */ }
      }
      this.settleCancellation(frame.call_id, { kind: "not_cancelable" });
      return;
    }
    if (frame.type === "call_failed") {
      // The listener is an untrusted peer here — same posture as call_result's
      // text above. sanitizeDetail bounds the string and strips the control
      // characters that would otherwise reach the caller's terminal verbatim.
      const detail = frame.detail === undefined ? undefined : sanitizeDetail(frame.detail);
      const failed = updateTask(record, {
        task_state: "TASK_STATE_FAILED", failure_code: frame.code,
      });
      await this.persistTaskWithAudit(
        failed,
        callAuditIntent("call.fail", failed, record.to ?? att.handle ?? "", "handle", att, failed.updated_at!),
      );
      if (caller) {
        this.fail(caller, frame.code, detail, frame.offered, true, {
          call_id: frame.call_id, correlation_id: record.correlation_id,
        });
      }
      this.settleCancellation(frame.call_id, { kind: "not_cancelable" });
    }
  }

  override async webSocketClose(_ws: WebSocket): Promise<void> {
    // Caller disconnect is not task deletion. A2A GetTask/ListTasks must be
    // able to recover this record until its original call deadline.
    // listener close: keep in-flight calls; a reconnected listener may still deliver results.
  }

  private async scheduleNextAlarm(): Promise<void> {
    const calls = await this.ctx.storage.list<PersistedTask>({ prefix: "call:" });
    let min = Infinity;
    for (const rec of calls.values()) min = Math.min(min, rec.deadline);
    const pendingAudit = await this.ctx.storage.list<CallAuditIntent>({ prefix: CALL_AUDIT_PREFIX, limit: 1 });
    if (pendingAudit.size > 0) min = Math.min(min, Date.now() + CALL_AUDIT_RETRY_MS);
    const maintenance = await readRateLimitMaintenance(this.ctx.storage);
    if (maintenance) min = Math.min(min, maintenance.due);
    if (min !== Infinity) await this.ctx.storage.setAlarm(min);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const calls = await this.ctx.storage.list<PersistedTask>({ prefix: "call:" });
    const timedOut: PersistedTask[] = [];
    for (const rec of calls.values()) {
      if (rec.deadline <= now) {
        if (timedOut.length >= CALL_AUDIT_DRAIN_LIMIT) break;
        const expired = await this.expireTask(rec.call_id, now);
        if (expired?.timedOut) timedOut.push(expired.task);
      }
    }
    // One budget-safe D1 drain per alarm invocation. A larger retained backlog
    // keeps the atomically armed alarm and drains over subsequent invocations.
    await this.flushAuditOutbox();
    for (const rec of timedOut) {
      const caller = this.callerFor(rec.call_id);
      if (caller) {
        this.fail(caller, "timeout", undefined, undefined, true, {
          call_id: rec.call_id, correlation_id: rec.correlation_id,
        });
      }
      this.settleCancellation(rec.call_id, { kind: "not_cancelable" });
    }
    await continueRateLimitMaintenance(this.ctx.storage, now);
    await this.scheduleNextAlarm();
  }
}
