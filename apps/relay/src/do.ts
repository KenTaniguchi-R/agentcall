import { DurableObject } from "cloudflare:workers";
import {
  CallerFrame, ListenerToRelayFrame, MAX_MESSAGE_BYTES, MAX_REPLY_BYTES,
  RATE_LIMIT_PER_HOUR, RELAY_CALL_TIMEOUT_MS, safeParseFrame, sanitizeDetail,
  type CallStatusType, type ErrorCodeType,
} from "@benree/agentcall-shared";

type CallerAttachment = {
  kind: "caller";
  from: string;
  groups: string[];
  call_id?: string;
  correlation_id?: string;
  timeoutMs?: number;
};
type ListenerAttachment = { kind: "listener" };
type CallRecord = {
  call_id: string;
  // Optional for in-flight records written by a pre-correlation deployment.
  correlation_id?: string;
  from: string;
  deadline: number;
  // Optional only for in-flight records written by a pre-#89 deployment.
  state?: CallStatusType["state"];
};

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

export class HandleDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
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
        server.serializeAttachment({ kind: "listener" } satisfies ListenerAttachment);
      } else {
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({ kind: "caller", from, groups, timeoutMs: testTimeout } satisfies CallerAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
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

  private async advanceCall(
    record: CallRecord,
    state: CallStatusType["state"],
    caller: WebSocket | undefined,
  ): Promise<void> {
    const current = record.state ?? "ringing";
    if (STATUS_RANK[state] <= STATUS_RANK[current]) return;
    // Persist before fan-out so a DO restart or duplicate/out-of-order frame
    // cannot move the caller backward after it has observed a later state.
    await this.ctx.storage.put<CallRecord>(`call:${record.call_id}`, { ...record, state });
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
      await this.ctx.storage.put<CallRecord>(`call:${call_id}`, {
        call_id, correlation_id, from: att.from, deadline, state: "ringing",
      });
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
    const record = await this.ctx.storage.get<CallRecord>(`call:${frame.call_id}`);
    if (!record) return; // stale/unknown call
    const caller = this.callerFor(frame.call_id);

    if (frame.type === "call_accepted") {
      await this.advanceCall(record, "answered", caller);
      return;
    }
    if (frame.type === "call_answer" || frame.type === "call_started") {
      // Legacy call_answer was emitted only once the job started, so preserve
      // that truth when old listeners overlap a new relay deployment.
      await this.advanceCall(record, "working", caller);
      return;
    }
    if (frame.type === "call_cancelled") {
      // Confirmation means a pending job was removed or the running process
      // was observed exited. Only now is it honest to publish a terminal
      // cancellation and release the call record.
      if (caller) {
        this.fail(caller, "canceled", undefined, undefined, true, {
          call_id: frame.call_id, correlation_id: record.correlation_id,
        });
      }
      await this.ctx.storage.delete(`call:${frame.call_id}`);
      return;
    }
    if (frame.type === "call_not_cancelled") {
      // Cancellation is two-phase. A refusal is not terminal: completion may
      // still win and must be allowed to deliver its result. The producer of
      // cancel_call arrives with the durable A2A task store in #9; handling the
      // acknowledgement here keeps the listener/relay link complete first.
      return;
    }
    if (frame.type === "call_result") {
      const text = truncateUtf8Bytes(frame.text, MAX_REPLY_BYTES);
      if (caller) {
        this.send(caller, {
          type: "call_reply", call_id: frame.call_id, correlation_id: record.correlation_id,
          text, context_id: frame.context_id, task: frame.task,
        });
        try { caller.close(1000, "done"); } catch { /* closed */ }
      }
      await this.ctx.storage.delete(`call:${frame.call_id}`);
      return;
    }
    if (frame.type === "call_failed") {
      // The listener is an untrusted peer here — same posture as call_result's
      // text above. sanitizeDetail bounds the string and strips the control
      // characters that would otherwise reach the caller's terminal verbatim.
      const detail = frame.detail === undefined ? undefined : sanitizeDetail(frame.detail);
      if (caller) {
        this.fail(caller, frame.code, detail, frame.offered, true, {
          call_id: frame.call_id, correlation_id: record.correlation_id,
        });
      }
      await this.ctx.storage.delete(`call:${frame.call_id}`);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as CallerAttachment | ListenerAttachment | null;
    if (att?.kind === "caller" && att.call_id) {
      await this.ctx.storage.delete(`call:${att.call_id}`);
    }
    // listener close: keep in-flight calls; a reconnected listener may still deliver results.
  }

  private async scheduleNextAlarm(): Promise<void> {
    const calls = await this.ctx.storage.list<CallRecord>({ prefix: "call:" });
    let min = Infinity;
    for (const rec of calls.values()) min = Math.min(min, rec.deadline);
    const maintenance = await readRateLimitMaintenance(this.ctx.storage);
    if (maintenance) min = Math.min(min, maintenance.due);
    if (min !== Infinity) await this.ctx.storage.setAlarm(min);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const calls = await this.ctx.storage.list<CallRecord>({ prefix: "call:" });
    for (const rec of calls.values()) {
      if (rec.deadline <= now) {
        const caller = this.callerFor(rec.call_id);
        if (caller) {
          this.fail(caller, "timeout", undefined, undefined, true, {
            call_id: rec.call_id, correlation_id: rec.correlation_id,
          });
        }
        await this.ctx.storage.delete(`call:${rec.call_id}`);
      }
    }
    await continueRateLimitMaintenance(this.ctx.storage, now);
    await this.scheduleNextAlarm();
  }
}
