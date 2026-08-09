import { describe, expect, it } from "vitest";
import {
  RoomCapability, RoomCreateRequest, RoomCreateResponse, RoomJoinRequest,
  RoomJoinResponse, RoomMutationRequest, RoomMutationResponse,
} from "../src/room.js";

const key = "A".repeat(43);
const secret = "B".repeat(43);
const room = `room_${"C".repeat(22)}`;
const participant = `rp_${"D".repeat(22)}`;
const invite = `ri_${"E".repeat(22)}`;

describe("Room HTTP protocol schemas", () => {
  it("accepts bounded create inputs and rejects body-selected identity", () => {
    const input = {
      expected_participants: 6,
      display_name: "Host",
      signing_public_key: key,
      encryption_public_key: key.replace(/A$/, "Q"),
      agent_adapter: "claude:darwin/arm64",
    };
    expect(RoomCreateRequest.safeParse(input).success).toBe(true);
    expect(RoomCreateRequest.safeParse({ ...input, room_id: room }).success).toBe(false);
    expect(RoomCreateRequest.safeParse({ ...input, expected_participants: 7 }).success).toBe(false);
  });

  it("requires an invite capability and an independent 256-bit participant secret", () => {
    const input = {
      invite: `acri.${room}.${invite}.${secret}`,
      participant_secret: secret.replace(/B$/, "Q"),
      display_name: "Guest",
      signing_public_key: key,
      encryption_public_key: key.replace(/A$/, "Q"),
      agent_adapter: "claude:darwin/arm64",
      signing_proof: "A".repeat(86),
    };
    expect(RoomJoinRequest.safeParse(input).success).toBe(true);
    expect(RoomJoinRequest.safeParse({ ...input, participant_secret: "short" }).success).toBe(false);
    expect(RoomJoinRequest.safeParse({ ...input, participant_id: participant }).success).toBe(false);
  });

  it("makes Room credentials structurally disjoint from durable bearer tokens", () => {
    expect(RoomCapability.safeParse(`acrp.${room}.${participant}.${secret}`).success).toBe(true);
    expect(RoomCapability.safeParse(secret).success).toBe(false);
    expect(RoomCapability.safeParse(`acri.${room}.${invite}.${secret}`).success).toBe(false);
  });

  it("only permits an optional target participant in mutation bodies", () => {
    expect(RoomMutationRequest.safeParse({ participant_id: participant }).success).toBe(true);
    expect(RoomMutationRequest.safeParse({}).success).toBe(true);
    expect(RoomMutationRequest.safeParse({ room_id: room }).success).toBe(false);
  });

  it("defines strict public Room response shapes without hashes", () => {
    const participantRecord = {
      participant_id: participant,
      room_id: room,
      state: "admitted",
      display_name: "Host",
      signing_public_key: key,
      encryption_public_key: key.replace(/A$/, "Q"),
      agent_adapter: "claude:darwin/arm64",
      joined_at: 1,
      admitted_at: 1,
      last_seen_at: 1,
      calls_charged: 0,
    };
    const roomRecord = {
      room_id: room,
      state: "waiting",
      moderator_participant_id: participant,
      expected_participants: 2,
      membership_epoch: 0,
      created_at: 1,
      invite_deadline: 2,
      idle_deadline: 3,
      expires_at: 4,
    };
    const snapshot = { room: roomRecord, participants: [participantRecord], participant: participantRecord };
    expect(RoomMutationResponse.safeParse(snapshot).success).toBe(true);
    expect(RoomMutationResponse.safeParse({
      ...snapshot, participants: [{ ...participantRecord, credential_hash: "a".repeat(64) }],
    }).success).toBe(false);
    expect(RoomCreateResponse.safeParse({
      ...snapshot,
      credential: `acrp.${room}.${participant}.${secret}`,
      invite: { invite: `acri.${room}.${invite}.${secret}`, expires_at: 2, seats_remaining: 1 },
    }).success)
      .toBe(true);
    expect(RoomCreateResponse.safeParse({
      ...snapshot,
      credential: `acrp.${room}.${participant}.${secret}`,
      invites: [{ seat: 2, invite: `acri.${room}.${invite}.${secret}`, expires_at: 2 }],
    }).success)
      .toBe(false);
    expect(RoomJoinResponse.safeParse({ ...snapshot, credential: `acrp.${room}.${participant}.${secret}` }).success).toBe(true);
  });
});
