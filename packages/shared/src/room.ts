import { z } from "zod";

export const ROOM_MIN_PARTICIPANTS = 2 as const;
export const ROOM_MAX_PARTICIPANTS = 6 as const;
export const ROOM_INVITE_TTL_MS = 300_000 as const;
export const ROOM_VERIFICATION_TTL_MS = 60_000 as const;
export const ROOM_ABSOLUTE_TTL_MS = 1_800_000 as const;
export const ROOM_IDLE_TTL_MS = 600_000 as const;
export const ROOM_HEARTBEAT_GRACE_MS = 15_000 as const;
export const ROOM_MAX_PROMPT_BYTES = 4_096 as const;
export const ROOM_MAX_REPLY_BYTES = 16_384 as const;
export const ROOM_AGENT_TIMEOUT_MS = 90_000 as const;
export const ROOM_MAX_CALLS_PER_PARTICIPANT = 5 as const;
export const ROOM_SUBMISSION_COOLDOWN_MS = 3_000 as const;
export const ROOM_MAX_FAILED_JOINS = 3 as const;

const ROOM_MAX_ENCRYPTED_REQUEST_BYTES = ROOM_MAX_PROMPT_BYTES + 1_024;
const ROOM_MAX_ENCRYPTED_OUTCOME_BYTES = ROOM_MAX_REPLY_BYTES + 1_024;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export const RoomId = z.string().regex(/^room_[A-Za-z0-9_-]{22}$/);
export const RoomParticipantId = z.string().regex(/^rp_[A-Za-z0-9_-]{22}$/);
export const RoomInviteId = z.string().regex(/^ri_[A-Za-z0-9_-]{22}$/);
export const RoomCallId = z.string().regex(/^rc_[A-Za-z0-9_-]{22}$/);
export const RoomSecretHash = z.string().regex(/^[0-9a-f]{64}$/);
export const RoomIdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

function decodeCanonicalBase64url(value: string): Uint8Array | undefined {
  if (!BASE64URL_RE.test(value)) return undefined;
  const bytes: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) return undefined;
    accumulator = (accumulator << 6) | index;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && accumulator !== 0) return undefined;
  return Uint8Array.from(bytes);
}

export const RoomPublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(
  (value) => decodeCanonicalBase64url(value)?.byteLength === 32,
  { message: "Room public key must be canonical unpadded base64url for 32 bytes" },
);

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

export const RoomDisplayName = z.string().transform((value) => value.normalize("NFC")).pipe(
  z.string().superRefine((value, ctx) => {
    const codePoints = [...value].length;
    if (codePoints < 1 || codePoints > 24) {
      ctx.addIssue({ code: "custom", message: "Room display name must contain 1-24 Unicode code points" });
    }
    if (value.trim() !== value) {
      ctx.addIssue({ code: "custom", message: "Room display name cannot have surrounding whitespace" });
    }
    if (value.includes("@")) {
      ctx.addIssue({ code: "custom", message: "Room display name cannot contain @" });
    }
    if (UNSAFE_DISPLAY_CHARACTERS.test(value) || hasUnpairedSurrogate(value)) {
      ctx.addIssue({ code: "custom", message: "Room display name contains unsafe characters" });
    }
  }),
);

export const RoomAgentAdapter = z.string().max(80).regex(
  /^(?:claude|codex)@[0-9]+\.[0-9]+\.[0-9]+:(?:darwin|linux|win32)\/(?:arm64|x64)$/,
);

const Timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MembershipEpoch = z.number().int().min(0).max(0xffff_ffff);
const ActiveMembershipEpoch = z.number().int().min(1).max(0xffff_ffff);
const ParticipantCount = z.union([
  z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6),
]);
const Seat = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6),
]);
const InviteSeat = z.union([
  z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6),
]);

export const RoomState = z.enum(["waiting", "verifying", "active", "closed"]);
export const RoomCloseReason = z.enum([
  "host_left", "expired", "idle", "verification_failed",
  "insufficient_participants", "abuse_limit", "relay_error",
]);
export const RoomParticipantState = z.enum([
  "pending", "admitted", "verified", "ready", "paused", "departed",
]);
export const RoomCallState = z.enum([
  "submitted", "accepted", "working", "completed", "failed", "canceled", "expired",
]);

export const RoomRecord = z.object({
  room_id: RoomId,
  state: RoomState,
  moderator_participant_id: RoomParticipantId,
  expected_participants: ParticipantCount,
  membership_epoch: MembershipEpoch,
  created_at: Timestamp,
  invite_deadline: Timestamp,
  verification_deadline: Timestamp.optional(),
  idle_deadline: Timestamp,
  expires_at: Timestamp,
  close_reason: RoomCloseReason.optional(),
}).strict().superRefine((record, ctx) => {
  if (!(record.created_at <= record.invite_deadline && record.invite_deadline <= record.expires_at)) {
    ctx.addIssue({ code: "custom", path: ["invite_deadline"], message: "invite deadline must be within Room lifetime" });
  }
  if (!(record.created_at <= record.idle_deadline && record.idle_deadline <= record.expires_at)) {
    ctx.addIssue({ code: "custom", path: ["idle_deadline"], message: "idle deadline must be within Room lifetime" });
  }
  if (record.expires_at - record.created_at > ROOM_ABSOLUTE_TTL_MS) {
    ctx.addIssue({ code: "custom", path: ["expires_at"], message: "Room lifetime exceeds the absolute TTL" });
  }
  if (record.state === "verifying") {
    if (record.verification_deadline === undefined ||
      record.verification_deadline < record.created_at || record.verification_deadline > record.expires_at) {
      ctx.addIssue({ code: "custom", path: ["verification_deadline"], message: "verifying Room needs a bounded deadline" });
    }
  } else if (record.verification_deadline !== undefined) {
    ctx.addIssue({ code: "custom", path: ["verification_deadline"], message: "verification deadline is only valid while verifying" });
  }
  if ((record.state === "closed") !== (record.close_reason !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["close_reason"], message: "close reason is required exactly for closed Rooms" });
  }
});

export const RoomInviteRecord = z.object({
  invite_id: RoomInviteId,
  room_id: RoomId,
  seat: InviteSeat,
  secret_hash: RoomSecretHash,
  expires_at: Timestamp,
  consumed_at: Timestamp.optional(),
  participant_id: RoomParticipantId.optional(),
}).strict().superRefine((record, ctx) => {
  if ((record.consumed_at !== undefined) !== (record.participant_id !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["consumed_at"], message: "invite consumption fields must appear together" });
  }
  if (record.consumed_at !== undefined && record.consumed_at > record.expires_at) {
    ctx.addIssue({ code: "custom", path: ["consumed_at"], message: "invite cannot be consumed after expiry" });
  }
});

function validParticipantHistory(record: {
  state: z.infer<typeof RoomParticipantState>;
  admitted_at?: number;
  verified_epoch?: number;
}): boolean {
  const admitted = record.admitted_at !== undefined;
  const verified = record.verified_epoch !== undefined;
  if (record.state === "pending") return !admitted && !verified;
  if (record.state === "admitted") return admitted && !verified;
  if (record.state === "verified" || record.state === "ready" || record.state === "paused") {
    return admitted && verified;
  }
  return (!admitted && !verified) || (admitted && !verified) || (admitted && verified);
}

export const RoomParticipantRecord = z.object({
  participant_id: RoomParticipantId,
  room_id: RoomId,
  seat: Seat,
  state: RoomParticipantState,
  display_name: RoomDisplayName,
  credential_hash: RoomSecretHash,
  signing_public_key: RoomPublicKey,
  encryption_public_key: RoomPublicKey,
  agent_adapter: RoomAgentAdapter,
  joined_at: Timestamp,
  admitted_at: Timestamp.optional(),
  verified_epoch: ActiveMembershipEpoch.optional(),
  last_seen_at: Timestamp,
  calls_charged: z.number().int().min(0).max(ROOM_MAX_CALLS_PER_PARTICIPANT),
}).strict().superRefine((record, ctx) => {
  if (record.last_seen_at < record.joined_at) {
    ctx.addIssue({ code: "custom", path: ["last_seen_at"], message: "last seen cannot precede join" });
  }
  if (record.admitted_at !== undefined && record.admitted_at < record.joined_at) {
    ctx.addIssue({ code: "custom", path: ["admitted_at"], message: "admission cannot precede join" });
  }
  if (!validParticipantHistory(record)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "participant timestamps do not match state history" });
  }
});

function encryptedPayload(maxBytes: number) {
  return z.string().regex(BASE64URL_RE).refine((value) => {
    const decoded = decodeCanonicalBase64url(value);
    return decoded !== undefined && decoded.byteLength > 0 && decoded.byteLength <= maxBytes;
  }, { message: `encrypted payload must be canonical base64url of at most ${maxBytes} bytes` });
}

export const RoomCallRecord = z.object({
  call_id: RoomCallId,
  idempotency_key: RoomIdempotencyKey,
  room_id: RoomId,
  membership_epoch: ActiveMembershipEpoch,
  from_participant_id: RoomParticipantId,
  to_participant_id: RoomParticipantId,
  state: RoomCallState,
  request_digest: RoomSecretHash,
  encrypted_request: encryptedPayload(ROOM_MAX_ENCRYPTED_REQUEST_BYTES),
  encrypted_outcome: encryptedPayload(ROOM_MAX_ENCRYPTED_OUTCOME_BYTES).optional(),
  created_at: Timestamp,
  expires_at: Timestamp,
}).strict().superRefine((record, ctx) => {
  if (record.from_participant_id === record.to_participant_id) {
    ctx.addIssue({ code: "custom", path: ["to_participant_id"], message: "Room calls must target another participant" });
  }
  if (record.expires_at <= record.created_at) {
    ctx.addIssue({ code: "custom", path: ["expires_at"], message: "call expiry must follow creation" });
  }
  if (record.state === "completed" && record.encrypted_outcome === undefined) {
    ctx.addIssue({ code: "custom", path: ["encrypted_outcome"], message: "completed call requires an outcome" });
  }
  if (!["completed", "failed"].includes(record.state) && record.encrypted_outcome !== undefined) {
    ctx.addIssue({ code: "custom", path: ["encrypted_outcome"], message: "outcome is invalid before a terminal result" });
  }
});

export const RoomMembershipMember = z.object({
  participant_id: RoomParticipantId,
  display_name: RoomDisplayName,
  signing_public_key: RoomPublicKey,
  encryption_public_key: RoomPublicKey,
}).strict();

const RoomMembershipInput = z.object({
  room_id: RoomId,
  membership_epoch: z.number().int().min(1).max(0xffff_ffff),
  members: z.array(RoomMembershipMember).min(ROOM_MIN_PARTICIPANTS).max(ROOM_MAX_PARTICIPANTS),
}).strict();

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > 0xffff) throw new Error("Room transcript field is too large");
  const result = new Uint8Array(2 + bytes.byteLength);
  new DataView(result.buffer).setUint16(0, bytes.byteLength, false);
  result.set(bytes, 2);
  return result;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function canonicalRoomMembershipTranscript(input: {
  room_id: z.infer<typeof RoomId>;
  membership_epoch: number;
  members: readonly z.input<typeof RoomMembershipMember>[];
}): Uint8Array {
  const parsed = RoomMembershipInput.parse({ ...input, members: [...input.members] });
  const members = [...parsed.members].sort((left, right) =>
    left.participant_id < right.participant_id ? -1 : left.participant_id > right.participant_id ? 1 : 0);

  const participantIds = new Set<string>();
  const displayNames = new Set<string>();
  const signingKeys = new Set<string>();
  const encryptionKeys = new Set<string>();
  for (const member of members) {
    const comparableName = member.display_name.normalize("NFC").toLowerCase();
    if (participantIds.has(member.participant_id)) throw new Error("duplicate Room participant id");
    if (displayNames.has(comparableName)) throw new Error("duplicate Room display name");
    if (signingKeys.has(member.signing_public_key)) throw new Error("duplicate Room signing key");
    if (encryptionKeys.has(member.encryption_public_key)) throw new Error("duplicate Room encryption key");
    participantIds.add(member.participant_id);
    displayNames.add(comparableName);
    signingKeys.add(member.signing_public_key);
    encryptionKeys.add(member.encryption_public_key);
  }

  const encoder = new TextEncoder();
  const epoch = new Uint8Array(4);
  new DataView(epoch.buffer).setUint32(0, parsed.membership_epoch, false);
  const parts: Uint8Array[] = [
    Uint8Array.of(1),
    lengthPrefixed(encoder.encode(parsed.room_id)),
    epoch,
    Uint8Array.of(members.length),
  ];
  for (const member of members) {
    parts.push(
      lengthPrefixed(encoder.encode(member.participant_id)),
      lengthPrefixed(encoder.encode(member.display_name)),
      decodeCanonicalBase64url(member.signing_public_key)!,
      decodeCanonicalBase64url(member.encryption_public_key)!,
    );
  }
  return concatenate(parts);
}

const ROOM_FINGERPRINT_DOMAIN = new TextEncoder().encode("agentcall-room-fingerprint-v1\0");
const ROOM_FINGERPRINT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function roomMembershipFingerprint(input: Parameters<typeof canonicalRoomMembershipTranscript>[0]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    concatenate([ROOM_FINGERPRINT_DOMAIN, canonicalRoomMembershipTranscript(input)]) as BufferSource,
  ));
  let accumulator = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && encoded.length < 12) {
      bitCount -= 5;
      encoded += ROOM_FINGERPRINT_ALPHABET[(accumulator >> bitCount) & 0x1f];
      accumulator &= (1 << bitCount) - 1;
    }
    if (encoded.length === 12) break;
  }
  return `${encoded.slice(0, 3)}-${encoded.slice(3, 6)}-${encoded.slice(6, 9)}-${encoded.slice(9, 12)}`;
}

export type RoomIdType = z.infer<typeof RoomId>;
export type RoomParticipantIdType = z.infer<typeof RoomParticipantId>;
export type RoomInviteIdType = z.infer<typeof RoomInviteId>;
export type RoomCallIdType = z.infer<typeof RoomCallId>;
export type RoomSecretHashType = z.infer<typeof RoomSecretHash>;
export type RoomPublicKeyType = z.infer<typeof RoomPublicKey>;
export type RoomIdempotencyKeyType = z.infer<typeof RoomIdempotencyKey>;
export type RoomDisplayNameType = z.infer<typeof RoomDisplayName>;
export type RoomAgentAdapterType = z.infer<typeof RoomAgentAdapter>;
export type RoomStateType = z.infer<typeof RoomState>;
export type RoomCloseReasonType = z.infer<typeof RoomCloseReason>;
export type RoomParticipantStateType = z.infer<typeof RoomParticipantState>;
export type RoomCallStateType = z.infer<typeof RoomCallState>;
export type RoomRecordType = z.infer<typeof RoomRecord>;
export type RoomInviteRecordType = z.infer<typeof RoomInviteRecord>;
export type RoomParticipantRecordType = z.infer<typeof RoomParticipantRecord>;
export type RoomCallRecordType = z.infer<typeof RoomCallRecord>;
export type RoomMembershipMemberType = z.infer<typeof RoomMembershipMember>;
