import WebSocket from "ws";
import { RelayToCallerFrame, safeParseFrame, type CallReplyType, type ErrorCodeType } from "@benree/agentcall-shared";

export class CallError extends Error {
  constructor(message: string, public code: ErrorCodeType | "connection_failed", public offered?: string[]) {
    super(message);
  }
}

const HUMAN: Record<string, string> = {
  offline: "That agent is offline right now.",
  unknown_handle: "No agent is registered at that address.",
  busy: "That agent is busy (queue full). Try again in a few minutes.",
  timeout: "The call timed out.",
  rate_limited: "You are calling this agent too often. Try later.",
  unauthorized: "Your credentials were rejected. Re-run `agentcall setup`.",
  agent_error: "The remote agent hit an error while answering.",
  message_too_large: "Your message is too large (64KB max).",
  protocol_error: "Protocol error.",
  blocked: "This agent's owner has blocked calls from your handle.",
  task_not_offered: "That task isn't offered to you.",
  task_unknown: "That task doesn't exist on this agent.",
};

export interface CallOpts {
  relay: string; from: string; token: string; to: string; message: string;
  sessionId?: string; onStatus?: (state: string) => void; timeoutMs?: number;
  // Interval for the caller-side keepalive ping below; overridable for tests.
  pingIntervalMs?: number;
  // Task id from the callee's card to perform; omitted lets the callee's
  // policy pick a default (single offered task, or "ask").
  task?: string;
}

export function callAgent(opts: CallOpts): Promise<CallReplyType> {
  const wsUrl = opts.relay.replace(/^http/, "ws") + `/v1/ws?role=call&to=${encodeURIComponent(opts.to)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${opts.token}`, "X-AgentCall-Handle": opts.from },
    });
    let settled = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (pingTimer) clearInterval(pingTimer);
        fn();
        try { ws.close(); } catch {}
      }
    };
    const timer = setTimeout(
      () => finish(() => reject(new CallError(HUMAN.timeout, "timeout"))),
      opts.timeoutMs ?? 420_000,
    );

    ws.on("unexpected-response", (_req, res) => {
      const code: ErrorCodeType = res.statusCode === 404 ? "unknown_handle" : "unauthorized";
      finish(() => reject(new CallError(HUMAN[code], code)));
    });
    ws.on("error", (e) => finish(() => reject(new CallError(`Connection failed: ${e.message}`, "connection_failed"))));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "call_request", to: opts.to, message: opts.message, session_id: opts.sessionId, task: opts.task }));
      // Cloudflare's idle timeout can drop a long-running call (agent answers
      // can take up to AGENT_TIMEOUT_MS) if the socket goes quiet. Ping keeps
      // it alive; unref() so this timer alone never keeps the process open.
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch { /* dead */ } }, opts.pingIntervalMs ?? 30_000);
      pingTimer.unref?.();
    });
    ws.on("message", (raw) => {
      const frame = safeParseFrame(RelayToCallerFrame, String(raw));
      if (!frame) return;
      if (frame.type === "call_status") opts.onStatus?.(frame.state);
      else if (frame.type === "call_reply") finish(() => resolve(frame));
      else if (frame.type === "call_error") {
        const base = frame.detail ?? HUMAN[frame.code] ?? frame.code;
        const msg = frame.offered?.length ? `${base} Tasks offered to you: ${frame.offered.join(", ")}` : base;
        finish(() => reject(new CallError(msg, frame.code, frame.offered)));
      }
    });
    ws.on("close", () => finish(() => reject(new CallError("Connection closed before a reply arrived.", "connection_failed"))));
  });
}
