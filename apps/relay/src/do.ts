import { DurableObject } from "cloudflare:workers";
import {
  CallerFrame, ListenerToRelayFrame, MAX_MESSAGE_BYTES, MAX_REPLY_BYTES,
  RATE_LIMIT_PER_HOUR, RELAY_CALL_TIMEOUT_MS, safeParseFrame,
  type ErrorCodeType,
} from "@benree/agentcall-shared";

type CallerAttachment = { kind: "caller"; from: string; call_id?: string; timeoutMs?: number };
type ListenerAttachment = { kind: "listener" };
type CallRecord = { call_id: string; from: string; deadline: number };

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
        server.serializeAttachment({ kind: "caller", from, timeoutMs: testTimeout } satisfies CallerAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  private send(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* socket gone */ }
  }

  private fail(ws: WebSocket, code: ErrorCodeType, detail?: string, offered?: string[], close = true): void {
    this.send(ws, { type: "call_error", code, detail, offered });
    if (close) { try { ws.close(1000, code); } catch { /* already closed */ } }
  }

  private callerFor(callId: string): WebSocket | undefined {
    return this.ctx.getWebSockets("caller").find(
      (w) => (w.deserializeAttachment() as CallerAttachment | null)?.call_id === callId,
    );
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as CallerAttachment | ListenerAttachment | null;
    if (!att) return;

    if (att.kind === "caller") {
      const frame = safeParseFrame(CallerFrame, raw);
      if (!frame || att.call_id) return this.fail(ws, "protocol_error");

      // Rate limit is checked before the size check so an over-budget caller
      // is turned away before an oversized-message parse/response cycle, but
      // an oversized frame still charges one unit of the hourly budget
      // below — otherwise unlimited oversized frames could be sent for free
      // without ever tripping the limit.
      const now = Date.now();
      const rlKey = `rl:${att.from}`;
      const stamps = ((await this.ctx.storage.get<number[]>(rlKey)) ?? []).filter((t) => now - t < 3_600_000);
      if (stamps.length >= RATE_LIMIT_PER_HOUR) return this.fail(ws, "rate_limited");

      if (new TextEncoder().encode(frame.message).byteLength > MAX_MESSAGE_BYTES) {
        stamps.push(now);
        await this.ctx.storage.put(rlKey, stamps);
        return this.fail(ws, "message_too_large");
      }
      const listener = this.ctx.getWebSockets("listener")[0];
      if (!listener) return this.fail(ws, "offline");

      stamps.push(now);
      await this.ctx.storage.put(rlKey, stamps);
      const call_id = crypto.randomUUID();
      const deadline = now + clampTimeoutMs(att.timeoutMs);
      ws.serializeAttachment({ ...att, call_id });
      await this.ctx.storage.put<CallRecord>(`call:${call_id}`, { call_id, from: att.from, deadline });
      await this.scheduleNextAlarm();
      this.send(ws, { type: "call_status", state: "ringing" });
      this.send(listener, {
        type: "incoming_call", call_id, from: att.from,
        message: frame.message, session_id: frame.session_id, task: frame.task,
      });
      return;
    }

    // listener frames
    const frame = safeParseFrame(ListenerToRelayFrame, raw);
    if (!frame) return;
    const record = await this.ctx.storage.get<CallRecord>(`call:${frame.call_id}`);
    if (!record) return; // stale/unknown call
    const caller = this.callerFor(frame.call_id);

    if (frame.type === "call_answer") {
      if (caller) this.send(caller, { type: "call_status", state: "answered" });
      return;
    }
    if (frame.type === "call_result") {
      const text = truncateUtf8Bytes(frame.text, MAX_REPLY_BYTES);
      if (caller) {
        this.send(caller, { type: "call_reply", call_id: frame.call_id, text, session_id: frame.session_id, task: frame.task });
        try { caller.close(1000, "done"); } catch { /* closed */ }
      }
      await this.ctx.storage.delete(`call:${frame.call_id}`);
      return;
    }
    if (frame.type === "call_failed") {
      if (caller) this.fail(caller, frame.code, frame.detail, frame.offered);
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
    if (min !== Infinity) await this.ctx.storage.setAlarm(min);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const calls = await this.ctx.storage.list<CallRecord>({ prefix: "call:" });
    for (const rec of calls.values()) {
      if (rec.deadline <= now) {
        const caller = this.callerFor(rec.call_id);
        if (caller) this.fail(caller, "timeout");
        await this.ctx.storage.delete(`call:${rec.call_id}`);
      }
    }
    await this.scheduleNextAlarm();
  }
}
