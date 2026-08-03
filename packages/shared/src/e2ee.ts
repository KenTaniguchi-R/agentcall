import { z } from "zod";
import { canonicalEncode } from "./canonical.js";
import { ADDRESS_RE } from "./keys.js";
import {
  CallFailureCode, CONTEXT_ID_RE, MAX_DETAIL_LENGTH, MAX_MESSAGE_BYTES,
  MAX_OFFERED_TASKS, MAX_REPLY_BYTES, RELAY_CALL_TIMEOUT_MS, TASK_ID_RE,
} from "./protocol.js";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const KEY_ID_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const RELAY_ORIGIN_RE = /^[a-z0-9.-]{1,253}$/;
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
}).strict().refine((value) => value.expires_at > value.issued_at && value.expires_at - value.issued_at <= RELAY_CALL_TIMEOUT_MS, {
  message: `request validity must be positive and at most ${RELAY_CALL_TIMEOUT_MS}ms`,
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
  code: CallFailureCode,
  detail: utf8(MAX_DETAIL_LENGTH).optional(),
  offered: z.array(z.string().regex(TASK_ID_RE)).max(MAX_OFFERED_TASKS).optional(),
}).strict();
export const E2EEOutcome = z.discriminatedUnion("kind", [ReplyOutcome, FailureOutcome]);
export type E2EEOutcomeType = z.infer<typeof E2EEOutcome>;

export const E2EEResponsePayload = InnerBase.extend({
  direction: z.literal("response"),
  request_transcript_hash: z.string().regex(HASH_RE),
  outcome: E2EEOutcome,
}).strict().refine((value) => value.expires_at > value.issued_at && value.expires_at - value.issued_at <= RELAY_CALL_TIMEOUT_MS, {
  message: `response validity must be positive and at most ${RELAY_CALL_TIMEOUT_MS}ms`,
});
export type E2EEResponsePayloadType = z.infer<typeof E2EEResponsePayload>;

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
    "agentcall/request/v1", p.v, p.direction, p.relay_origin, p.from, p.to,
    p.request_id, p.sender_identity_key_id, p.recipient_encryption_key_id,
    p.recipient_epoch, p.issued_at, p.expires_at, p.task ?? null,
    p.context_id ?? null, p.message,
  ]);
}

export function responseTranscript(value: E2EEResponsePayloadType): Uint8Array {
  const p = E2EEResponsePayload.parse(value);
  const outcome = p.outcome.kind === "reply"
    ? ["reply", p.outcome.text, p.outcome.context_id ?? null, p.outcome.task ?? null]
    : ["failure", p.outcome.code, p.outcome.detail ?? null, p.outcome.offered?.length ?? 0, ...(p.outcome.offered ?? [])];
  return canonicalEncode([
    "agentcall/response/v1", p.v, p.direction, p.relay_origin, p.from, p.to,
    p.request_id, p.sender_identity_key_id, p.recipient_encryption_key_id,
    p.recipient_epoch, p.issued_at, p.expires_at, p.request_transcript_hash,
    ...outcome,
  ]);
}

export async function transcriptHash(transcript: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", transcript as BufferSource));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
