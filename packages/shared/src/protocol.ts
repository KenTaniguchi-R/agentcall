import { z } from "zod";

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const ORG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Bounds derived from TASK_ID_RE: 1 (mandatory first char) + 63 (0-63 range) = 64.
// Must stay consistent with TASK_ID_RE; drift is caught by test/protocol.test.ts.
export const MAX_TASK_ID_LENGTH = 64;
// Bounds the `offered` list on call_failed/call_error: without a cap, a
// hostile listener could hand back thousands of entries (unbounded relay
// payload); without the TASK_ID_RE constraint on each entry, an unvalidated
// string could carry terminal-escape/control sequences straight into a
// caller's stdout (terminal injection).
export const MAX_OFFERED_TASKS = 50;
export const MAX_MESSAGE_BYTES = 64_000;
export const MAX_REPLY_BYTES = 256_000;
// `detail` is the one free-form string a callee can put in front of a
// caller's eyes, and the CLI prints it straight to the terminal (see
// callClient.ts / index.ts). It needs the same treatment `offered` above
// got, and for the same two reasons: unbounded it's attacker-controlled
// relay bandwidth, and unfiltered it's terminal-escape injection — ESC/CSI
// sequences can clear the caller's screen, retitle their window, or paint
// fake output over a real error.
export const MAX_DETAIL_LENGTH = 500;
// The context id is minted by the callee (packages/cli/src/contexts.ts), never
// by a caller, so its exact shape is known: "ctx_" + 22 base64url characters =
// 128 bits of randomness. This replaces a 256-byte length cap that existed only
// because the field was forwarded and dropped without ever being consumed. Now
// that it selects a resumable agent session, a malformed value is rejected at
// the schema boundary — before it reaches any store lookup.
export const CONTEXT_ID_RE = /^ctx_[A-Za-z0-9_-]{22}$/;

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
  "unknown_handle", "offline", "busy", "timeout", "agent_error",
  "unauthorized", "rate_limited", "message_too_large", "protocol_error",
  "blocked", "task_not_offered", "task_unknown", "context_unknown",
]);

export const CallRequest = z.object({
  type: z.literal("call_request"),
  to: z.string().regex(HANDLE_RE),
  message: z.string().min(1),
  context_id: z.string().regex(CONTEXT_ID_RE).optional(),
  task: z.string().regex(TASK_ID_RE).optional(),
});
export const CallStatus = z.object({
  type: z.literal("call_status"),
  state: z.enum(["ringing", "answered", "working"]),
});
export const CallReply = z.object({
  type: z.literal("call_reply"),
  call_id: z.string(),
  text: z.string(),
  context_id: z.string().regex(CONTEXT_ID_RE).optional(),
  task: z.string().regex(TASK_ID_RE).optional(),
});
// detail is bounded here but NOT on CallFailed below: the same split the
// protocol already makes for reply text. Listener->relay fields arrive from
// an untrusted peer and are normalized by the relay (see do.ts's
// truncateUtf8Bytes / sanitizeDetail); relay->caller fields are a contract
// the relay guarantees, so bounding them here would turn a verbose callee
// into a dropped frame and a 6-minute caller hang.
export const CallError = z.object({
  type: z.literal("call_error"),
  code: ErrorCode,
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
  offered: z.array(z.string().regex(TASK_ID_RE)).max(MAX_OFFERED_TASKS).optional(),
});
export const IncomingCall = z.object({
  type: z.literal("incoming_call"),
  call_id: z.string(),
  from: z.string(),
  message: z.string(),
  // Relay-attested opaque roster ids. The caller never sends this field: the
  // relay derives the caller/callee intersection during websocket admission.
  // Missing defaults to no groups, which fails closed with an older relay.
  groups: z.array(z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)).max(MAX_CALLER_GROUPS).default([]),
  context_id: z.string().regex(CONTEXT_ID_RE).optional(),
  task: z.string().regex(TASK_ID_RE).optional(),
});
export const CallAnswer = z.object({ type: z.literal("call_answer"), call_id: z.string() });
export const CallResult = z.object({
  type: z.literal("call_result"),
  call_id: z.string(),
  text: z.string(),
  context_id: z.string().regex(CONTEXT_ID_RE).optional(),
  task: z.string().regex(TASK_ID_RE).optional(),
});
export const CallFailed = z.object({
  type: z.literal("call_failed"),
  call_id: z.string(),
  code: ErrorCode,
  detail: z.string().optional(),
  offered: z.array(z.string().regex(TASK_ID_RE)).max(MAX_OFFERED_TASKS).optional(),
});

// Acknowledgement splits in two because `call_answer` fired when the job
// STARTED, which left the relay unable to distinguish "frame never arrived"
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

export const CallerFrame = z.discriminatedUnion("type", [CallRequest]);
export const ListenerToRelayFrame = z.discriminatedUnion("type", [
  CallAnswer, CallResult, CallFailed,
  CallAccepted, CallStarted, CallCancelled, CallNotCancelled,
]);
export const RelayToCallerFrame = z.discriminatedUnion("type", [CallStatus, CallReply, CallError]);
export const RelayToListenerFrame = z.discriminatedUnion("type", [IncomingCall, CancelCall]);

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

export const CreateInviteResponse = z.object({
  invite: z.string().min(40).max(200),
  expires_at: z.number().int().positive(),
});

export const BootstrapInviteRequest = z.object({ org: z.string().regex(ORG_RE) });

export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type CallRequestType = z.infer<typeof CallRequest>;
export type CallStatusType = z.infer<typeof CallStatus>;
export type CallReplyType = z.infer<typeof CallReply>;
export type CallErrorType = z.infer<typeof CallError>;
export type IncomingCallType = z.infer<typeof IncomingCall>;
export type CallAnswerType = z.infer<typeof CallAnswer>;
export type CallResultType = z.infer<typeof CallResult>;
export type CallFailedType = z.infer<typeof CallFailed>;
export type CallAcceptedType = z.infer<typeof CallAccepted>;
export type CallStartedType = z.infer<typeof CallStarted>;
export type CancelCallType = z.infer<typeof CancelCall>;
export type CallCancelledType = z.infer<typeof CallCancelled>;
export type CallNotCancelledType = z.infer<typeof CallNotCancelled>;
export type RegisterRequestType = z.infer<typeof RegisterRequest>;
export type RegisterResponseType = z.infer<typeof RegisterResponse>;
export type CallerFrameType = z.infer<typeof CallerFrame>;
export type ListenerToRelayFrameType = z.infer<typeof ListenerToRelayFrame>;
export type RelayToCallerFrameType = z.infer<typeof RelayToCallerFrame>;
export type RelayToListenerFrameType = z.infer<typeof RelayToListenerFrame>;

export function parseAddress(addr: string): { handle: string; host: string } | null {
  const at = addr.indexOf("@");
  if (at <= 0) return null;
  const handle = addr.slice(0, at);
  const host = addr.slice(at + 1);
  if (!HANDLE_RE.test(handle)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  return { handle, host };
}

// Makes an untrusted `detail` safe to print and bounded in size. Control
// characters become a space rather than being dropped, so a stripped newline
// doesn't run two words together; a CSI/OSC sequence loses its introducer and
// degrades to inert literal text. The length cut counts UTF-16 code units to
// match zod's .max() on CallError.detail, trimming a trailing lone high
// surrogate rather than emitting half a code point.
export function sanitizeDetail(detail: string, max: number = MAX_DETAIL_LENGTH): string {
  const cleaned = detail.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
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
