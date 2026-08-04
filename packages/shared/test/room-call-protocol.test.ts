import { describe, expect, it } from "vitest";
import {
  RoomCallAccepted, RoomCallCancel, RoomCallCanceled, RoomCallOutcome,
  RoomCallStarted, RoomCallSubmit, RoomIncomingCall, RoomRelayCallError,
  RoomRelayCallResult, RoomRelayCallStatus, RoomSocketClientFrame, RoomSocketRelayFrame,
} from "../src/room.js";

const callId = `rc_${"A".repeat(22)}`;
const participant = `rp_${"B".repeat(22)}`;
const other = `rp_${"C".repeat(22)}`;
const room = `room_${"D".repeat(22)}`;
const digest = "e".repeat(64);

describe("Room targeted-call frames", () => {
  it("accepts a bounded submit without body-selected sender, Room, or epoch", () => {
    const frame = {
      type: "room_call_submit",
      call_id: callId,
      idempotency_key: "i".repeat(16),
      to_participant_id: other,
      request_digest: digest,
      encrypted_request: "QQ",
    };
    expect(RoomCallSubmit.safeParse(frame).success).toBe(true);
    expect(RoomCallSubmit.safeParse({ ...frame, from_participant_id: participant }).success).toBe(false);
    expect(RoomCallSubmit.safeParse({ ...frame, room_id: room }).success).toBe(false);
    expect(RoomCallSubmit.safeParse({ ...frame, membership_epoch: 1 }).success).toBe(false);
    expect(RoomCallSubmit.safeParse({ ...frame, to_participant_id: "*" }).success).toBe(false);
  });

  it("defines recipient lifecycle and cancellation frames", () => {
    expect(RoomCallAccepted.safeParse({ type: "room_call_accepted", call_id: callId }).success).toBe(true);
    expect(RoomCallStarted.safeParse({ type: "room_call_started", call_id: callId }).success).toBe(true);
    expect(RoomCallOutcome.safeParse({
      type: "room_call_outcome", call_id: callId, terminal: "completed", encrypted_outcome: "Qg",
    }).success).toBe(true);
    expect(RoomCallOutcome.safeParse({ type: "room_call_outcome", call_id: callId, terminal: "completed" }).success)
      .toBe(false);
    expect(RoomCallCancel.safeParse({ type: "room_call_cancel", call_id: callId }).success).toBe(true);
    expect(RoomCallCanceled.safeParse({ type: "room_call_canceled", call_id: callId }).success).toBe(true);
  });

  it("defines relay-attested single-recipient delivery", () => {
    const delivery = {
      type: "room_incoming_call",
      room_id: room,
      membership_epoch: 1,
      from_participant_id: participant,
      to_participant_id: other,
      call_id: callId,
      request_digest: digest,
      encrypted_request: "QQ",
      expires_at: 100,
    };
    expect(RoomIncomingCall.safeParse(delivery).success).toBe(true);
    expect(RoomIncomingCall.safeParse({ ...delivery, to_participant_id: participant }).success).toBe(false);
  });

  it("defines status, terminal result, and bounded operational errors", () => {
    expect(RoomRelayCallStatus.safeParse({ type: "room_call_status", call_id: callId, state: "working" }).success)
      .toBe(true);
    expect(RoomRelayCallResult.safeParse({
      type: "room_call_result", call_id: callId, terminal: "failed", encrypted_outcome: "Qw",
    }).success).toBe(true);
    expect(RoomRelayCallResult.safeParse({
      type: "room_call_result", call_id: callId, terminal: "completed",
    }).success).toBe(false);
    expect(RoomRelayCallResult.safeParse({
      type: "room_call_result", call_id: callId, terminal: "completed", replayed: true,
    }).success).toBe(true);
    expect(RoomRelayCallError.safeParse({ type: "room_call_error", call_id: callId, code: "busy" }).success)
      .toBe(true);
    expect(RoomRelayCallError.safeParse({ type: "room_call_error", call_id: callId, code: "arbitrary" }).success)
      .toBe(false);
  });

  it("keeps client and relay directions disjoint", () => {
    expect(RoomSocketClientFrame.safeParse({ type: "room_call_accepted", call_id: callId }).success).toBe(true);
    expect(RoomSocketRelayFrame.safeParse({ type: "room_call_accepted", call_id: callId }).success).toBe(false);
    expect(RoomSocketRelayFrame.safeParse({ type: "room_call_error", call_id: callId, code: "paused" }).success)
      .toBe(true);
    expect(RoomSocketClientFrame.safeParse({ type: "room_call_error", call_id: callId, code: "paused" }).success)
      .toBe(false);
  });
});
