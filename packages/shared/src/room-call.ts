import { z } from "zod";
import { canonicalEncode, type CanonicalValue } from "./canonical.js";
import { fromBase64UrlStrict, toBase64Url } from "./signing.js";
import {
  ROOM_MAX_PROMPT_BYTES, ROOM_MAX_REPLY_BYTES,
  RoomCallId, RoomId, RoomParticipantId, RoomPublicKey,
} from "./room.js";

/**
 * The sealed payload inside a Room call's `encrypted_request` /
 * `encrypted_outcome`.
 *
 * Unlike the durable-identity path in `e2ee.ts`, whose crypto lives in
 * `packages/cli/src/e2ee.ts` because it needs the on-disk key store, a Room
 * call's keys are ephemeral and passed in as arguments. Nothing here touches
 * a filesystem or an identity, so the seal/open pair lives beside the format
 * it implements: a byte layout split across two packages is a correctness
 * hazard, and both sides of a Room call are CLIs agreeing on exactly this.
 * The relay never calls it — `encrypted_request` is opaque there by design.
 */

export const ROOM_CALL_ENVELOPE_VERSION = 1 as const;

/** version byte + ephemeral X25519 public key + AES-GCM tag. */
const ENVELOPE_OVERHEAD_BYTES = 1 + 32 + 16;
const EPHEMERAL_KEY_OFFSET = 1;
const CIPHERTEXT_OFFSET = 33;
const SIGNATURE_BYTES = 64;

const Timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * The plaintext is `canonicalEncode`d, not JSON — and that is a size
 * requirement, not a style preference. `ROOM_MAX_ENCRYPTED_REQUEST_BYTES`
 * allows only 1 KiB over the 4 KiB prompt, while JSON escaping can expand one
 * schema-valid UTF-8 byte into six wire bytes. A tagged length-prefixed
 * encoding makes the overhead a constant instead of a function of the
 * message's control characters.
 */
const utf8 = (max: number) => z.string()
  .refine((value) => !hasUnpairedSurrogate(value), { message: "must contain well-formed Unicode" })
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= max,
    { message: `must contain at most ${max} UTF-8 bytes` },
  );

export const RoomCallFailureCode = z.enum([
  "agent_error", "agent_timeout", "canceled", "undeliverable",
]);

/**
 * `expires_at` is the *sender's* declared validity, and it lives in the signed
 * plaintext rather than the binding below. The relay assigns its own deadline
 * — `min(room.expires_at, now + ROOM_AGENT_TIMEOUT_MS)` on the relay clock
 * (`apps/relay/src/room/do.ts`) — which the sender cannot know at seal time,
 * so it cannot be authenticated data. The recipient enforces both: the
 * relay's `expires_at` off `room_incoming_call`, and this one.
 */
export const RoomCallRequestPayload = z.object({
  v: z.literal(ROOM_CALL_ENVELOPE_VERSION),
  issued_at: Timestamp,
  expires_at: Timestamp,
  message: utf8(ROOM_MAX_PROMPT_BYTES).pipe(z.string().min(1)),
}).strict().refine((value) => value.expires_at > value.issued_at, {
  path: ["expires_at"], message: "Room call validity must be positive",
});
export type RoomCallRequestPayloadType = z.infer<typeof RoomCallRequestPayload>;

const RoomCallReply = z.object({
  kind: z.literal("reply"),
  text: utf8(ROOM_MAX_REPLY_BYTES).pipe(z.string().min(1)),
}).strict();
const RoomCallFailure = z.object({
  kind: z.literal("failure"),
  code: RoomCallFailureCode,
}).strict();

/**
 * A failure carries a code and no detail string. The durable path's
 * `FailureOutcome` has a `detail`, but a Room peer is accountless and
 * unvouched-for: there is no reason to render free text it authored, and
 * #259 requires never echoing peer-controlled detail. The code is enough to
 * say what happened.
 */
export const RoomCallOutcomeBody = z.discriminatedUnion("kind", [RoomCallReply, RoomCallFailure]);
export type RoomCallOutcomeBodyType = z.infer<typeof RoomCallOutcomeBody>;

export const RoomCallOutcomePayload = z.object({
  v: z.literal(ROOM_CALL_ENVELOPE_VERSION),
  issued_at: Timestamp,
  outcome: RoomCallOutcomeBody,
}).strict();
export type RoomCallOutcomePayloadType = z.infer<typeof RoomCallOutcomePayload>;

/**
 * Every identifier here is relay-attested: the sender cannot choose its own
 * `from_participant_id`, Room, or epoch (`apps/relay/src/room/do.ts` injects
 * them), and the recipient reads them back off `room_incoming_call`. Binding
 * the seal to them is what makes a call non-transplantable — a sealed request
 * cannot be replayed into another Room, another epoch, another recipient, or
 * attributed to another sender.
 */
export const RoomCallBinding = z.object({
  room_id: RoomId,
  membership_epoch: z.number().int().min(1).max(0xffff_ffff),
  from_participant_id: RoomParticipantId,
  to_participant_id: RoomParticipantId,
  call_id: RoomCallId,
}).strict().refine((value) => value.from_participant_id !== value.to_participant_id, {
  path: ["to_participant_id"], message: "Room calls must target another participant",
});
export type RoomCallBindingType = z.infer<typeof RoomCallBinding>;

export type RoomCallDirection = "request" | "outcome";

function bindingFields(binding: RoomCallBindingType): CanonicalValue[] {
  return [
    binding.room_id, binding.membership_epoch, binding.from_participant_id,
    binding.to_participant_id, binding.call_id,
  ];
}

/** AES-GCM associated data. Authenticated, never transmitted — both sides rebuild it. */
export function canonicalRoomCallAad(
  binding: RoomCallBindingType, direction: RoomCallDirection,
): Uint8Array {
  const parsed = RoomCallBinding.parse(binding);
  return canonicalEncode(["agentcall/room-call-aad/v1", direction, ...bindingFields(parsed)]);
}

/** HKDF `info`. Distinct domain from the AAD so the two can never collide. */
function roomCallKdfInfo(binding: RoomCallBindingType, direction: RoomCallDirection): Uint8Array {
  return canonicalEncode(["agentcall/room-call-seal/v1", direction, ...bindingFields(binding)]);
}

/**
 * What the sender's ephemeral Ed25519 key signs. The signature travels inside
 * the ciphertext, so the relay never sees who signed what — it only ever holds
 * an opaque blob.
 */
export function roomCallRequestTranscript(
  binding: RoomCallBindingType, payload: RoomCallRequestPayloadType,
): Uint8Array {
  const b = RoomCallBinding.parse(binding);
  const p = RoomCallRequestPayload.parse(payload);
  return canonicalEncode([
    "agentcall/room-call-request/v1", ...bindingFields(b), p.v, p.issued_at, p.expires_at, p.message,
  ]);
}

export function roomCallOutcomeTranscript(
  binding: RoomCallBindingType, payload: RoomCallOutcomePayloadType,
): Uint8Array {
  const b = RoomCallBinding.parse(binding);
  const p = RoomCallOutcomePayload.parse(payload);
  const outcome: CanonicalValue[] = p.outcome.kind === "reply"
    ? ["reply", p.outcome.text]
    : ["failure", p.outcome.code];
  return canonicalEncode([
    "agentcall/room-call-outcome/v1", ...bindingFields(b), p.v, p.issued_at, ...outcome,
  ]);
}

/**
 * `request_digest` is over the *ciphertext*, not the prompt. The relay stores
 * it and rejects a changed digest under a reused idempotency key
 * (`apps/relay/src/room/do.ts`), so it only needs to identify the wire
 * payload. Digesting the plaintext would hand the relay an offline guessing
 * oracle for short prompts, in a protocol whose whole point is that the relay
 * cannot read them.
 */
export async function roomCallCiphertextDigest(encrypted: string): Promise<string> {
  const bytes = fromBase64UrlStrict(encrypted);
  if (!bytes) throw new Error("Room call ciphertext is not canonical base64url");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveSealKey(
  ephemeralPrivate: CryptoKey, peerPublic: CryptoKey,
  binding: RoomCallBindingType, direction: RoomCallDirection,
): Promise<{ key: CryptoKey; nonce: Uint8Array }> {
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: peerPublic }, ephemeralPrivate, 256,
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0),
      info: roomCallKdfInfo(binding, direction) as BufferSource,
    },
    material,
    (32 + 12) * 8,
  ));
  return {
    key: await crypto.subtle.importKey(
      "raw", derived.slice(0, 32) as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
    ),
    nonce: derived.slice(32),
  };
}

function importEncryptionPublicKey(b64url: string): Promise<CryptoKey> {
  const raw = fromBase64UrlStrict(RoomPublicKey.parse(b64url));
  if (!raw) throw new Error("Room encryption key is not canonical base64url");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "X25519" }, false, []);
}

interface SealInput {
  binding: RoomCallBindingType;
  direction: RoomCallDirection;
  /** The recipient's `encryption_public_key`, read from the membership snapshot. */
  recipientEncryptionPublicKey: string;
  /** The sender's ephemeral Ed25519 private key. */
  senderSigningPrivateKey: CryptoKey;
  transcript: Uint8Array;
  plaintextFields: readonly CanonicalValue[];
}

async function sealRoomCallEnvelope(input: SealInput): Promise<string> {
  const binding = RoomCallBinding.parse(input.binding);
  const recipient = await importEncryptionPublicKey(input.recipientEncryptionPublicKey);
  const ephemeral = await crypto.subtle.generateKey(
    { name: "X25519" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const { key, nonce } = await deriveSealKey(ephemeral.privateKey, recipient, binding, input.direction);

  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" }, input.senderSigningPrivateKey, input.transcript as BufferSource,
  ));
  const body = canonicalEncode(input.plaintextFields);
  const plaintext = new Uint8Array(SIGNATURE_BYTES + body.byteLength);
  plaintext.set(signature, 0);
  plaintext.set(body, SIGNATURE_BYTES);

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: canonicalRoomCallAad(binding, input.direction) as BufferSource },
    key,
    plaintext as BufferSource,
  ));
  const rawEphemeral = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const envelope = new Uint8Array(CIPHERTEXT_OFFSET + ciphertext.byteLength);
  envelope[0] = ROOM_CALL_ENVELOPE_VERSION;
  envelope.set(rawEphemeral, EPHEMERAL_KEY_OFFSET);
  envelope.set(ciphertext, CIPHERTEXT_OFFSET);
  return toBase64Url(envelope);
}

interface OpenInput {
  envelope: string;
  binding: RoomCallBindingType;
  direction: RoomCallDirection;
  /** The recipient's own ephemeral X25519 private key. */
  recipientEncryptionPrivateKey: CryptoKey;
}

async function openRoomCallEnvelope(input: OpenInput): Promise<Uint8Array | null> {
  const binding = RoomCallBinding.parse(input.binding);
  const bytes = fromBase64UrlStrict(input.envelope);
  if (!bytes || bytes.byteLength <= ENVELOPE_OVERHEAD_BYTES + SIGNATURE_BYTES) return null;
  if (bytes[0] !== ROOM_CALL_ENVELOPE_VERSION) return null;

  try {
    const ephemeralPublic = await crypto.subtle.importKey(
      "raw", bytes.slice(EPHEMERAL_KEY_OFFSET, CIPHERTEXT_OFFSET) as BufferSource,
      { name: "X25519" }, false, [],
    );
    const { key, nonce } = await deriveSealKey(
      input.recipientEncryptionPrivateKey, ephemeralPublic, binding, input.direction,
    );
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM", iv: nonce as BufferSource,
        additionalData: canonicalRoomCallAad(binding, input.direction) as BufferSource,
      },
      key,
      bytes.slice(CIPHERTEXT_OFFSET) as BufferSource,
    ));
    return plaintext;
  } catch {
    return null;
  }
}

async function verifyRoomCallSignature(
  senderSigningPublicKey: string, signature: Uint8Array, transcript: Uint8Array,
): Promise<boolean> {
  const raw = fromBase64UrlStrict(senderSigningPublicKey);
  if (!raw) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" }, key, signature as BufferSource, transcript as BufferSource,
    );
  } catch {
    return false;
  }
}

export interface SealRoomCallRequestInput {
  binding: RoomCallBindingType;
  payload: RoomCallRequestPayloadType;
  recipientEncryptionPublicKey: string;
  senderSigningPrivateKey: CryptoKey;
}

export function sealRoomCallRequest(input: SealRoomCallRequestInput): Promise<string> {
  const payload = RoomCallRequestPayload.parse(input.payload);
  return sealRoomCallEnvelope({
    binding: input.binding,
    direction: "request",
    recipientEncryptionPublicKey: input.recipientEncryptionPublicKey,
    senderSigningPrivateKey: input.senderSigningPrivateKey,
    transcript: roomCallRequestTranscript(input.binding, payload),
    plaintextFields: [payload.v, payload.issued_at, payload.expires_at, payload.message],
  });
}

export interface OpenRoomCallRequestInput {
  envelope: string;
  binding: RoomCallBindingType;
  recipientEncryptionPrivateKey: CryptoKey;
  /** The sender's `signing_public_key`, read from the membership snapshot. */
  senderSigningPublicKey: string;
}

/**
 * Returns `null` on any failure — wrong recipient, tampered AAD, a
 * transplanted envelope, a bad signature, an over-long message. Callers get
 * one bit, deliberately: a Room peer is unvouched-for, and distinguishing
 * "wrong key" from "bad signature" in a message back to them is an oracle.
 */
export async function openRoomCallRequest(
  input: OpenRoomCallRequestInput,
): Promise<RoomCallRequestPayloadType | null> {
  const plaintext = await openRoomCallEnvelope({
    envelope: input.envelope, binding: input.binding, direction: "request",
    recipientEncryptionPrivateKey: input.recipientEncryptionPrivateKey,
  });
  if (!plaintext) return null;

  const decoded = decodeCanonicalPlaintext(plaintext.slice(SIGNATURE_BYTES), 4);
  if (!decoded) return null;
  const [v, issuedAt, expiresAt, message] = decoded;
  const parsed = RoomCallRequestPayload.safeParse({
    v, issued_at: issuedAt, expires_at: expiresAt, message,
  });
  if (!parsed.success) return null;

  const ok = await verifyRoomCallSignature(
    input.senderSigningPublicKey,
    plaintext.slice(0, SIGNATURE_BYTES),
    roomCallRequestTranscript(input.binding, parsed.data),
  );
  return ok ? parsed.data : null;
}

export interface SealRoomCallOutcomeInput {
  binding: RoomCallBindingType;
  payload: RoomCallOutcomePayloadType;
  recipientEncryptionPublicKey: string;
  senderSigningPrivateKey: CryptoKey;
}

export function sealRoomCallOutcome(input: SealRoomCallOutcomeInput): Promise<string> {
  const payload = RoomCallOutcomePayload.parse(input.payload);
  const body: CanonicalValue[] = payload.outcome.kind === "reply"
    ? ["reply", payload.outcome.text]
    : ["failure", payload.outcome.code];
  return sealRoomCallEnvelope({
    binding: input.binding,
    direction: "outcome",
    recipientEncryptionPublicKey: input.recipientEncryptionPublicKey,
    senderSigningPrivateKey: input.senderSigningPrivateKey,
    transcript: roomCallOutcomeTranscript(input.binding, payload),
    plaintextFields: [payload.v, payload.issued_at, ...body],
  });
}

export interface OpenRoomCallOutcomeInput {
  envelope: string;
  binding: RoomCallBindingType;
  recipientEncryptionPrivateKey: CryptoKey;
  senderSigningPublicKey: string;
}

export async function openRoomCallOutcome(
  input: OpenRoomCallOutcomeInput,
): Promise<RoomCallOutcomePayloadType | null> {
  const plaintext = await openRoomCallEnvelope({
    envelope: input.envelope, binding: input.binding, direction: "outcome",
    recipientEncryptionPrivateKey: input.recipientEncryptionPrivateKey,
  });
  if (!plaintext) return null;

  const decoded = decodeCanonicalPlaintext(plaintext.slice(SIGNATURE_BYTES), 4);
  if (!decoded) return null;
  const [v, issuedAt, kind, tail] = decoded;
  const outcome = kind === "reply" ? { kind, text: tail } : { kind: "failure", code: tail };
  const parsed = RoomCallOutcomePayload.safeParse({ v, issued_at: issuedAt, outcome });
  if (!parsed.success) return null;

  const ok = await verifyRoomCallSignature(
    input.senderSigningPublicKey,
    plaintext.slice(0, SIGNATURE_BYTES),
    roomCallOutcomeTranscript(input.binding, parsed.data),
  );
  return ok ? parsed.data : null;
}

/**
 * Reverses `canonicalEncode` for the fixed shapes above. It is deliberately
 * strict — an exact field count, no trailing bytes — because this parses
 * plaintext that a peer produced.
 */
function decodeCanonicalPlaintext(bytes: Uint8Array, expected: number): (string | number)[] | null {
  const values: (string | number)[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;

  while (offset < bytes.byteLength) {
    if (values.length === expected) return null;
    const tag = bytes[offset];
    offset += 1;
    if (tag === 2) {
      if (offset + 8 > bytes.byteLength) return null;
      const value = view.getBigInt64(offset, false);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
      values.push(Number(value));
      offset += 8;
    } else if (tag === 1) {
      if (offset + 4 > bytes.byteLength) return null;
      const length = view.getUint32(offset, false);
      offset += 4;
      if (offset + length > bytes.byteLength) return null;
      try {
        values.push(decoder.decode(bytes.slice(offset, offset + length)));
      } catch {
        return null;
      }
      offset += length;
    } else {
      return null;
    }
  }
  return values.length === expected ? values : null;
}
