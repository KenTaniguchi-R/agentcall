import { z } from "zod";

// One source of truth for the three patterns, because they must agree: an org
// that registers must also be spellable in an address, and a drifting copy
// would let one be created that the other cannot name.
const ORG_BODY = "[a-z0-9][a-z0-9-]{1,19}";
const HANDLE_BODY = "[a-z0-9][a-z0-9-]{1,30}";

export const HANDLE_RE = new RegExp(`^${HANDLE_BODY}$`);
// 20 characters, not the 63 this allowed while orgs were DNS labels. The
// address is meant to be short enough to say out loud, and
// `@acme-corporation-platform-engineering/ken` would trade a vendor domain for
// a self-inflicted one.
export const ORG_RE = new RegExp(`^${ORG_BODY}$`);

// `@<org>/<handle>` — a registry key, not a locator. See
// docs/superpowers/specs/2026-08-05-address-as-registry-key.md.
//
// Deliberately unable to express a hostname: dots are absent from both bodies,
// so no DNS-shaped address can parse. That is the point rather than an
// oversight — nothing resolves an AgentCall address, and a key dressed as a
// locator invites tooling to try.
//
// The single address grammar. `keys.ts` imports it rather than keeping its own
// so a signed record and a dialled address can never disagree about what an
// address is.
export const ADDRESS_RE = new RegExp(`^@(${ORG_BODY})/(${HANDLE_BODY})$`);

// The hosted deployment's DNS host, and the single place it is written. It is
// the relay *endpoint* only: the CLI derives its default relay URL from it.
// Addresses no longer contain it, so nothing parses it back out.
//
// This is deployment configuration, not protocol: a self-hosted relay sets its
// own host and never reads this. Notably NOT the source of
// AGENTCALL_POLICY_EXT — see the comment there.
export const HOSTED_RELAY_HOST = "agent-call.app";
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
export const RELAY_CALL_TIMEOUT_MS = 360_000;
export const AGENT_TIMEOUT_MS = 300_000;
// Was 10, raised when multi-turn landed. A threaded turn spawns a full agent,
// so charging per turn is correct and stays — but at 10 a single five-turn
// conversation consumed half a caller's hourly budget and two conversations
// were a violation, which would have rate-limited the feature's own happy path.
// MAX_CONTEXT_TURNS is the tighter, better-targeted bound on threading abuse,
// so this limit does not have to carry that weight.
export const RATE_LIMIT_PER_HOUR = 30;

// `task_not_offered` was removed by #379 with the task menu it described.
// Nothing can emit it any more: a task is no longer individually granted, so a
// caller is either blocked outright — which refuses before any task is named —
// or the requested task exists on disk and resolves. Whether the ANSWER may
// reach them is a separate, later decision made by clearance, and it is
// reported through the reply's own fixed refusal reason, not as an error code.
export const ErrorCode = z.enum([
  "unknown_handle", "offline", "busy", "timeout", "canceled", "agent_error",
  "unauthorized", "rate_limited", "message_too_large", "protocol_error",
  "blocked", "task_unknown", "context_unknown",
]);
export const RelayOperationalErrorCode = z.enum([
  "unknown_handle", "offline", "timeout", "canceled", "unauthorized",
  "rate_limited", "message_too_large", "protocol_error",
]);
export const PeerFailureCode = z.enum([
  "busy", "timeout", "agent_error", "blocked", "task_unknown", "context_unknown",
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
// No `address`: it is `formatAddress(org, handle)` and the caller already knows
// both. Shipping the composed string is what forced the relay to build one, and
// the client to parse a host back out of it.
export const RegisterResponse = z.object({ org: z.string().regex(ORG_RE), token: z.string() });

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const RECOVERY_OPERATION_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

// Two quantities, two patterns — deliberately not one loose `(?:act|agr)_`
// alternation. Each field admits exactly one prefix, and a shared pattern
// would let a client public id satisfy a recovery public id field. The
// prefixes come from publicId() in the relay, which mints them from the
// first 16 hex characters of the corresponding digest.
export const CLIENT_PUBLIC_ID_RE = /^act_[0-9a-f]{16}$/;
export const RECOVERY_PUBLIC_ID_RE = /^agr_[0-9a-f]{16}$/;

export const RecoveryIssueRequest = z.object({
  expected_generation: z.number().int().nonnegative(),
  successor_recovery_digest: z.string().regex(SHA256_HEX_RE),
  successor_recovery_public_id: z.string().regex(RECOVERY_PUBLIC_ID_RE),
}).strict();
export const RecoveryIssueResponse = z.object({
  generation: z.number().int().positive(),
  recovery_public_id: z.string().regex(RECOVERY_PUBLIC_ID_RE),
}).strict();
export const RecoveryStatusResponse = z.object({
  issued: z.boolean(),
  generation: z.number().int().nonnegative(),
  recovery_public_id: z.string().regex(RECOVERY_PUBLIC_ID_RE).optional(),
}).strict();
export const RecoveryRedeemRequest = z.object({
  org: z.string().regex(ORG_RE),
  handle: z.string().regex(HANDLE_RE),
  generation: z.number().int().positive(),
  current_recovery_proof: z.string().min(32).max(200),
  operation_id: z.string().regex(RECOVERY_OPERATION_ID_RE),
  client_token_digest: z.string().regex(SHA256_HEX_RE),
  client_public_id: z.string().regex(CLIENT_PUBLIC_ID_RE),
  successor_recovery_digest: z.string().regex(SHA256_HEX_RE),
  successor_recovery_public_id: z.string().regex(RECOVERY_PUBLIC_ID_RE),
}).strict();
export const RecoveryReceipt = z.object({
  org: z.string().regex(ORG_RE),
  handle: z.string().regex(HANDLE_RE),
  operation_id: z.string().regex(RECOVERY_OPERATION_ID_RE),
  consumed_generation: z.number().int().positive(),
  recovery_generation: z.number().int().positive(),
  client_public_id: z.string().regex(CLIENT_PUBLIC_ID_RE),
  recovery_public_id: z.string().regex(RECOVERY_PUBLIC_ID_RE),
  committed_at: z.number().int().nonnegative(),
  // Confirms the recovered identity's current DO applied its tombstone. Before
  // #154, this is not a claim that caller sockets housed in remote DOs closed.
  eviction_confirmed: z.boolean(),
  // #346: the relay already knows this from `handles`, and it never changes
  // after registration. Redeeming with no local config.json to preserve it
  // from must still be able to restore a callable line as callable — nullable,
  // not optional, because the relay always knows the true answer and a missing
  // key here would be indistinguishable from "not reported."
  agent_kind: AgentKindSchema.nullable(),
}).strict();

export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type RelayOperationalErrorCodeType = z.infer<typeof RelayOperationalErrorCode>;
export type CallStatusType = z.infer<typeof CallStatus>;
export type RecoveryIssueRequestType = z.infer<typeof RecoveryIssueRequest>;
export type RecoveryIssueResponseType = z.infer<typeof RecoveryIssueResponse>;
export type RecoveryStatusResponseType = z.infer<typeof RecoveryStatusResponse>;
export type RecoveryRedeemRequestType = z.infer<typeof RecoveryRedeemRequest>;
export type RecoveryReceiptType = z.infer<typeof RecoveryReceipt>;

export function formatAddress(org: string, handle: string): string {
  return `@${org}/${handle}`;
}

// Returns the pair, not a host. Callers that need to know which relay to dial
// read `cfg.relay`; an address never carried that information usefully, because
// a caller only ever reaches its own organization's relay.
export function parseAddress(addr: string): { org: string; handle: string } | null {
  const m = ADDRESS_RE.exec(addr);
  return m ? { org: m[1]!, handle: m[2]! } : null;
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

// One cell of an aligned listing, where sanitizeTerminalOutput is not enough.
// It keeps tab and line feed so a multi-line agent reply stays readable, but
// in a single-line row a line feed forges an entire additional row and a tab
// shifts every column after it. Either turns caller-supplied text — an invite
// description, a join-key label — into a way to hide the row above it, which
// matters most for exactly the rows an operator is scanning for: an admin
// grant they did not expect. ALL_CONTROLS_AND_BIDI is the same class
// sanitizeDetail uses, without its length cut.
export function sanitizeTerminalCell(text: string): string {
  return text.replace(ALL_CONTROLS_AND_BIDI, " ");
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
