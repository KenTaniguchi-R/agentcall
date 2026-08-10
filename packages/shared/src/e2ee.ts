import { z } from "zod";
import { canonicalEncode } from "./canonical.js";
import { ADDRESS_RE, RELAY_ORIGIN_RE } from "./keys.js";
import { BASE64URL_RE } from "./signing.js";
import { AgentCallTerminalReason } from "./a2a/task.js";
import {
  CallAccepted, CallCancelled, CallNotCancelled, CallQueued, CallRejected, CallStarted, CallStatus,
  CancelCall, CorrelationId, CONTEXT_ID_RE, MAX_DETAIL_LENGTH, MAX_MESSAGE_BYTES,
  HANDLE_RE, LeaseId, MAILBOX_TTL_MS, MAX_OFFERED_TASKS, MAX_REPLY_BYTES, MessageId,
  normalizeTraceContext, PeerFailureCode, RELAY_CALL_TIMEOUT_MS, RelayCallError, TASK_ID_RE,
} from "./protocol.js";

const KEY_ID_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
const utf8 = (max: number) => z.string()
  .refine(isWellFormedUnicode, { message: "must contain well-formed Unicode" })
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= max,
    { message: `must contain at most ${max} UTF-8 bytes` },
  );

export const E2EE_REQUEST_INFO = new TextEncoder().encode("agentcall/v1/request");
export const E2EE_RESPONSE_INFO = new TextEncoder().encode("agentcall/v1/response");
// The signed payload is JSON today. A schema-valid UTF-8 byte can expand to
// six wire bytes when JSON escapes an ASCII control character (for example,
// NUL becomes `\u0000`). Keep room for that worst case plus fixed metadata,
// signatures, failure details, offered tasks, and the AEAD tag.
export const MAX_E2EE_CIPHERTEXT_BYTES = MAX_REPLY_BYTES * 6 + 8_192;
export const MAX_E2EE_WIRE_BYTES = Math.ceil(MAX_E2EE_CIPHERTEXT_BYTES * 4 / 3) + 4_096;

export const HpkeEnvelopeHeader = z.object({
  v: z.literal(1),
  direction: z.enum(["request", "response"]),
  relay_origin: z.string().regex(RELAY_ORIGIN_RE),
  from: z.string().regex(ADDRESS_RE),
  to: z.string().regex(ADDRESS_RE),
  key_id: z.string().regex(KEY_ID_RE),
  epoch: z.number().int().positive(),
}).strict();
export type HpkeEnvelopeHeaderType = z.infer<typeof HpkeEnvelopeHeader>;

export const HpkeEnvelope = HpkeEnvelopeHeader.extend({
  // P-256 SEC1 uncompressed point: 65 bytes, or 87 base64url characters.
  enc: z.string().regex(BASE64URL_RE).max(87),
  ct: z.string().regex(BASE64URL_RE).refine(
    (value) => Math.ceil(value.length * 3 / 4) <= MAX_E2EE_CIPHERTEXT_BYTES,
    { message: `ciphertext must contain at most ${MAX_E2EE_CIPHERTEXT_BYTES} bytes` },
  ),
}).strict();
export type HpkeEnvelopeType = z.infer<typeof HpkeEnvelope>;

const InnerBase = z.object({
  v: z.literal(1),
  relay_origin: z.string().regex(RELAY_ORIGIN_RE),
  from: z.string().regex(ADDRESS_RE),
  to: z.string().regex(ADDRESS_RE),
  message_id: MessageId.optional(),
  delivery_mode: z.enum(["sync", "durable"]).optional(),
  request_id: z.string().regex(REQUEST_ID_RE),
  sender_identity_key_id: z.string().regex(KEY_ID_RE),
  recipient_encryption_key_id: z.string().regex(KEY_ID_RE),
  recipient_epoch: z.number().int().positive(),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
});

export const E2EERequestPayload = InnerBase.extend({
  direction: z.literal("request"),
  task: z.string().regex(TASK_ID_RE).optional(),
  context_id: z.string().regex(CONTEXT_ID_RE).optional(),
  message: utf8(MAX_MESSAGE_BYTES).and(z.string().min(1)),
}).strict().refine((value) => {
  if (value.delivery_mode === "durable" && value.message_id === undefined) return false;
  const maximum = value.delivery_mode === "durable" ? MAILBOX_TTL_MS : RELAY_CALL_TIMEOUT_MS;
  return value.expires_at > value.issued_at && value.expires_at - value.issued_at <= maximum;
}, {
  message: "request validity exceeds its delivery mode",
});
export type E2EERequestPayloadType = z.infer<typeof E2EERequestPayload>;

const ReplyOutcome = z.object({
  kind: z.literal("reply"),
  text: utf8(MAX_REPLY_BYTES),
  context_id: z.string().regex(CONTEXT_ID_RE).optional(),
  task: z.string().regex(TASK_ID_RE).optional(),
}).strict();
const FailureOutcome = z.object({
  kind: z.literal("failure"),
  code: PeerFailureCode,
  detail: utf8(MAX_DETAIL_LENGTH).optional(),
  offered: z.array(z.string().regex(TASK_ID_RE)).max(MAX_OFFERED_TASKS).optional(),
}).strict();
export const E2EEOutcome = z.discriminatedUnion("kind", [ReplyOutcome, FailureOutcome]);
export type E2EEOutcomeType = z.infer<typeof E2EEOutcome>;

export const E2EEResponsePayload = InnerBase.extend({
  direction: z.literal("response"),
  request_transcript_hash: z.string().regex(HASH_RE),
  outcome: E2EEOutcome,
}).strict().refine((value) => {
  if (value.delivery_mode === "durable" && value.message_id === undefined) return false;
  const maximum = value.delivery_mode === "durable" ? MAILBOX_TTL_MS : RELAY_CALL_TIMEOUT_MS;
  return value.expires_at > value.issued_at && value.expires_at - value.issued_at <= maximum;
}, {
  message: "response validity exceeds its delivery mode",
});
export type E2EEResponsePayloadType = z.infer<typeof E2EEResponsePayload>;

const RequestEnvelope = HpkeEnvelope.refine((value) => value.direction === "request", {
  message: "call request must contain a request envelope",
});
const ResponseEnvelope = HpkeEnvelope.refine((value) => value.direction === "response", {
  message: "call outcome must contain a response envelope",
});

export const EncryptedCallRequest = z.preprocess(normalizeTraceContext, z.object({
  type: z.literal("call_request"),
  envelope: RequestEnvelope,
  message_id: MessageId.optional(),
  delivery_mode: z.enum(["sync", "durable"]).optional(),
  correlation_id: CorrelationId,
  traceparent: z.string().optional(),
}).strict().refine((value) => value.delivery_mode !== "durable" || value.message_id !== undefined, {
  message: "message_id is required for durable delivery",
  path: ["message_id"],
}));

export const EncryptedIncomingCall = z.preprocess(normalizeTraceContext, z.object({
  type: z.literal("incoming_call"),
  call_id: z.string(),
  from: z.string().regex(HANDLE_RE),
  envelope: RequestEnvelope,
  message_id: MessageId.optional(),
  delivery_mode: z.enum(["sync", "durable"]).optional(),
  lease_id: LeaseId.optional(),
  execute_by: z.number().int().positive().optional(),
  correlation_id: CorrelationId,
  traceparent: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.delivery_mode !== "durable") return;
  for (const field of ["message_id", "lease_id", "execute_by"] as const) {
    if (value[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `${field} is required for durable delivery` });
  }
}));

export const EncryptedCallOutcome = z.object({
  type: z.literal("call_outcome"),
  call_id: z.string(),
  terminal: z.enum(["completed", "failed"]),
  terminal_reason: AgentCallTerminalReason.optional(),
  envelope: ResponseEnvelope,
  lease_id: LeaseId.optional(),
}).strict();

export const E2EECallerFrame = EncryptedCallRequest;
export const E2EEListenerToRelayFrame = z.discriminatedUnion("type", [
  EncryptedCallOutcome, CallAccepted, CallStarted, CallCancelled, CallNotCancelled, CallRejected,
]);
export const E2EERelayToCallerFrame = z.discriminatedUnion("type", [
  CallStatus, CallQueued, RelayCallError, EncryptedCallOutcome,
]);
export const E2EERelayToListenerFrame = z.union([EncryptedIncomingCall, CancelCall]);

export type EncryptedIncomingCallType = z.infer<typeof EncryptedIncomingCall>;

export const SignedE2EERequest = z.object({ payload: E2EERequestPayload, signature: z.string().regex(BASE64URL_RE).max(256) }).strict();
export const SignedE2EEResponse = z.object({ payload: E2EEResponsePayload, signature: z.string().regex(BASE64URL_RE).max(256) }).strict();

export function hpkeEnvelopeAad(header: HpkeEnvelopeHeaderType): Uint8Array {
  const value = HpkeEnvelopeHeader.parse(header);
  return canonicalEncode([
    "agentcall/hpke-aad/v1", value.v, value.direction, value.relay_origin,
    value.from, value.to, value.key_id, value.epoch,
  ]);
}

export function requestTranscript(value: E2EERequestPayloadType): Uint8Array {
  const p = E2EERequestPayload.parse(value);
  return canonicalEncode([
    p.delivery_mode === "durable" ? "agentcall/request/v2" : "agentcall/request/v1",
    p.v, p.direction, p.relay_origin, p.from, p.to,
    ...(p.delivery_mode === "durable" ? [p.message_id!] : []),
    p.request_id, p.sender_identity_key_id, p.recipient_encryption_key_id,
    p.recipient_epoch, p.issued_at, p.expires_at, p.task ?? null,
    p.context_id ?? null, p.message, ...(p.delivery_mode === "durable" ? ["durable"] : []),
  ]);
}

export function responseTranscript(value: E2EEResponsePayloadType): Uint8Array {
  const p = E2EEResponsePayload.parse(value);
  const outcome = p.outcome.kind === "reply"
    ? ["reply", p.outcome.text, p.outcome.context_id ?? null, p.outcome.task ?? null]
    : ["failure", p.outcome.code, p.outcome.detail ?? null, p.outcome.offered?.length ?? 0, ...(p.outcome.offered ?? [])];
  return canonicalEncode([
    p.delivery_mode === "durable" ? "agentcall/response/v2" : "agentcall/response/v1",
    p.v, p.direction, p.relay_origin, p.from, p.to,
    ...(p.delivery_mode === "durable" ? [p.message_id!] : []),
    p.request_id, p.sender_identity_key_id, p.recipient_encryption_key_id,
    p.recipient_epoch, p.issued_at, p.expires_at, p.request_transcript_hash,
    ...outcome, ...(p.delivery_mode === "durable" ? ["durable"] : []),
  ]);
}

export async function transcriptHash(transcript: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", transcript as BufferSource));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
