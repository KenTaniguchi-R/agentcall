import { describe, expect, it } from "vitest";
import {
  ROOM_ABSOLUTE_TTL_MS,
  ROOM_AGENT_TIMEOUT_MS,
  ROOM_HEARTBEAT_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  ROOM_INVITE_TTL_MS,
  ROOM_MAX_CALLS_PER_PARTICIPANT,
  ROOM_MAX_FAILED_JOINS,
  ROOM_MAX_PARTICIPANTS,
  ROOM_MAX_PROMPT_BYTES,
  ROOM_MAX_REPLY_BYTES,
  ROOM_MIN_PARTICIPANTS,
  ROOM_SUBMISSION_COOLDOWN_MS,
  ROOM_VERIFICATION_TTL_MS,
  RoomAgentAdapter,
  RoomCallId,
  RoomCallRecord,
  RoomDisplayName,
  RoomId,
  RoomIdempotencyKey,
  RoomInviteId,
  RoomInviteRecord,
  RoomParticipantId,
  RoomParticipantRecord,
  RoomPublicKey,
  RoomRecord,
  RoomSecretHash,
  canonicalRoomMembershipTranscript,
  roomMembershipFingerprint,
} from "../src/room.js";

const ROOM_ID = `room_${"A".repeat(22)}`;
const PARTICIPANT_1 = `rp_${"A".repeat(22)}`;
const PARTICIPANT_2 = `rp_${"B".repeat(22)}`;
const PARTICIPANT_3 = `rp_${"C".repeat(22)}`;
const INVITE_ID = `ri_${"A".repeat(22)}`;
const CALL_ID = `rc_${"A".repeat(22)}`;
const ZERO_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ONE_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const TWO_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const THREE_KEY = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
const FOUR_KEY = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ";
const HASH = "ab".repeat(32);
const NOW = 1_800_000_000_000;

const room = {
  room_id: ROOM_ID,
  state: "waiting" as const,
  moderator_participant_id: PARTICIPANT_1,
  expected_participants: 3 as const,
  membership_epoch: 0,
  created_at: NOW,
  invite_deadline: NOW + ROOM_INVITE_TTL_MS,
  idle_deadline: NOW + ROOM_IDLE_TTL_MS,
  expires_at: NOW + ROOM_ABSOLUTE_TTL_MS,
};

const invite = {
  invite_id: INVITE_ID,
  room_id: ROOM_ID,
  secret_hash: HASH,
  expires_at: NOW + ROOM_INVITE_TTL_MS,
  seats_remaining: 1 as const,
};

const participant = {
  participant_id: PARTICIPANT_1,
  room_id: ROOM_ID,
  state: "ready" as const,
  display_name: "ken",
  credential_hash: HASH,
  signing_public_key: ZERO_KEY,
  encryption_public_key: ONE_KEY,
  agent_adapter: "claude:darwin/arm64",
  joined_at: NOW,
  admitted_at: NOW + 1,
  verified_epoch: 1,
  last_seen_at: NOW + 2,
  calls_charged: 0,
};

const call = {
  call_id: CALL_ID,
  idempotency_key: "abcdefghijklmnop",
  room_id: ROOM_ID,
  membership_epoch: 1,
  from_participant_id: PARTICIPANT_1,
  to_participant_id: PARTICIPANT_2,
  state: "submitted" as const,
  request_digest: HASH,
  encrypted_request: ZERO_KEY,
  created_at: NOW,
  expires_at: NOW + ROOM_AGENT_TIMEOUT_MS,
};

const members = [
  {
    participant_id: PARTICIPANT_1,
    display_name: "ken",
    signing_public_key: ZERO_KEY,
    encryption_public_key: ONE_KEY,
  },
  {
    participant_id: PARTICIPANT_2,
    display_name: "sota",
    signing_public_key: TWO_KEY,
    encryption_public_key: THREE_KEY,
  },
];

describe("Room limits", () => {
  it("exports the approved participant limits", () => {
    expect([ROOM_MIN_PARTICIPANTS, ROOM_MAX_PARTICIPANTS]).toEqual([2, 6]);
  });

  it("exports the approved lifecycle deadlines", () => {
    expect([
      ROOM_INVITE_TTL_MS, ROOM_VERIFICATION_TTL_MS, ROOM_ABSOLUTE_TTL_MS,
      ROOM_IDLE_TTL_MS, ROOM_HEARTBEAT_GRACE_MS,
    ]).toEqual([300_000, 60_000, 1_800_000, 600_000, 15_000]);
  });

  it("exports the approved call bounds", () => {
    expect([
      ROOM_MAX_PROMPT_BYTES, ROOM_MAX_REPLY_BYTES, ROOM_AGENT_TIMEOUT_MS,
      ROOM_MAX_CALLS_PER_PARTICIPANT, ROOM_SUBMISSION_COOLDOWN_MS, ROOM_MAX_FAILED_JOINS,
    ]).toEqual([4_096, 16_384, 90_000, 5, 3_000, 3]);
  });
});

describe("Room primitive schemas", () => {
  it.each([
    ["room id", RoomId, ROOM_ID],
    ["participant id", RoomParticipantId, PARTICIPANT_1],
    ["invite id", RoomInviteId, INVITE_ID],
    ["call id", RoomCallId, CALL_ID],
  ])("accepts a valid %s", (_name, schema, value) => {
    expect(schema.parse(value)).toBe(value);
  });

  it.each([
    ["wrong room prefix", RoomId, `rp_${"A".repeat(22)}`],
    ["short participant id", RoomParticipantId, `rp_${"A".repeat(21)}`],
    ["padded invite id", RoomInviteId, `ri_${"A".repeat(21)}=`],
    ["uppercase secret hash", RoomSecretHash, "AB".repeat(32)],
    ["short idempotency key", RoomIdempotencyKey, "a".repeat(15)],
  ])("rejects %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("accepts only canonical 32-byte unpadded public keys", () => {
    expect(RoomPublicKey.safeParse(ZERO_KEY).success).toBe(true);
    expect(RoomPublicKey.safeParse(`${ZERO_KEY.slice(0, -1)}B`).success).toBe(false);
    expect(RoomPublicKey.safeParse(`${ZERO_KEY}=`).success).toBe(false);
  });

  it("normalizes display names to NFC", () => {
    expect(RoomDisplayName.parse("s\u006f\u0301ta")).toBe("sóta");
  });

  it.each(["", " ", " ken", "ken ", "@ken", "k@en", "a\u0000b", "a\u202eb"])(
    "rejects unsafe display name %j",
    (value) => expect(RoomDisplayName.safeParse(value).success).toBe(false),
  );

  it("counts display-name code points instead of UTF-16 units", () => {
    expect(RoomDisplayName.safeParse("😀".repeat(24)).success).toBe(true);
    expect(RoomDisplayName.safeParse("😀".repeat(25)).success).toBe(false);
  });

  it("rejects unpaired UTF-16 surrogates in display names", () => {
    expect(RoomDisplayName.safeParse("ken\ud800").success).toBe(false);
    expect(RoomDisplayName.safeParse("ken\udc00").success).toBe(false);
  });

  it.each([
    "claude:darwin/arm64",
    "codex:linux/x64",
    "claude:win32/x64",
  ])("accepts supported adapter tuple syntax %s", (value) => {
    expect(RoomAgentAdapter.parse(value)).toBe(value);
  });

  it.each(["gemini@1.0.0:darwin/arm64", "claude@latest:darwin/arm64", "claude@1.0.0:macos/arm64"])(
    "rejects unsupported adapter tuple syntax %s",
    (value) => expect(RoomAgentAdapter.safeParse(value).success).toBe(false),
  );
});

describe("RoomRecord", () => {
  it("round-trips a waiting Room", () => {
    expect(RoomRecord.parse(room)).toEqual(room);
  });

  it.each([2, 3, 6] as const)("accepts the bounded %i-participant scenario", (expected_participants) => {
    expect(RoomRecord.parse({ ...room, expected_participants }).expected_participants).toBe(expected_participants);
  });

  it("accepts verifying only with a bounded verification deadline", () => {
    const verifying = {
      ...room, state: "verifying", membership_epoch: 1,
      verification_deadline: NOW + ROOM_VERIFICATION_TTL_MS,
    };
    expect(RoomRecord.safeParse(verifying).success).toBe(true);
  });

  it("requires close_reason exactly for closed Rooms", () => {
    expect(RoomRecord.safeParse({ ...room, state: "closed" }).success).toBe(false);
    expect(RoomRecord.safeParse({ ...room, close_reason: "expired" }).success).toBe(false);
    expect(RoomRecord.safeParse({ ...room, state: "closed", close_reason: "expired" }).success).toBe(true);
  });

  it.each([
    ["invite before create", { invite_deadline: NOW - 1 }],
    ["idle after expiry", { idle_deadline: room.expires_at + 1 }],
    ["absolute TTL exceeded", { expires_at: room.expires_at + 1 }],
    ["verification deadline on active", { state: "active", membership_epoch: 1, verification_deadline: NOW + 1 }],
    ["unknown field", { org: "acme" }],
    ["unsafe timestamp", { created_at: Number.MAX_SAFE_INTEGER + 1 }],
    ["membership epoch above u32", { membership_epoch: 0x1_0000_0000 }],
  ])("rejects %s", (_name, change) => {
    expect(RoomRecord.safeParse({ ...room, ...change }).success).toBe(false);
  });
});

describe("RoomInviteRecord", () => {
  it("round-trips an unused invitation", () => {
    expect(RoomInviteRecord.parse(invite)).toEqual(invite);
  });

  it("accepts an invite with no seats remaining", () => {
    expect(RoomInviteRecord.safeParse({ ...invite, seats_remaining: 0 }).success).toBe(true);
  });

  it.each([
    ["negative seats remaining", { seats_remaining: -1 }],
    ["seats remaining above the max", { seats_remaining: ROOM_MAX_PARTICIPANTS }],
    ["a per-seat invite from the retired single-use shape", { seat: 2 }],
    ["raw secret", { secret: "do-not-store" }],
  ])("rejects %s", (_name, change) => {
    expect(RoomInviteRecord.safeParse({ ...invite, ...change }).success).toBe(false);
  });
});

describe("RoomParticipantRecord", () => {
  it("round-trips a ready participant", () => {
    expect(RoomParticipantRecord.parse(participant)).toEqual(participant);
  });

  it.each([
    ["pending", { state: "pending", admitted_at: undefined, verified_epoch: undefined }],
    ["admitted", { state: "admitted", verified_epoch: undefined }],
    ["verified", { state: "verified" }],
    ["paused", { state: "paused" }],
    ["departed before admission", { state: "departed", admitted_at: undefined, verified_epoch: undefined }],
    ["departed after admission", { state: "departed", verified_epoch: undefined }],
  ])("accepts valid %s history", (_name, change) => {
    expect(RoomParticipantRecord.safeParse({ ...participant, ...change }).success).toBe(true);
  });

  it.each([
    ["pending with admission", { state: "pending", verified_epoch: undefined }],
    ["admitted with verification", { state: "admitted" }],
    ["ready without verification", { state: "ready", verified_epoch: undefined }],
    ["last seen before join", { last_seen_at: NOW - 1 }],
    ["too many calls", { calls_charged: 6 }],
    ["credential value", { credential: "raw" }],
    ["a seat from the retired per-seat invite shape", { seat: 1 }],
  ])("rejects %s", (_name, change) => {
    expect(RoomParticipantRecord.safeParse({ ...participant, ...change }).success).toBe(false);
  });
});

describe("RoomCallRecord", () => {
  it("round-trips a submitted call", () => {
    expect(RoomCallRecord.parse(call)).toEqual(call);
  });

  it("requires an outcome for completed calls", () => {
    expect(RoomCallRecord.safeParse({ ...call, state: "completed" }).success).toBe(false);
    expect(RoomCallRecord.safeParse({ ...call, state: "completed", encrypted_outcome: ONE_KEY }).success).toBe(true);
  });

  it("permits an encrypted failure outcome", () => {
    expect(RoomCallRecord.safeParse({ ...call, state: "failed", encrypted_outcome: ONE_KEY }).success).toBe(true);
  });

  it.each(["submitted", "accepted", "working", "canceled", "expired"])(
    "rejects an outcome while %s",
    (state) => expect(RoomCallRecord.safeParse({ ...call, state, encrypted_outcome: ONE_KEY }).success).toBe(false),
  );

  it.each([
    ["self call", { to_participant_id: PARTICIPANT_1 }],
    ["zero lifetime", { expires_at: NOW }],
    ["epoch zero", { membership_epoch: 0 }],
    ["raw prompt", { prompt: "hello" }],
  ])("rejects %s", (_name, change) => {
    expect(RoomCallRecord.safeParse({ ...call, ...change }).success).toBe(false);
  });

  it("rejects ciphertext above the decoded byte limit", () => {
    expect(RoomCallRecord.safeParse({ ...call, encrypted_request: "A".repeat(6_828) }).success).toBe(false);
  });

  it("rejects non-canonical ciphertext padding bits", () => {
    expect(RoomCallRecord.safeParse({ ...call, encrypted_request: "B" }).success).toBe(false);
  });

  // No byte sequence encodes to a base64url string of length 1 mod 4: four
  // characters carry three bytes, so the valid remainders are 0, 2, and 3.
  // Ciphertext is variable-length and its only length check is the byte
  // ceiling, so an impossible spelling has to be rejected by the decoder.
  it.each(["A".repeat(5), "A".repeat(9), "A".repeat(13)])(
    "rejects ciphertext of impossible base64url length (%s)",
    (encrypted_request) => {
      expect(RoomCallRecord.safeParse({ ...call, encrypted_request }).success).toBe(false);
    },
  );
});

describe("Room membership transcript", () => {
  const input = { room_id: ROOM_ID, membership_epoch: 1, members };

  it("is invariant to member input order", () => {
    const forward = canonicalRoomMembershipTranscript(input);
    const reverse = canonicalRoomMembershipTranscript({ ...input, members: [...members].reverse() });
    expect([...reverse]).toEqual([...forward]);
  });

  it("starts with the exact version, room length, room bytes, epoch, and count", () => {
    const transcript = canonicalRoomMembershipTranscript(input);
    const roomBytes = new TextEncoder().encode(ROOM_ID);
    expect([...transcript.slice(0, 3)]).toEqual([1, 0, roomBytes.length]);
    expect(new TextDecoder().decode(transcript.slice(3, 3 + roomBytes.length))).toBe(ROOM_ID);
    expect([...transcript.slice(3 + roomBytes.length, 8 + roomBytes.length)]).toEqual([0, 0, 0, 1, 2]);
  });

  it.each([
    ["too few members", [members[0]]],
    ["too many members", [...members, ...members, ...members, members[0]]],
    ["duplicate participant", [members[0], { ...members[0], display_name: "other", signing_public_key: TWO_KEY }]],
    ["normalized duplicate name", [members[0], { ...members[1], display_name: "KEN" }]],
    ["duplicate signing key", [members[0], { ...members[1], signing_public_key: ZERO_KEY }]],
    ["duplicate encryption key", [members[0], { ...members[1], encryption_public_key: ONE_KEY }]],
  ])("rejects %s", (_name, candidate) => {
    expect(() => canonicalRoomMembershipTranscript({ ...input, members: candidate })).toThrow();
  });

  it.each([
    ["room id", { room_id: `room_${"Z".repeat(22)}` }],
    ["epoch", { membership_epoch: 2 }],
    ["participant id", { members: [{ ...members[0], participant_id: PARTICIPANT_3 }, members[1]] }],
    ["display name", { members: [{ ...members[0], display_name: "maya" }, members[1]] }],
    ["signing key", { members: [{ ...members[0], signing_public_key: THREE_KEY }, members[1]] }],
    ["encryption key", { members: [{ ...members[0], encryption_public_key: FOUR_KEY }, members[1]] }],
  ])("changes when %s changes", (_name, change) => {
    expect([...canonicalRoomMembershipTranscript({ ...input, ...change })])
      .not.toEqual([...canonicalRoomMembershipTranscript(input)]);
  });
});

describe("Room membership fingerprint", () => {
  const input = { room_id: ROOM_ID, membership_epoch: 1, members };
  const vectorTwo = {
    room_id: `room_${"Z".repeat(22)}`,
    membership_epoch: 7,
    members: [
      { ...members[0], display_name: "maya" },
      { ...members[1], participant_id: PARTICIPANT_3, display_name: "dev" },
    ],
  };

  const hex = (bytes: Uint8Array) => [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

  async function digestPrefix(value: typeof input): Promise<string> {
    const domain = new TextEncoder().encode("agentcall-room-fingerprint-v1\0");
    const transcript = canonicalRoomMembershipTranscript(value);
    const bytes = new Uint8Array(domain.byteLength + transcript.byteLength);
    bytes.set(domain);
    bytes.set(transcript, domain.byteLength);
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 8));
  }

  it("formats exactly 60 bits as four three-character groups", async () => {
    expect(await roomMembershipFingerprint(input)).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}(?:-[0-9A-HJKMNP-TV-Z]{3}){3}$/);
  });

  it("is stable across member permutations", async () => {
    expect(await roomMembershipFingerprint(input)).toBe(await roomMembershipFingerprint({
      ...input, members: [...members].reverse(),
    }));
  });

  it("matches the literal v1 compatibility vector", async () => {
    expect(hex(canonicalRoomMembershipTranscript(input))).toBe(
      "01001b726f6f6d5f414141414141414141414141414141414141414141410000000102" +
      "001972705f4141414141414141414141414141414141414141414100036b656e" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0101010101010101010101010101010101010101010101010101010101010101" +
      "001972705f424242424242424242424242424242424242424242420004736f7461" +
      "0202020202020202020202020202020202020202020202020202020202020202" +
      "0303030303030303030303030303030303030303030303030303030303030303",
    );
    expect(await digestPrefix(input)).toBe("faa9440db9ffd6b0");
    expect(await roomMembershipFingerprint(input)).toBe("ZAM-M83-DSZ-ZBB");
  });

  it("matches a second literal v1 compatibility vector", async () => {
    expect(hex(canonicalRoomMembershipTranscript(vectorTwo))).toBe(
      "01001b726f6f6d5f5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0000000702" +
      "001972705f4141414141414141414141414141414141414141414100046d617961" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0101010101010101010101010101010101010101010101010101010101010101" +
      "001972705f434343434343434343434343434343434343434343430003646576" +
      "0202020202020202020202020202020202020202020202020202020202020202" +
      "0303030303030303030303030303030303030303030303030303030303030303",
    );
    expect(await digestPrefix(vectorTwo)).toBe("13333821b5a8a0d6");
    expect(await roomMembershipFingerprint(vectorTwo)).toBe("2CS-KG8-DNN-2GD");
  });
});
