import { z } from "zod";

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const ORG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Bounds derived from TASK_ID_RE: 1 (mandatory first char) + 63 (0-63 range) = 64.
// Must stay consistent with TASK_ID_RE; drift is caught by test/protocol.test.ts.
export const MAX_TASK_ID_LENGTH = 64;
// Bounds the authenticated peer failure's `offered` list: without a cap, a
// hostile peer could hand back thousands of entries; without TASK_ID_RE, an
// entry could carry terminal controls into caller output.
export const MAX_OFFERED_TASKS = 50;
export const MAX_MESSAGE_BYTES = 64_000;
export const MAX_REPLY_BYTES = 256_000;
// `detail` and reply `text` are peer-controlled free-form strings the CLI can
// put in front of a caller. Reply text is byte-bounded above; this separate,
// tighter detail cap also bounds relay bandwidth. Both display paths must
// neutralize terminal controls at the caller even if the relay already did so.
export const MAX_DETAIL_LENGTH = 500;
// The context id is minted by the callee (packages/cli/src/contexts.ts), never
// by a caller, so its exact shape is known: "ctx_" + 22 base64url characters =
// 128 bits of randomness. This replaces a 256-byte length cap that existed only
// because the field was forwarded and dropped without ever being consumed. Now
// that it selects a resumable agent session, a malformed value is rejected at
// the schema boundary — before it reaches any store lookup.
export const CONTEXT_ID_RE = /^ctx_[A-Za-z0-9_-]{22}$/;
export const CORRELATION_ID_RE = /^(?!0{32}$)[0-9a-f]{32}$/;
const TRACEPARENT_V00_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

export function normalizeTraceparent(correlationId: string | undefined, value: unknown): string | undefined {
  if (correlationId === undefined || typeof value !== "string") return undefined;
  const match = TRACEPARENT_V00_RE.exec(value);
  if (!match || match[1] !== correlationId || /^0{16}$/.test(match[2]!)) return undefined;
  return value;
}

export function normalizeTraceContext(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const frame = { ...input } as Record<string, unknown>;
  const traceparent = normalizeTraceparent(
    typeof frame.correlation_id === "string" ? frame.correlation_id : undefined,
    frame.traceparent,
  );
  if (traceparent === undefined) delete frame.traceparent;
  else frame.traceparent = traceparent;
  return frame;
}

export const CorrelationId = z.string().regex(CORRELATION_ID_RE);

// A context is a follow-up within one sitting, not a durable relationship. See
// the "Out of scope" section of the multi-turn design for why cross-day
// continuity is deliberately excluded: a resumed session describes a working
// tree that has since moved, and answers worse than a cold one.
export const CONTEXT_TTL_MS = 30 * 60_000;
export const MAX_CONTEXT_TURNS = 10;
// Bounds the callee's on-disk binding store so inbound calls can never drive an
// unbounded local write. Least-recently-used entries are evicted past this.
export const MAX_CONTEXTS = 100;
// A caller can share many rosters with a callee, but the attestation rides on
// every inbound call. Bound it at the protocol edge so neither a pathological
// account nor a compromised relay can hand the listener unbounded policy input.
export const MAX_CALLER_GROUPS = 50;
export const RELAY_CALL_TIMEOUT_MS = 360_000;
export const AGENT_TIMEOUT_MS = 300_000;
// Was 10, raised when multi-turn landed. A threaded turn spawns a full agent,
// so charging per turn is correct and stays — but at 10 a single five-turn
// conversation consumed half a caller's hourly budget and two conversations
// were a violation, which would have rate-limited the feature's own happy path.
// MAX_CONTEXT_TURNS is the tighter, better-targeted bound on threading abuse,
// so this limit does not have to carry that weight.
export const RATE_LIMIT_PER_HOUR = 30;

export const ErrorCode = z.enum([
  "unknown_handle", "offline", "busy", "timeout", "canceled", "agent_error",
  "unauthorized", "rate_limited", "message_too_large", "protocol_error",
  "blocked", "task_not_offered", "task_unknown", "context_unknown",
]);
export const RelayOperationalErrorCode = z.enum([
  "unknown_handle", "offline", "timeout", "canceled", "unauthorized",
  "rate_limited", "message_too_large", "protocol_error",
]);
export const PeerFailureCode = z.enum([
  "busy", "timeout", "agent_error", "blocked", "task_not_offered", "task_unknown", "context_unknown",
]);

export const CallStatus = z.object({
  type: z.literal("call_status"),
  state: z.enum(["ringing", "answered", "working"]),
  call_id: z.string().optional(),
  correlation_id: CorrelationId.optional(),
});
export const RelayCallError = z.object({
  type: z.literal("call_error"),
  origin: z.literal("relay"),
  code: RelayOperationalErrorCode,
  call_id: z.string().optional(),
  correlation_id: CorrelationId.optional(),
}).strict();
// Acknowledgement splits in two because acceptance and process start are
// distinct lifecycle events. This lets the relay distinguish "frame never arrived"
// from "listener owns it but hasn't spawned yet". The task store needs that
// distinction to map SUBMITTED vs WORKING and to decide whether a cancel
// request must be negotiated with the listener at all.
export const CallAccepted = z.object({ type: z.literal("call_accepted"), call_id: z.string() });
export const CallStarted = z.object({ type: z.literal("call_started"), call_id: z.string() });

export const CancelCall = z.object({ type: z.literal("cancel_call"), call_id: z.string() });

// Sent ONLY after the pending closure was definitely removed, or the process
// group was observed exited. Acknowledging on signal-sent would let the relay
// publish a CANCELED task whose agent is still running on the callee's machine.
export const CallCancelled = z.object({
  type: z.literal("call_cancelled"),
  call_id: z.string(),
  phase: z.enum(["pending", "running"]),
});
export const CallNotCancelled = z.object({
  type: z.literal("call_not_cancelled"),
  call_id: z.string(),
  reason: z.enum(["already_terminal", "unknown", "too_late"]),
});
export const CallRejected = z.object({
  type: z.literal("call_rejected"),
  call_id: z.string(),
  code: z.literal("protocol_error"),
}).strict();

export const AGENT_KINDS = ["claude", "codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AgentKindSchema = z.enum(AGENT_KINDS);

export const RegisterRequest = z.object({
  invite: z.string().min(40).max(200),
  handle: z.string().regex(HANDLE_RE),
  // Absent = caller-only: the handle can call others but is not callable.
  agent_kind: AgentKindSchema.optional(),
});
export const RegisterResponse = z.object({ org: z.string().regex(ORG_RE), token: z.string(), address: z.string() });

export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type RelayOperationalErrorCodeType = z.infer<typeof RelayOperationalErrorCode>;
export type PeerFailureCodeType = z.infer<typeof PeerFailureCode>;
export type CallStatusType = z.infer<typeof CallStatus>;
export type CallAcceptedType = z.infer<typeof CallAccepted>;
export type CallStartedType = z.infer<typeof CallStarted>;
export type CancelCallType = z.infer<typeof CancelCall>;
export type CallCancelledType = z.infer<typeof CallCancelled>;
export type CallNotCancelledType = z.infer<typeof CallNotCancelled>;
export type RegisterRequestType = z.infer<typeof RegisterRequest>;
export type RegisterResponseType = z.infer<typeof RegisterResponse>;

export function parseAddress(addr: string): { handle: string; host: string } | null {
  const at = addr.indexOf("@");
  if (at <= 0) return null;
  const handle = addr.slice(0, at);
  const host = addr.slice(at + 1);
  if (!HANDLE_RE.test(handle)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  return { handle, host };
}

// Peer-controlled free-form text has two display paths. Human-readable output
// must neutralize terminal controls and Unicode bidi formatting; structured
// JSON output preserves the payload because JSON.stringify escapes controls.
// Replacing dangerous characters with spaces keeps adjacent words separate,
// and removing ESC/C1 introducers makes the rest of CSI/OSC sequences inert.
const TERMINAL_CONTROLS_AND_BIDI =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const ALL_CONTROLS_AND_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const JSON_UNESCAPED_TERMINAL_CHARS =
  /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

// Reply bodies retain tabs and line feeds so ordinary multi-line agent output
// stays readable. Every other C0/C1 control is unsafe, including carriage
// return because it can overwrite already-rendered terminal content.
export function sanitizeTerminalOutput(text: string): string {
  return text.replace(TERMINAL_CONTROLS_AND_BIDI, " ");
}

// JSON.stringify already escapes C0 controls such as ESC, but JSON permits
// C1 controls and bidi formatting as literal characters. Escape those code
// points in the serialized representation without changing the value a JSON
// consumer parses.
export function stringifyTerminalSafeJson(value: object): string {
  return JSON.stringify(value).replace(
    JSON_UNESCAPED_TERMINAL_CHARS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Error details are single-line and bounded. The length cut counts UTF-16 code
// units to match zod's .max(), trimming a trailing lone high surrogate rather
// than emitting half a code point.
export function sanitizeDetail(detail: string, max: number = MAX_DETAIL_LENGTH): string {
  const cleaned = detail.replace(ALL_CONTROLS_AND_BIDI, " ");
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function safeParseFrame<S extends z.ZodTypeAny>(schema: S, raw: string): z.infer<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
