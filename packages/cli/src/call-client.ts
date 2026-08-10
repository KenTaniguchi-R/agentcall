import WebSocket, { type RawData } from "ws";
import { randomBytes } from "node:crypto";
import { formatAddress,
  CORRELATION_ID_RE, E2EECallerFrame, E2EERelayToCallerFrame, MAILBOX_TTL_MS, MAX_E2EE_WIRE_BYTES,
  RELAY_CALL_TIMEOUT_MS, keyIdFor,
  normalizeTraceparent, requestTranscript, safeParseFrame, sanitizeDetail, transcriptHash,
  type CallStatusType, type E2EERequestPayloadType, type ErrorCodeType,
} from "@benree/agentcall-shared";
import { ApiError, assertValidHandle, fetchCard, fetchKeys } from "./api.js";
import { openE2EEResponse, sealE2EERequest } from "./e2ee.js";
import { loadKeys } from "./keys.js";
import { verifyAndPinPeer } from "./known-peers.js";
import type { Paths } from "./paths.js";
import { relayHostOf } from "./config.js";
import { acknowledgeOutboundJob, rememberOutboundJob } from "./outbound-jobs.js";

export class CallError extends Error {
  constructor(
    message: string,
    public code: ErrorCodeType | "connection_failed",
    public offered?: string[],
    public callId?: string,
    public correlationId?: string,
    public origin: "peer" | "relay" | "transport" = "transport",
  ) {
    super(message);
  }
}

const HUMAN: Record<string, string> = {
  offline: "That agent is offline right now.",
  unknown_handle: "No agent is registered at that address.",
  busy: "That agent is busy (queue full). Try again in a few minutes.",
  timeout: "The call timed out.",
  canceled: "The call was canceled.",
  rate_limited: "You are calling this agent too often. Try later.",
  unauthorized: "Your credentials were rejected. Re-run `agentcall setup`.",
  agent_error: "The remote agent hit an error while answering.",
  message_too_large: "Your message is too large (64KB max).",
  protocol_error: "Protocol error.",
  blocked: "This agent's owner has blocked calls from your handle.",
  task_unknown: "That task doesn't exist on this agent.",
  context_unknown: "That conversation is no longer available. Start a new call.",
};

export interface CallOpts {
  relay: string; org: string; from: string; token: string; to: string; message: string;
  paths: Paths;
  contextId?: string;
  onStatus?: (state: CallStatusType["state"], frame: CallStatusType) => void;
  timeoutMs?: number;
  /** Internal telemetry seam; ordinary callers leave both fields unset. */
  correlationId?: string;
  traceparent?: string;
  // Interval for the caller-side keepalive ping below; overridable for tests.
  pingIntervalMs?: number;
  // Task id from the callee's card to perform; omitted lands on the callee's
  // built-in "ask" task.
  task?: string;
  /** Internal test seams; production always uses the real trust/key stores. */
  keyDeps?: {
    fetchKeys?: typeof fetchKeys;
    fetchCard?: typeof fetchCard;
    verifyAndPinPeer?: typeof verifyAndPinPeer;
    loadKeys?: typeof loadKeys;
    now?: () => number;
  };
}

export interface CallReply {
  type: "call_reply";
  call_id: string;
  correlation_id?: string;
  text: string;
  context_id?: string;
  task?: string;
}

export interface CallQueuedReply {
  type: "call_queued";
  call_id: string;
  message_id: string;
  correlation_id: string;
  address: string;
  submitted_at: number;
  expires_at: number;
}

export type CallResult = CallReply | CallQueuedReply;

export function callStatusMessage(state: CallStatusType["state"]): string {
  if (state === "ringing") return "ringing...";
  if (state === "answered") return "answered...";
  return "agent working...";
}

function createCorrelationId(): string {
  return randomBytes(16).toString("hex");
}

function rawWireBytes(raw: RawData): number {
  return Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
}

export async function callAgent(opts: CallOpts): Promise<CallResult> {
  const correlationId = opts.correlationId && CORRELATION_ID_RE.test(opts.correlationId)
    ? opts.correlationId
    : createCorrelationId();
  const traceparent = normalizeTraceparent(correlationId, opts.traceparent);
  const relayOrigin = relayHostOf(opts.relay);
  const fromAddress = formatAddress(opts.org, opts.from);
  const toAddress = formatAddress(opts.org, opts.to);
  const auth = { org: opts.org, handle: opts.from, token: opts.token };
  try {
    assertValidHandle(opts.to);
  } catch (error) {
    const detail = sanitizeDetail(error instanceof Error ? error.message : String(error));
    throw new CallError(
      `Invalid call target: ${detail}`, "protocol_error",
      undefined, undefined, correlationId, "transport",
    );
  }
  const mailboxEnabled = await (opts.keyDeps?.fetchCard ?? fetchCard)(opts.relay, opts.to, auth)
    .then((card) => card.offline_delivery.enabled)
    .catch(() => false);
  // No socket opens until the recipient record is validated against the local
  // trust store. A missing, changed, stale, invalid, or expired key therefore
  // cannot cause even a partial plaintext-compatible call attempt.
  let recipientBundle;
  try {
    recipientBundle = await (opts.keyDeps?.fetchKeys ?? fetchKeys)(opts.relay, auth, opts.to);
  } catch (error) {
    const detail = sanitizeDetail(error instanceof Error ? error.message : String(error));
    if (!(error instanceof ApiError) || error.code === "network") {
      throw new CallError(
        `Connection failed: ${detail}`, "connection_failed",
        undefined, undefined, correlationId, "transport",
      );
    }
    const code = error.code === "unknown_handle"
      ? "unknown_handle"
      : error.code === "unauthorized"
        ? "unauthorized"
        : "protocol_error";
    throw new CallError(
      `Unauthenticated relay status: ${detail}`, code,
      undefined, undefined, correlationId, "relay",
    );
  }
  const recipientPeer = await (opts.keyDeps?.verifyAndPinPeer ?? verifyAndPinPeer)(
    opts.paths, toAddress, recipientBundle,
  );
  const senderKeys = (opts.keyDeps?.loadKeys ?? loadKeys)(opts.paths);
  const issuedAt = (opts.keyDeps?.now ?? Date.now)();
  const messageId = randomBytes(16).toString("hex");
  const request: E2EERequestPayloadType = {
    v: 1,
    direction: "request",
    relay_origin: relayOrigin,
    from: fromAddress,
    to: toAddress,
    message_id: messageId,
    ...(mailboxEnabled ? { delivery_mode: "durable" as const } : {}),
    request_id: randomBytes(16).toString("hex"),
    sender_identity_key_id: await keyIdFor(senderKeys.identity_pub),
    recipient_encryption_key_id: recipientBundle.encryption.record.key_id,
    recipient_epoch: recipientBundle.encryption.record.epoch,
    issued_at: issuedAt,
    expires_at: issuedAt + (mailboxEnabled ? MAILBOX_TTL_MS : RELAY_CALL_TIMEOUT_MS),
    message: opts.message,
    ...(opts.contextId ? { context_id: opts.contextId } : {}),
    ...(opts.task ? { task: opts.task } : {}),
  };
  const envelope = await sealE2EERequest(request, senderKeys, {
    pub: recipientBundle.encryption.record.pub,
    key_id: recipientBundle.encryption.record.key_id,
    epoch: recipientBundle.encryption.record.epoch,
  });
  const requestBinding = {
    message_id: request.message_id,
    request_id: request.request_id,
    request_transcript_hash: await transcriptHash(requestTranscript(request)),
    ...(request.delivery_mode ? { delivery_mode: request.delivery_mode } : {}),
  };
  const responseExpected = {
    relay_origin: relayOrigin,
    from: toAddress,
    to: fromAddress,
    key_id: await keyIdFor(senderKeys.encryption_pub),
    epoch: senderKeys.epoch,
  };
  const outboundFrame = E2EECallerFrame.parse({
    type: "call_request", envelope, message_id: messageId,
    ...(mailboxEnabled ? { delivery_mode: "durable" } : {}),
    correlation_id: correlationId, traceparent,
  });
  if (mailboxEnabled) {
    await rememberOutboundJob(opts.paths, {
      message_id: messageId,
      relay: opts.relay,
      address: toAddress,
      frame: outboundFrame,
      request_id: request.request_id,
      request_transcript_hash: requestBinding.request_transcript_hash,
      recipient_identity_pub: recipientPeer.identity_pub,
      sender_epoch: senderKeys.epoch,
      created_at: issuedAt,
      expires_at: request.expires_at,
    });
  }
  const wsUrl = opts.relay.replace(/^http/, "ws") + `/v1/ws?role=call&to=${encodeURIComponent(opts.to)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${opts.token}`, "X-AgentCall-Org": opts.org, "X-AgentCall-Handle": opts.from },
      perMessageDeflate: false,
      maxPayload: MAX_E2EE_WIRE_BYTES,
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
      finish(() => reject(new CallError(
        `Unauthenticated relay status: ${HUMAN[code]}`, code,
        undefined, undefined, correlationId, "relay",
      )));
    });
    ws.on("error", (e) => finish(() => reject(new CallError(`Connection failed: ${e.message}`, "connection_failed"))));
    ws.on("open", () => {
      ws.send(JSON.stringify(outboundFrame));
      // Cloudflare's idle timeout can drop a long-running call (agent answers
      // can take up to AGENT_TIMEOUT_MS) if the socket goes quiet. Ping keeps
      // it alive; unref() so this timer alone never keeps the process open.
      pingTimer = setInterval(() => { try { ws.send("ping"); } catch { /* dead */ } }, opts.pingIntervalMs ?? 30_000);
      pingTimer.unref?.();
    });
    ws.on("message", async (raw) => {
      if (rawWireBytes(raw) > MAX_E2EE_WIRE_BYTES) {
        finish(() => reject(new CallError(
          "Encrypted relay frame exceeded the wire limit.", "protocol_error",
          undefined, undefined, correlationId, "transport",
        )));
        return;
      }
      const frame = safeParseFrame(E2EERelayToCallerFrame, String(raw));
      if (!frame) return;
      if (frame.type === "call_status") opts.onStatus?.(frame.state, frame);
      else if (frame.type === "call_queued") {
        if (frame.message_id !== messageId || frame.correlation_id !== correlationId) {
          finish(() => reject(new CallError(
            "Durable receipt does not match the submitted request.", "protocol_error",
            undefined, frame.call_id, correlationId, "transport",
          )));
          return;
        }
        try {
          await acknowledgeOutboundJob(opts.paths, messageId, {
            task_id: frame.call_id,
            submitted_at: frame.submitted_at,
            expires_at: frame.expires_at,
          });
        } catch (error) {
          finish(() => reject(new CallError(
            `Could not persist durable receipt: ${error instanceof Error ? error.message : String(error)}`,
            "protocol_error", undefined, frame.call_id, correlationId, "transport",
          )));
          return;
        }
        finish(() => resolve({
          ...frame, address: toAddress,
        }));
      }
      else if (frame.type === "call_outcome") {
        try {
          const response = await openE2EEResponse(
            frame.envelope, senderKeys.encryption_pkcs8, recipientPeer.identity_pub,
            responseExpected, requestBinding,
          );
          const outcome = response.outcome;
          const authenticatedTerminal = outcome.kind === "reply" ? "completed" : "failed";
          if (frame.terminal !== authenticatedTerminal) {
            throw new Error("Encrypted peer outcome does not match its relay-visible terminal state.");
          }
          if (outcome.kind === "reply") {
            finish(() => resolve({
              type: "call_reply", call_id: frame.call_id, correlation_id: correlationId,
              text: outcome.text,
              ...(outcome.context_id ? { context_id: outcome.context_id } : {}),
              ...(outcome.task ? { task: outcome.task } : {}),
            }));
          } else {
            const detail = outcome.detail === undefined
              ? undefined
              : sanitizeDetail(outcome.detail);
            const base = detail ?? HUMAN[outcome.code] ?? outcome.code;
            const msg = outcome.offered?.length
              ? `Authenticated peer response: ${base} Tasks offered to you: ${outcome.offered.join(", ")}`
              : `Authenticated peer response: ${base}`;
            finish(() => reject(new CallError(
              msg, outcome.code, outcome.offered,
              frame.call_id, correlationId, "peer",
            )));
          }
        } catch (error) {
          finish(() => reject(new CallError(
            `Encrypted peer outcome failed authentication: ${error instanceof Error ? error.message : String(error)}`,
            "protocol_error", undefined, frame.call_id, correlationId, "transport",
          )));
        }
      }
      else if (frame.type === "call_error") {
        const msg = `Unauthenticated relay status: ${HUMAN[frame.code] ?? frame.code}`;
        finish(() => reject(new CallError(
          msg, frame.code, undefined, frame.call_id, frame.correlation_id, "relay",
        )));
      }
    });
    ws.on("close", () => finish(() => reject(new CallError("Connection closed before a reply arrived.", "connection_failed"))));
  });
}
