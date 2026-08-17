import { DurableObject } from "cloudflare:workers";
import { formatAddress,
  a2aError, E2EECallerFrame, E2EEListenerToRelayFrame, MAX_E2EE_WIRE_BYTES,
  MAILBOX_TOMBSTONE_TTL_MS, MAILBOX_TTL_MS, RATE_LIMIT_PER_HOUR, RELAY_CALL_TIMEOUT_MS,
  MAILBOX_MAX_OUTSTANDING_PER_CALLER, MAILBOX_MAX_QUEUED_TASKS,
  MAILBOX_MAX_STARTS_PER_DAY, MAILBOX_MAX_STORED_CIPHERTEXT_BYTES,
  safeParseFrame, standardError,
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
import { parseStoredCard } from "./stored-card.js";

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
  fromAgentId: string;
  targetAgentId: string;
  mailboxEnabled: boolean;
  callerBlocked: boolean;
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
  mailboxCapable?: boolean;
  listenerSessionId?: string;
  leaseMs?: number;
  executionTimeoutMs?: number;
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
type DedupeRecord = { call_id: string; request_envelope_sha256: string; purge_at: number };
type DurableAdmission =
  | { kind: "admitted"; task: PersistedTask }
  | { kind: "existing"; task: PersistedTask }
  | { kind: "capacity" }
  | { kind: "conflict" };

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
const DEDUPE_PREFIX = "dedupe:";
const QUEUE_PREFIX = "queue:";
const DUE_PREFIX = "due:";
const ACTIVE_DURABLE_CALL_KEY = "meta:active-durable-call";
const QUOTA_OUTSTANDING_KEY = "quota:outstanding";
const QUOTA_CIPHERTEXT_BYTES_KEY = "quota:ciphertext-bytes";
const START_PREFIX = "start:";
const START_WINDOW_MS = 24 * 60 * 60_000;
const startKey = (at: number, callId: string) => `${START_PREFIX}${String(at).padStart(16, "0")}:${callId}`;
const quotaCallerKey = (fromAgentId: string) => `quota:caller:${fromAgentId}`;
const DELIVERY_LEASE_MS = 30_000;
const dedupeKey = (fromAgentId: string, messageId: string) =>
  `${DEDUPE_PREFIX}${JSON.stringify([fromAgentId, messageId])}`;
const queueKey = (task: Pick<PersistedTask, "created_at" | "call_id">) =>
  `${QUEUE_PREFIX}${String(task.created_at).padStart(16, "0")}:${task.call_id}`;
const dueKey = (task: Pick<PersistedTask, "deadline" | "call_id">) =>
  `${DUE_PREFIX}${String(task.deadline).padStart(16, "0")}:${task.call_id}`;
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
  const reason = task.terminal_reason ? ` (reason: ${task.terminal_reason})` : "";
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
    description: `${description}${reason}`,
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
      const targetAgentId = req.headers.get("X-Verified-Target-Agent-Id") ?? "";
      const mailboxEnabled = req.headers.get("X-Verified-Mailbox-Enabled") === "true";
      const callerBlocked = req.headers.get("X-Verified-Caller-Blocked") === "true";
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
        const listenerSessionId = url.searchParams.get("listener_session_id") ?? "";
        const mailboxCapable = url.searchParams.get("capability") === "durable-mailbox-v1" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(listenerSessionId);
        for (const old of this.ctx.getWebSockets("listener")) old.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["listener"]);
        const listenerAttachment = {
          kind: "listener", principal, org, handle: target, actorIp, actorCountry, relayOrigin,
          credentialGeneration, mailboxCapable, listenerSessionId: mailboxCapable ? listenerSessionId : undefined,
          leaseMs: Math.min(DELIVERY_LEASE_MS, testTimeout ?? DELIVERY_LEASE_MS),
          executionTimeoutMs: Number(url.searchParams.get("test_execution_timeout_ms") || "") || undefined,
        } satisfies ListenerAttachment;
        server.serializeAttachment(listenerAttachment);
        if (mailboxCapable) await this.dispatchNext(server, listenerAttachment);
      } else {
        if (!org || !target || !relayOrigin || !principal) {
          return new Response("missing verified caller metadata", { status: 400 });
        }
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({
          kind: "caller", principal: principal!, from, org, to: target, actorIp, actorCountry,
          timeoutMs: testTimeout, relayOrigin,
          credentialGeneration, fromAgentId, targetAgentId, mailboxEnabled, callerBlocked,
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
      const includeArtifactsValue = url.searchParams.get("includeArtifacts");
      if (includeArtifactsValue !== null && includeArtifactsValue !== "true" && includeArtifactsValue !== "false") {
        return this.standardTaskError(400, "invalid includeArtifacts");
      }
      const task = await this.ctx.storage.get<PersistedTask>(`call:${decodeURIComponent(getMatch[1]!)}`);
      if (!task || !taskBelongsToCaller(task, caller)) return this.taskNotFound();
      return Response.json(toA2ATask(task, includeArtifactsValue === "true"), { headers: A2A_HEADERS });
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
    let task = await this.ctx.storage.get<PersistedTask>(`call:${callId}`);
    if (!task || !taskBelongsToCaller(task, caller)) return this.taskNotFound();
    if (taskIsTerminal(task)) return this.taskNotCancelable();
    if (task.delivery_state === "queued" || task.delivery_state === "leased") {
      let canceled: PersistedTask | undefined;
      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<PersistedTask>(`call:${callId}`);
        if (!current || taskIsTerminal(current)) return;
        if (current.delivery_state !== "queued" && current.delivery_state !== "leased") {
          task = current;
          return;
        }
        const cancellation = terminateAuthorizedCall(teamCallLifecycle(current), "canceled");
        const { request_envelope: _discarded, lease: _lease, ...withoutCiphertext } = current;
        canceled = {
          ...withoutCiphertext,
          principal: cancellation.principal,
          deadline: current.purge_at ?? current.deadline,
          task_state: "TASK_STATE_CANCELED",
          delivery_state: "terminal",
          terminal_reason: "canceled",
          ciphertext_bytes: 0,
          updated_at: Date.now(),
        };
        const intent = callAuditIntent(
          "call.cancel", canceled, current.from, "handle", {}, canceled.updated_at,
        );
        await txn.put(`call:${callId}`, await this.releaseDurableQuota(txn, current, canceled));
        await txn.delete(queueKey(current));
        await txn.delete(dueKey(current));
        await txn.put(dueKey(canceled), callId);
        const active = await txn.get<string>(ACTIVE_DURABLE_CALL_KEY);
        if (active === callId) await txn.delete(ACTIVE_DURABLE_CALL_KEY);
        if (intent) {
          await txn.put(this.auditOutboxKey(intent), intent);
          await this.armAuditRetry(txn);
        }
      });
      if (canceled) {
        await this.flushAuditOutbox();
        const listener = this.ctx.getWebSockets("listener")[0];
        const attachment = listener?.deserializeAttachment() as ListenerAttachment | null;
        if (listener && attachment?.kind === "listener") await this.dispatchNext(listener, attachment);
        return Response.json(toA2ATask(canceled), { headers: A2A_HEADERS });
      }
    }
    const listener = this.ctx.getWebSockets("listener")[0];
    if (!listener) return this.taskNotCancelable();
    if (!task) return this.taskNotFound();
    const cancelDeadline = task.deadline;

    const firstRequest = !this.cancelWaiters.has(callId);
    const resultPromise = new Promise<CancelResolution>((resolve) => {
      const waiters = this.cancelWaiters.get(callId) ?? new Set();
      let waiter: (result: CancelResolution) => void;
      const timeout = setTimeout(() => {
        const current = this.cancelWaiters.get(callId);
        current?.delete(waiter);
        if (current?.size === 0) this.cancelWaiters.delete(callId);
        resolve({ kind: "not_cancelable" });
      }, Math.min(CANCEL_CONFIRM_TIMEOUT_MS, Math.max(1, cancelDeadline - Date.now())));
      waiter = (settled) => {
        clearTimeout(timeout);
        resolve(settled);
      };
      waiters.add(waiter);
      this.cancelWaiters.set(callId, waiters);
    });
    if (firstRequest) this.send(listener, {
      type: "cancel_call", call_id: callId,
      ...(task.lease ? { lease_id: task.lease.lease_id } : {}),
    });
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

  private async releaseDurableQuota(
    txn: DurableObjectTransaction, previous: PersistedTask, next: PersistedTask,
  ): Promise<PersistedTask> {
    if (!previous.delivery_state || previous.quota_released) return next;
    const outstanding = await txn.get<number>(QUOTA_OUTSTANDING_KEY) ?? 0;
    const callerKey = previous.from_agent_id ? quotaCallerKey(previous.from_agent_id) : undefined;
    const callerOutstanding = callerKey ? await txn.get<number>(callerKey) ?? 0 : 0;
    const storedBytes = await txn.get<number>(QUOTA_CIPHERTEXT_BYTES_KEY) ?? 0;
    const previousBytes = previous.ciphertext_bytes ?? 0;
    const retainedBytes = next.ciphertext_bytes ?? 0;
    await txn.put(QUOTA_OUTSTANDING_KEY, Math.max(0, outstanding - 1));
    if (callerKey) await txn.put(callerKey, Math.max(0, callerOutstanding - 1));
    await txn.put(
      QUOTA_CIPHERTEXT_BYTES_KEY,
      Math.max(0, storedBytes - previousBytes + retainedBytes),
    );
    return { ...next, quota_released: true };
  }

  private async persistTaskWithAudit(task: PersistedTask, intent?: CallAuditIntent): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<PersistedTask>(`call:${task.call_id}`);
      const persisted = previous && taskIsTerminal(task)
        ? await this.releaseDurableQuota(txn, previous, task)
        : task;
      await txn.put<PersistedTask>(`call:${task.call_id}`, persisted);
      if (previous && dueKey(previous) !== dueKey(persisted)) await txn.delete(dueKey(previous));
      await txn.put(dueKey(persisted), persisted.call_id);
      if (intent) {
        await txn.put<CallAuditIntent>(this.auditOutboxKey(intent), intent);
        await this.armAuditRetry(txn);
      }
    });
    await this.flushAuditOutbox();
  }

  private async admitDurableTask(task: PersistedTask, intent?: CallAuditIntent): Promise<DurableAdmission> {
    const key = dedupeKey(task.from_agent_id!, task.message_id!);
    let result: DurableAdmission = { kind: "conflict" };
    await this.ctx.storage.transaction(async (txn) => {
      const dedupe = await txn.get<DedupeRecord>(key);
      if (dedupe) {
        if (dedupe.request_envelope_sha256 !== task.request_envelope_sha256) return;
        const existing = await txn.get<PersistedTask>(`call:${dedupe.call_id}`);
        if (existing) result = { kind: "existing", task: existing };
        return;
      }
      const outstanding = await txn.get<number>(QUOTA_OUTSTANDING_KEY) ?? 0;
      const callerOutstanding = await txn.get<number>(quotaCallerKey(task.from_agent_id!)) ?? 0;
      const storedBytes = await txn.get<number>(QUOTA_CIPHERTEXT_BYTES_KEY) ?? 0;
      const taskBytes = task.ciphertext_bytes ?? 0;
      if (
        outstanding >= MAILBOX_MAX_QUEUED_TASKS ||
        callerOutstanding >= MAILBOX_MAX_OUTSTANDING_PER_CALLER ||
        storedBytes + taskBytes > MAILBOX_MAX_STORED_CIPHERTEXT_BYTES
      ) {
        result = { kind: "capacity" };
        return;
      }
      await txn.put<PersistedTask>(`call:${task.call_id}`, task);
      await txn.put<DedupeRecord>(key, {
        call_id: task.call_id,
        request_envelope_sha256: task.request_envelope_sha256!,
        purge_at: task.purge_at!,
      });
      await txn.put(queueKey(task), task.call_id);
      await txn.put(dueKey(task), task.call_id);
      await txn.put(QUOTA_OUTSTANDING_KEY, outstanding + 1);
      await txn.put(quotaCallerKey(task.from_agent_id!), callerOutstanding + 1);
      await txn.put(QUOTA_CIPHERTEXT_BYTES_KEY, storedBytes + taskBytes);
      if (intent) {
        await txn.put<CallAuditIntent>(this.auditOutboxKey(intent), intent);
        await this.armAuditRetry(txn);
      }
      result = { kind: "admitted", task };
    });
    const final = result as DurableAdmission;
    if (final.kind === "admitted") await this.flushAuditOutbox();
    return final;
  }

  private async envelopeDigest(envelope: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private sendQueuedReceipt(ws: WebSocket, task: PersistedTask): void {
    this.send(ws, {
      type: "call_queued", call_id: task.call_id, message_id: task.message_id,
      correlation_id: task.correlation_id, submitted_at: task.created_at,
      expires_at: task.execute_by,
    });
    try { ws.close(1000, "queued"); } catch { /* already closed */ }
  }

  private async durableAuthorityIsCurrent(task: PersistedTask): Promise<boolean> {
    if (!task.from_agent_id || !task.target_agent_id) return false;
    const [caller, target, cardRow] = await Promise.all([
      this.db.prepare(
        "SELECT agent_id, recovery_generation FROM handles WHERE org = ? AND handle = ?",
      ).bind(task.org, task.from).first<{ agent_id: string | null; recovery_generation: number }>(),
      this.db.prepare(
        "SELECT agent_id FROM handles WHERE org = ? AND handle = ?",
      ).bind(task.org, task.to).first<{ agent_id: string | null }>(),
      this.db.prepare(
        "SELECT card_json FROM cards WHERE org = ? AND agent_id = ?",
      ).bind(task.org, task.target_agent_id).first<{ card_json: string }>(),
    ]);
    const card = cardRow ? parseStoredCard(cardRow.card_json, task.org, task.to) : null;
    return caller?.agent_id === task.from_agent_id &&
      caller.recovery_generation === task.from_credential_generation &&
      target?.agent_id === task.target_agent_id &&
      card?.offline_delivery.enabled === true && !card.blocked.includes(task.from);
  }

  private async revokeDurableTask(task: PersistedTask): Promise<void> {
    const { request_envelope: _discarded, lease: _lease, ...rest } = task;
    const revoked: PersistedTask = {
      ...rest,
      deadline: task.purge_at ?? task.deadline,
      task_state: "TASK_STATE_REJECTED",
      delivery_state: "terminal",
      terminal_reason: "revoked",
      ciphertext_bytes: 0,
      updated_at: Date.now(),
    };
    const intent = callAuditIntent("call.fail", revoked, "relay", "system", {}, revoked.updated_at);
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<PersistedTask>(`call:${task.call_id}`);
      if (!current || taskIsTerminal(current) || current.delivery_state !== "queued") return;
      await txn.put(
        `call:${task.call_id}`,
        await this.releaseDurableQuota(txn, current, revoked),
      );
      await txn.delete(queueKey(current));
      await txn.delete(dueKey(current));
      await txn.put(dueKey(revoked), revoked.call_id);
      if (intent) {
        await txn.put(this.auditOutboxKey(intent), intent);
        await this.armAuditRetry(txn);
      }
    });
    await this.flushAuditOutbox();
  }

  private async dispatchNext(listener: WebSocket, attachment: ListenerAttachment): Promise<void> {
    if (!attachment.mailboxCapable || !attachment.listenerSessionId) return;
    const activeId = await this.ctx.storage.get<string>(ACTIVE_DURABLE_CALL_KEY);
    if (activeId) {
      const active = await this.ctx.storage.get<PersistedTask>(`call:${activeId}`);
      if (
        active?.delivery_state === "started" && active.request_envelope && active.message_id &&
        active.execute_by && !taskIsTerminal(active)
      ) {
        const rebound: PersistedTask = {
          ...active,
          lease: {
            lease_id: crypto.randomUUID(),
            listener_session_id: attachment.listenerSessionId,
            expires_at: active.deadline,
            attempt: active.lease?.attempt ?? 1,
          },
          updated_at: Date.now(),
        };
        await this.ctx.storage.put(`call:${activeId}`, rebound);
        this.send(listener, {
          type: "incoming_call", call_id: rebound.call_id, from: rebound.from,
          envelope: rebound.request_envelope, message_id: rebound.message_id,
          delivery_mode: "durable", lease_id: rebound.lease!.lease_id,
          execute_by: rebound.execute_by, correlation_id: rebound.correlation_id,
          traceparent: rebound.traceparent,
        });
      }
      return;
    }
    const queuedHead = await this.ctx.storage.list<string>({ prefix: QUEUE_PREFIX, limit: 1 });
    const head = queuedHead.entries().next().value as [string, string] | undefined;
    if (head) {
      const candidate = await this.ctx.storage.get<PersistedTask>(`call:${head[1]}`);
      if (candidate?.delivery_state === "queued" && !taskIsTerminal(candidate)) {
        const now = Date.now();
        const starts = await this.ctx.storage.list<number>({ prefix: START_PREFIX });
        const liveStarts = [...starts.entries()].filter(([key]) => {
          const at = Number(key.slice(START_PREFIX.length, START_PREFIX.length + 16));
          return Number.isSafeInteger(at) && at + START_WINDOW_MS > now;
        });
        const staleStarts = [...starts.keys()].filter((key) => !liveStarts.some(([live]) => live === key));
        if (staleStarts.length > 0) await this.ctx.storage.delete(staleStarts);
        if (liveStarts.length >= MAILBOX_MAX_STARTS_PER_DAY) {
          const oldest = Math.min(...liveStarts.map(([key]) => Number(
            key.slice(START_PREFIX.length, START_PREFIX.length + 16),
          )));
          const releaseAt = oldest + START_WINDOW_MS;
          const alarm = await this.ctx.storage.getAlarm();
          if (alarm === null || alarm > releaseAt) await this.ctx.storage.setAlarm(releaseAt);
          return;
        }
        if (!await this.durableAuthorityIsCurrent(candidate)) {
          await this.revokeDurableTask(candidate);
          await this.dispatchNext(listener, attachment);
          return;
        }
        if ((candidate.execute_by ?? 0) - Date.now() < RELAY_CALL_TIMEOUT_MS) return;
      }
    }
    let leased: PersistedTask | undefined;
    await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get<string>(ACTIVE_DURABLE_CALL_KEY)) return;
      const queued = await txn.list<string>({ prefix: QUEUE_PREFIX, limit: 1 });
      const first = queued.entries().next().value as [string, string] | undefined;
      if (!first) return;
      const [key, callId] = first;
      const task = await txn.get<PersistedTask>(`call:${callId}`);
      if (!task || taskIsTerminal(task) || task.delivery_state !== "queued") {
        await txn.delete(key);
        return;
      }
      const now = Date.now();
      const lease = {
        lease_id: crypto.randomUUID(),
        listener_session_id: attachment.listenerSessionId!,
        expires_at: now + (attachment.leaseMs ?? DELIVERY_LEASE_MS),
        attempt: (task.lease?.attempt ?? 0) + 1,
      };
      leased = { ...task, delivery_state: "leased", lease, updated_at: now };
      await txn.put(`call:${callId}`, leased);
      await txn.put(ACTIVE_DURABLE_CALL_KEY, callId);
      const alarm = await txn.getAlarm();
      if (alarm === null || alarm > lease.expires_at) await txn.setAlarm(lease.expires_at);
    });
    if (!leased?.request_envelope || !leased.message_id || !leased.lease || !leased.execute_by) return;
    this.send(listener, {
      type: "incoming_call", call_id: leased.call_id, from: leased.from,
      envelope: leased.request_envelope, message_id: leased.message_id,
      delivery_mode: "durable", lease_id: leased.lease.lease_id,
      execute_by: leased.execute_by, correlation_id: leased.correlation_id,
      traceparent: leased.traceparent,
    });
  }

  private validDurableLease(
    task: PersistedTask,
    frame: { lease_id?: string },
    listener: ListenerAttachment,
  ): boolean {
    if (!task.delivery_state) return true;
    return !!task.lease && frame.lease_id === task.lease.lease_id &&
      listener.listenerSessionId === task.lease.listener_session_id;
  }

  private async finishDurableTask(task: PersistedTask, listener: WebSocket, attachment: ListenerAttachment): Promise<void> {
    if (!task.delivery_state) return;
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(queueKey(task));
      const active = await txn.get<string>(ACTIVE_DURABLE_CALL_KEY);
      if (active === task.call_id) await txn.delete(ACTIVE_DURABLE_CALL_KEY);
    });
    await this.dispatchNext(listener, attachment);
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
      if (!current) return;
      if (current.delivery_state) {
        if (current.deadline > now) return;
        if (taskIsTerminal(current)) {
          if (current.purge_at && current.purge_at > now) {
            const retained = { ...current, deadline: current.purge_at };
            if (retained.outcome_envelope) {
              delete retained.outcome_envelope;
              const storedBytes = await txn.get<number>(QUOTA_CIPHERTEXT_BYTES_KEY) ?? 0;
              await txn.put(
                QUOTA_CIPHERTEXT_BYTES_KEY,
                Math.max(0, storedBytes - (retained.ciphertext_bytes ?? 0)),
              );
              retained.ciphertext_bytes = 0;
            }
            await txn.put(`call:${callId}`, retained);
            await txn.delete(dueKey(current));
            await txn.put(dueKey(retained), callId);
            return { task: current, timedOut: false };
          }
          await txn.delete(`call:${callId}`);
          await txn.delete(queueKey(current));
          await txn.delete(dueKey(current));
          if (current.from_agent_id && current.message_id) {
            await txn.delete(dedupeKey(current.from_agent_id, current.message_id));
          }
          if (current.quota_released && (current.ciphertext_bytes ?? 0) > 0) {
            const storedBytes = await txn.get<number>(QUOTA_CIPHERTEXT_BYTES_KEY) ?? 0;
            await txn.put(
              QUOTA_CIPHERTEXT_BYTES_KEY,
              Math.max(0, storedBytes - (current.ciphertext_bytes ?? 0)),
            );
          }
          const active = await txn.get<string>(ACTIVE_DURABLE_CALL_KEY);
          if (active === callId) await txn.delete(ACTIVE_DURABLE_CALL_KEY);
          return { task: current, timedOut: false };
        }
        const { request_envelope: _discarded, lease: _lease, ...rest } = current;
        const expired: PersistedTask = {
          ...rest,
          deadline: current.purge_at ?? now + MAILBOX_TOMBSTONE_TTL_MS,
          task_state: "TASK_STATE_FAILED",
          delivery_state: "terminal",
          terminal_reason: current.delivery_state === "started" ? "failed" : "expired",
          ciphertext_bytes: 0,
          updated_at: now,
        };
        await txn.put(`call:${callId}`, await this.releaseDurableQuota(txn, current, expired));
        await txn.delete(queueKey(current));
        await txn.delete(dueKey(current));
        await txn.put(dueKey(expired), callId);
        const active = await txn.get<string>(ACTIVE_DURABLE_CALL_KEY);
        if (active === callId) await txn.delete(ACTIVE_DURABLE_CALL_KEY);
        const intent = callAuditIntent("call.timeout", expired, "relay", "system", {}, now);
        if (intent) {
          await txn.put<CallAuditIntent>(this.auditOutboxKey(intent), intent);
          await this.armAuditRetry(txn);
        }
        return { task: expired, timedOut: true };
      }
      if (!expireAuthorizedCall(teamCallLifecycle(current), now)) return;
      await txn.delete(`call:${callId}`);
      await txn.delete(dueKey(current));
      if (taskIsTerminal(current)) return { task: current, timedOut: false };
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
      delivery_state: state === "working" && record.delivery_state ? "started" : record.delivery_state,
      updated_at: Date.now(),
    } satisfies PersistedTask;
    if (next.delivery_state === "started" && state === "working") {
      next.execution_deadline = Math.min(
        record.execute_by ?? record.deadline,
        next.updated_at + (listener.executionTimeoutMs ?? RELAY_CALL_TIMEOUT_MS),
      );
      next.deadline = next.execution_deadline;
    }
    // Starting work from ringing is an implicit acceptance, so it must not
    // leave a lifecycle gap. A later
    // explicit acceptance is rank-rejected and cannot duplicate the event.
    const accepted = state === "answered" || (state === "working" && current === "ringing")
      ? callAuditIntent("call.accept", next, record.to, "handle", listener, next.updated_at)
      : undefined;
    if (next.delivery_state === "started" && state === "working") {
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put<PersistedTask>(`call:${record.call_id}`, next);
        if (dueKey(record) !== dueKey(next)) {
          await txn.delete(dueKey(record));
          await txn.put(dueKey(next), next.call_id);
        }
        await txn.put(startKey(next.updated_at, next.call_id), next.updated_at);
        const alarm = await txn.getAlarm();
        if (alarm === null || alarm > next.deadline) await txn.setAlarm(next.deadline);
        if (accepted) {
          await txn.put(this.auditOutboxKey(accepted), accepted);
          await this.armAuditRetry(txn);
        }
      });
      if (accepted) await this.flushAuditOutbox();
    } else if (accepted) await this.persistTaskWithAudit(next, accepted);
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
      if (oversized) {
        if (stamps.length >= RATE_LIMIT_PER_HOUR) return this.fail(ws, "rate_limited", true);
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
      let durableEnvelopeDigest: string | undefined;
      if (frame.delivery_mode === "durable") {
        durableEnvelopeDigest = await this.envelopeDigest(frame.envelope);
        const dedupe = await this.ctx.storage.get<DedupeRecord>(dedupeKey(att.fromAgentId, frame.message_id!));
        if (dedupe) {
          if (dedupe.request_envelope_sha256 !== durableEnvelopeDigest) {
            return this.fail(ws, "protocol_error", true, { correlation_id });
          }
          const existing = await this.ctx.storage.get<PersistedTask>(`call:${dedupe.call_id}`);
          if (!existing) return this.fail(ws, "protocol_error", true, { correlation_id });
          this.sendQueuedReceipt(ws, existing);
          return;
        }
      }
      if (stamps.length >= RATE_LIMIT_PER_HOUR) return this.fail(ws, "rate_limited", true);

      const listener = this.ctx.getWebSockets("listener")[0];
      const backlog = frame.delivery_mode === "durable" && (
        await this.ctx.storage.list({ prefix: QUEUE_PREFIX, limit: 1 })
      ).size > 0;
      if (!listener || backlog) {
        if (frame.delivery_mode === "durable" && att.mailboxEnabled && !att.callerBlocked) {
          const call_id = crypto.randomUUID();
          const executeBy = now + Math.min(MAILBOX_TTL_MS, att.timeoutMs ?? MAILBOX_TTL_MS);
          ws.serializeAttachment({ ...att, call_id, correlation_id });
          const task = {
            call_id, correlation_id, from: att.from, org: att.org, to: att.to,
            deadline: executeBy, state: "ringing" as const,
            task_state: "TASK_STATE_SUBMITTED" as const, created_at: now, updated_at: now,
            principal: beginAuthorizedCall(att.principal, executeBy).principal,
            message_id: frame.message_id,
            from_agent_id: att.fromAgentId,
            from_credential_generation: att.credentialGeneration ?? 0,
            target_agent_id: att.targetAgentId,
            request_envelope: frame.envelope,
            request_envelope_sha256: durableEnvelopeDigest!,
            ciphertext_bytes: new TextEncoder().encode(JSON.stringify(frame.envelope)).byteLength,
            traceparent: frame.traceparent,
            delivery_state: "queued" as const,
            execute_by: executeBy,
            purge_at: executeBy + MAILBOX_TOMBSTONE_TTL_MS,
          } satisfies PersistedTask;
          const admission = await this.admitDurableTask(
            task,
            callAuditIntent("call.submit", task, att.from, "handle", att, now),
          );
          if (admission.kind === "conflict") {
            return this.fail(ws, "protocol_error", true, { correlation_id });
          }
          if (admission.kind === "existing") {
            this.sendQueuedReceipt(ws, admission.task);
            return;
          }
          if (admission.kind === "capacity") {
            await recordRateLimitHit(this.ctx.storage, att.from, stamps, now);
            return this.fail(ws, "busy", true, { correlation_id });
          }
          await recordRateLimitHit(this.ctx.storage, att.from, stamps, now);
          await this.scheduleNextAlarm();
          this.sendQueuedReceipt(ws, task);
          return;
        }
        if (!listener) {
          try { recordCallPresenceRead(this.statusReads); } catch { /* telemetry cannot block calls */ }
          return this.fail(ws, "offline", true, { correlation_id });
        }
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
    if (!this.validDurableLease(record, frame, att)) return;

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
      if (canceled.delivery_state) {
        delete canceled.request_envelope;
        delete canceled.lease;
        canceled.deadline = canceled.purge_at ?? canceled.deadline;
        canceled.delivery_state = "terminal";
        canceled.terminal_reason = "canceled";
        canceled.ciphertext_bytes = 0;
      }
      // Persist terminal truth before fan-out. Once a caller observes a
      // terminal response, a concurrent GetTask must never move backward.
      await this.persistTaskWithAudit(
        canceled,
        callAuditIntent("call.cancel", canceled, record.to, "handle", att, canceled.updated_at),
      );
      await this.finishDurableTask(canceled, ws, att);
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
      if (failed.delivery_state) {
        delete failed.request_envelope;
        delete failed.lease;
        failed.deadline = failed.purge_at ?? failed.deadline;
        failed.delivery_state = "terminal";
        failed.terminal_reason = "delivery_failed";
        failed.ciphertext_bytes = 0;
      }
      await this.persistTaskWithAudit(
        failed,
        callAuditIntent("call.fail", failed, record.to, "handle", att, failed.updated_at),
      );
      if (caller) this.fail(caller, "protocol_error", true, {
        call_id: frame.call_id, correlation_id: record.correlation_id,
      });
      this.settleCancellation(frame.call_id, { kind: "not_cancelable" });
      await this.finishDurableTask(failed, ws, att);
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
      if (finished.delivery_state) {
        delete finished.request_envelope;
        delete finished.lease;
        finished.deadline = finished.execute_by ?? finished.deadline;
        finished.delivery_state = "terminal";
        finished.terminal_reason = frame.terminal_reason ?? frame.terminal;
        finished.ciphertext_bytes = new TextEncoder().encode(JSON.stringify(frame.envelope)).byteLength;
      }
      const intent = frame.terminal === "completed"
        ? callAuditIntent("call.complete", finished, record.to, "handle", att, finished.updated_at)
        : callAuditIntent("call.fail", finished, record.to, "handle", att, finished.updated_at);
      await this.persistTaskWithAudit(
        finished,
        intent,
      );
      await this.finishDurableTask(finished, ws, att);
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

  private async recoverExpiredLease(callId: string, now: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<PersistedTask>(`call:${callId}`);
      if (
        !current || current.delivery_state !== "leased" || !current.lease ||
        current.lease.expires_at > now || taskIsTerminal(current)
      ) return;
      const active = await txn.get<string>(ACTIVE_DURABLE_CALL_KEY);
      if (active === callId) await txn.delete(ACTIVE_DURABLE_CALL_KEY);
      if (current.lease.attempt < 3) {
        await txn.put<PersistedTask>(`call:${callId}`, {
          ...current, delivery_state: "queued", updated_at: now,
        });
        return;
      }
      const { request_envelope: _discarded, lease: _expiredLease, ...rest } = current;
      const failed: PersistedTask = {
        ...rest,
        deadline: current.purge_at ?? current.deadline,
        task_state: "TASK_STATE_FAILED",
        delivery_state: "terminal",
        terminal_reason: "delivery_failed",
        ciphertext_bytes: 0,
        updated_at: now,
      };
      await txn.put(`call:${callId}`, await this.releaseDurableQuota(txn, current, failed));
      await txn.delete(queueKey(current));
      await txn.delete(dueKey(current));
      await txn.put(dueKey(failed), callId);
      const intent = callAuditIntent("call.fail", failed, "relay", "system", {}, now);
      if (intent) {
        await txn.put<CallAuditIntent>(this.auditOutboxKey(intent), intent);
        await this.armAuditRetry(txn);
      }
    });
  }

  private async scheduleNextAlarm(): Promise<void> {
    let min = Infinity;
    const due = await this.ctx.storage.list<string>({ prefix: DUE_PREFIX, limit: 1 });
    const firstDue = due.keys().next().value as string | undefined;
    if (firstDue) min = Math.min(min, Number(firstDue.slice(DUE_PREFIX.length, DUE_PREFIX.length + 16)));
    const activeId = await this.ctx.storage.get<string>(ACTIVE_DURABLE_CALL_KEY);
    if (activeId) {
      const active = await this.ctx.storage.get<PersistedTask>(`call:${activeId}`);
      if (active?.lease) min = Math.min(min, active.lease.expires_at);
    }
    const pendingAudit = await this.ctx.storage.list<CallAuditIntent>({ prefix: CALL_AUDIT_PREFIX, limit: 1 });
    if (pendingAudit.size > 0) min = Math.min(min, Date.now() + CALL_AUDIT_RETRY_MS);
    const maintenance = await readRateLimitMaintenance(this.ctx.storage);
    if (maintenance) min = Math.min(min, maintenance.due);
    if (min !== Infinity) await this.ctx.storage.setAlarm(min);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const timedOut: PersistedTask[] = [];
    const activeId = await this.ctx.storage.get<string>(ACTIVE_DURABLE_CALL_KEY);
    if (activeId) await this.recoverExpiredLease(activeId, now);
    const due = await this.ctx.storage.list<string>({ prefix: DUE_PREFIX, limit: CALL_AUDIT_DRAIN_LIMIT });
    for (const [key, callId] of due) {
      const at = Number(key.slice(DUE_PREFIX.length, DUE_PREFIX.length + 16));
      if (!Number.isSafeInteger(at) || at > now) break;
      const expired = await this.expireTask(callId, now);
      if (!expired) await this.ctx.storage.delete(key);
      else if (expired.timedOut) timedOut.push(expired.task);
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
    const listener = this.ctx.getWebSockets("listener")[0];
    if (listener) {
      const attachment = listener.deserializeAttachment() as ListenerAttachment | null;
      if (attachment?.kind === "listener") await this.dispatchNext(listener, attachment);
    }
    await this.scheduleNextAlarm();
  }
}
