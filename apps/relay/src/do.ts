import { DurableObject } from "cloudflare:workers";
import { formatAddress,
  a2aError, E2EECallerFrame, E2EEListenerToRelayFrame, MAX_E2EE_WIRE_BYTES,
  RATE_LIMIT_PER_HOUR, RELAY_CALL_TIMEOUT_MS, safeParseFrame, standardError,
  type CallStatusType, type OrgAuditEvent, type RelayOperationalErrorCodeType,
} from "@benree/agentcall-shared";
import {
  listCallerTasks, parseTaskListQuery, taskBelongsToCaller, taskIsTerminal,
  toA2ATask, updateTask, validHistoryLength, type PersistedTask,
} from "./task-store.js";
import { MAX_RETAINED_ORG_AUDIT_EVENTS } from "./events.js";
import {
  continueRateLimitMaintenance, readLiveRateLimitStamps, readRateLimitMaintenance, recordRateLimitHit,
} from "./call-rate-limit.js";
import {
  advanceAuthorizedCall, beginAuthorizedCall, expireAuthorizedCall, terminateAuthorizedCall,
  type CallLifecycle, type LiveCallPhase, type TeamCallPrincipal,
} from "./call-lifecycle.js";

export function recordCallPresenceRead(statusReads: AnalyticsEngineDataset): void {
  statusReads.writeDataPoint({ indexes: ["allowed"], doubles: [Date.now()] });
}

type CallerAttachment = {
  kind: "caller";
  principal: TeamCallPrincipal;
  from: string;
  org: string;
  to: string;
  actorIp?: string;
  actorCountry?: string;
  relayOrigin: string;
  call_id?: string;
  correlation_id?: string;
  timeoutMs?: number;
  credentialGeneration?: number;
};
type ListenerAttachment = {
  kind: "listener";
  principal?: TeamCallPrincipal;
  org?: string;
  handle?: string;
  actorIp?: string;
  actorCountry?: string;
  relayOrigin?: string;
  credentialGeneration?: number;
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

const DURABLE_PHASE: Record<CallStatusType["state"], LiveCallPhase> = {
  ringing: "submitted",
  answered: "accepted",
  working: "working",
};

function teamCallLifecycle(task: PersistedTask): CallLifecycle {
  return {
    principal: task.principal ?? {
      kind: "team",
      organization: task.org,
      participant: task.from,
      credential_generation: 0,
    },
    phase: DURABLE_PHASE[task.state],
    deadline: task.deadline,
  };
}

const CANCEL_CONFIRM_TIMEOUT_MS = 10_000;
const CALL_AUDIT_PREFIX = "audit:";
const CALL_AUDIT_RETRY_MS = 1_000;
const CREDENTIAL_GENERATION_FLOOR_PREFIX = "meta:credential-generation-floor:";
// Keyed by the stable identity, not the address (#154 slice 4). This floor is
// what stops a credential revoked by recovery from reconnecting, and it is
// durable object storage — keyed by handle it would reset the moment an
// address moved, silently readmitting revoked credentials.
const credentialGenerationFloorKey = (org: string, agentId: string) =>
  `${CREDENTIAL_GENERATION_FLOOR_PREFIX}${JSON.stringify([org, agentId])}`;
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

/**
 * Clamp a caller-requested (test-only) timeout so it can only SHORTEN the
 * deadline, never extend it past RELAY_CALL_TIMEOUT_MS. Prevents a client
 * from passing an oversized test_timeout_ms to dodge the real cap.
 */
export function clampTimeoutMs(requestedMs: number | undefined): number {
  return Math.min(requestedMs ?? RELAY_CALL_TIMEOUT_MS, RELAY_CALL_TIMEOUT_MS);
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
  private readonly statusReads: AnalyticsEngineDataset;

  constructor(ctx: DurableObjectState, env: { DB: D1Database; STATUS_READS: AnalyticsEngineDataset }) {
    super(ctx, env as never);
    this.db = env.DB;
    this.statusReads = env.STATUS_READS;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/credentials/evict" && req.method === "POST") {
      const org = req.headers.get("X-Credential-Org") ?? "";
      // Two distinct jobs: agentId keys the durable floor below, handle
      // matches the live sockets further down. Neither substitutes for the
      // other, so both are required rather than one being derived.
      const handle = req.headers.get("X-Credential-Handle") ?? "";
      const agentId = req.headers.get("X-Credential-Agent-Id") ?? "";
      const generation = Number(req.headers.get("X-Recovery-Generation"));
      if (!org || !handle || !agentId || !Number.isSafeInteger(generation) || generation < 1) {
        return Response.json({ error: "invalid eviction command" }, { status: 400 });
      }
      const floorKey = credentialGenerationFloorKey(org, agentId);
      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<number>(floorKey) ?? 0;
        if (generation > current) await txn.put(floorKey, generation);
      });
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as CallerAttachment | ListenerAttachment | null;
        const credentialHandle = attachment?.kind === "caller" ? attachment.from : attachment?.handle;
        if (attachment?.org !== org || credentialHandle !== handle ||
          (attachment.credentialGeneration ?? 0) >= generation) continue;
        try { socket.close(4001, "credentials revoked"); } catch { /* already closed */ }
      }
      return Response.json({ evicted: true });
    }
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
      const relayOrigin = req.headers.get("X-Verified-Relay-Origin") || undefined;
      const credentialGeneration = Number(req.headers.get("X-Verified-Credential-Generation")) || 0;
      const principal = org && from
        ? {
          kind: "team" as const,
          organization: org,
          participant: from,
          credential_generation: credentialGeneration,
        }
        : undefined;
      // Keyed by the connecting party's identity, not its address: this floor
      // is what keeps a credential revoked by recovery from reconnecting, and
      // keyed by handle it would reset whenever an address moved.
      const fromAgentId = req.headers.get("X-Verified-Agent-Id") ?? "";
      const credentialGenerationFloor = await this.ctx.storage.get<number>(
        credentialGenerationFloorKey(org ?? "", fromAgentId),
      ) ?? 0;
      if (credentialGeneration < credentialGenerationFloor) {
        return new Response("stale credentials", { status: 401 });
      }
      const testTimeout = Number(url.searchParams.get("test_timeout_ms") || "") || undefined;
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (role === "listen") {
        for (const old of this.ctx.getWebSockets("listener")) old.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["listener"]);
        server.serializeAttachment({
          kind: "listener", principal, org, handle: target, actorIp, actorCountry, relayOrigin,
          credentialGeneration,
        } satisfies ListenerAttachment);
      } else {
        if (!org || !target || !relayOrigin || !principal) {
          return new Response("missing verified caller metadata", { status: 400 });
        }
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({
          kind: "caller", principal: principal!, from, org, to: target, actorIp, actorCountry,
          timeoutMs: testTimeout, relayOrigin,
          credentialGeneration,
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
    code: RelayOperationalErrorCodeType,
    close = true,
    context: { call_id?: string; correlation_id?: string } = {},
  ): void {
    this.send(ws, { type: "call_error", origin: "relay", code, ...context });
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
      if (!current || !expireAuthorizedCall(teamCallLifecycle(current), now)) return;
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
    const current = record.state;
    const advanced = advanceAuthorizedCall(teamCallLifecycle(record), DURABLE_PHASE[state]);
    if (advanced.phase === DURABLE_PHASE[current]) return;
    // Persist before fan-out so a DO restart or duplicate/out-of-order frame
    // cannot move the caller backward after it has observed a later state.
    const next = {
      ...record,
      state,
      task_state: state === "working" ? "TASK_STATE_WORKING" : record.task_state,
      updated_at: Date.now(),
    } satisfies PersistedTask;
    // Starting work from ringing is an implicit acceptance, so it must not
    // leave a lifecycle gap. A later
    // explicit acceptance is rank-rejected and cannot duplicate the event.
    const accepted = state === "answered" || (state === "working" && current === "ringing")
      ? callAuditIntent("call.accept", next, record.to, "handle", listener, next.updated_at)
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
        return this.fail(ws, "protocol_error", true, {
          call_id: att.call_id,
          correlation_id: att.correlation_id,
        });
      }
      const oversized = new TextEncoder().encode(raw).byteLength > MAX_E2EE_WIRE_BYTES;
      const now = Date.now();
      const stamps = await readLiveRateLimitStamps(this.ctx.storage, att.from, now);
      if (stamps.length >= RATE_LIMIT_PER_HOUR) {
        return this.fail(ws, "rate_limited", true);
      }
      if (oversized) {
        await recordRateLimitHit(this.ctx.storage, att.from, stamps, now);
        await this.scheduleNextAlarm();
        return this.fail(ws, "message_too_large");
      }
      const frame = safeParseFrame(E2EECallerFrame, raw);
      if (!frame) return this.fail(ws, "protocol_error");
      if (
        !att.relayOrigin || !att.to ||
        frame.envelope.relay_origin !== att.relayOrigin ||
        frame.envelope.from !== formatAddress(att.org, att.from) ||
        frame.envelope.to !== formatAddress(att.org, att.to)
      ) return this.fail(ws, "protocol_error");
      const correlation_id = frame.correlation_id!;

      const listener = this.ctx.getWebSockets("listener")[0];
      if (!listener) {
        try { recordCallPresenceRead(this.statusReads); } catch { /* telemetry cannot block calls */ }
        return this.fail(ws, "offline", true, { correlation_id });
      }

      await recordRateLimitHit(this.ctx.storage, att.from, stamps, now);
      const call_id = crypto.randomUUID();
      const deadline = now + clampTimeoutMs(att.timeoutMs);
      ws.serializeAttachment({ ...att, call_id, correlation_id });
      const task = {
        call_id, correlation_id, from: att.from, org: att.org, to: att.to, deadline, state: "ringing",
        task_state: "TASK_STATE_SUBMITTED", created_at: now, updated_at: now,
        principal: beginAuthorizedCall(att.principal, deadline).principal,
      } satisfies PersistedTask;
      await this.persistTaskWithAudit(
        task,
        callAuditIntent("call.submit", task, att.from, "handle", att, now),
      );
      await this.scheduleNextAlarm();
      this.send(ws, { type: "call_status", state: "ringing", call_id, correlation_id });
      this.send(listener, {
        type: "incoming_call", call_id, correlation_id, traceparent: frame.traceparent,
        from: att.from,
        envelope: frame.envelope,
      });
      return;
    }

    // listener frames
    if (new TextEncoder().encode(raw).byteLength > MAX_E2EE_WIRE_BYTES) return;
    const frame = safeParseFrame(E2EEListenerToRelayFrame, raw);
    if (!frame) return;
    const record = await this.ctx.storage.get<PersistedTask>(`call:${frame.call_id}`);
    if (!record) return; // stale/unknown call
    if (taskIsTerminal(record)) return; // duplicate/out-of-order terminal frame
    const caller = this.callerFor(frame.call_id);

    if (frame.type === "call_accepted") {
      await this.advanceCall(record, "answered", caller, att);
      return;
    }
    if (frame.type === "call_started") {
      await this.advanceCall(record, "working", caller, att);
      return;
    }
    if (frame.type === "call_cancelled") {
      // Confirmation means a pending job was removed or the running process
      // was observed exited. Only now is it honest to publish a terminal
      // cancellation. The task record remains until its original deadline.
      const cancellation = terminateAuthorizedCall(teamCallLifecycle(record), "canceled");
      const canceled = updateTask(record, { task_state: "TASK_STATE_CANCELED" });
      canceled.principal = cancellation.principal;
      // Persist terminal truth before fan-out. Once a caller observes a
      // terminal response, a concurrent GetTask must never move backward.
      await this.persistTaskWithAudit(
        canceled,
        callAuditIntent("call.cancel", canceled, record.to, "handle", att, canceled.updated_at),
      );
      if (caller) {
        this.fail(caller, "canceled", true, {
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
    if (frame.type === "call_rejected") {
      const failed = updateTask(record, { task_state: "TASK_STATE_FAILED" });
      await this.persistTaskWithAudit(
        failed,
        callAuditIntent("call.fail", failed, record.to, "handle", att, failed.updated_at),
      );
      if (caller) this.fail(caller, "protocol_error", true, {
        call_id: frame.call_id, correlation_id: record.correlation_id,
      });
      this.settleCancellation(frame.call_id, { kind: "not_cancelable" });
      return;
    }
    if (frame.type === "call_outcome") {
      if (
        !att.relayOrigin || !att.handle || !att.org ||
        frame.envelope.relay_origin !== att.relayOrigin ||
        frame.envelope.from !== formatAddress(att.org, att.handle) ||
        frame.envelope.to !== formatAddress(att.org, record.from)
      ) return;
      const terminal = frame.terminal === "completed"
        ? "TASK_STATE_COMPLETED" as const
        : "TASK_STATE_FAILED" as const;
      const finished = updateTask(record, {
        task_state: terminal,
        outcome_envelope: frame.envelope,
      });
      const intent = frame.terminal === "completed"
        ? callAuditIntent("call.complete", finished, record.to, "handle", att, finished.updated_at)
        : callAuditIntent("call.fail", finished, record.to, "handle", att, finished.updated_at);
      await this.persistTaskWithAudit(
        finished,
        intent,
      );
      if (caller) {
        this.send(caller, frame);
        try { caller.close(1000, "done"); } catch { /* closed */ }
      }
      this.settleCancellation(frame.call_id, { kind: "not_cancelable" });
      return;
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
        this.fail(caller, "timeout", true, {
          call_id: rec.call_id, correlation_id: rec.correlation_id,
        });
      }
      this.settleCancellation(rec.call_id, { kind: "not_cancelable" });
    }
    await continueRateLimitMaintenance(this.ctx.storage, now);
    await this.scheduleNextAlarm();
  }
}
