import { describe, expect, it, vi } from "vitest";
import { randomBase64Url, roomMembershipFingerprint } from "@benree/agentcall-shared";
import { runRoomVerification } from "../src/room-verification.js";
import type { RoomPollOptions } from "../src/room-poll.js";

const ROOM_ID = `room_${randomBase64Url(16)}`;
const HOST_ID = `rp_${randomBase64Url(16)}`;
const GUEST_ID = `rp_${randomBase64Url(16)}`;
const HOST_KEYS = { signing: randomBase64Url(32), encryption: randomBase64Url(32) };
const GUEST_KEYS = { signing: randomBase64Url(32), encryption: randomBase64Url(32) };

function member(id: string, name: string, keys: { signing: string; encryption: string }) {
  return {
    participant_id: id, display_name: name, state: "verified",
    signing_public_key: keys.signing, encryption_public_key: keys.encryption,
  } as never;
}

const MEMBERS = [member(HOST_ID, "ken", HOST_KEYS), member(GUEST_ID, "sota", GUEST_KEYS)];

function verifyingSnapshot(epoch: number) {
  return {
    room: {
      room_id: ROOM_ID, state: "verifying", membership_epoch: epoch,
      verification_deadline: Date.now() + 60_000,
    },
    participants: MEMBERS,
  } as never;
}

function activeSnapshot(epoch: number) {
  return { room: { room_id: ROOM_ID, state: "active", membership_epoch: epoch }, participants: MEMBERS } as never;
}

function closedSnapshot(reason: string) {
  return { room: { room_id: ROOM_ID, state: "closed", close_reason: reason }, participants: [] } as never;
}

function fakePoll() {
  let captured: RoomPollOptions | undefined;
  const stop = vi.fn();
  const poll = (options: RoomPollOptions) => {
    captured = options;
    return { stop };
  };
  return { poll, deliver: (snapshot: never) => captured!.onSnapshot(snapshot), stop };
}

function start(overrides: Partial<Parameters<typeof runRoomVerification>[0]> = {}) {
  const { poll, deliver, stop } = fakePoll();
  const mutate = vi.fn().mockResolvedValue(undefined);
  const result = runRoomVerification({
    relay: "https://relay.test", credential: "acrp.x", ownParticipantId: HOST_ID,
    poll, mutate, ...overrides,
  });
  return { result, deliver, mutate, stop };
}

describe("runRoomVerification", () => {
  // The point of #369: this awaits the verifying snapshot directly. Under the
  // old blocking prompt that deadlocked on an answer nobody had typed.
  it("confirms without waiting for a human", async () => {
    const { result, deliver, mutate } = start();

    await deliver(verifyingSnapshot(1));
    expect(mutate).toHaveBeenCalledWith("https://relay.test", "acrp.x", "confirm");

    await deliver(activeSnapshot(2));
    expect(await result).toMatchObject({ outcome: "active" });
  });

  // Every path that used to close the whole Room for everyone went through a
  // client-sent "reject". Nothing sends one now.
  it("never rejects, so one slow participant cannot close the Room", async () => {
    const { result, deliver, mutate } = start();
    await deliver(verifyingSnapshot(1));
    await deliver(verifyingSnapshot(2));
    expect(mutate.mock.calls.every(([, , action]) => action === "confirm")).toBe(true);
    await deliver(activeSnapshot(3));
    await result;
  });

  it("returns the fingerprint everyone else is looking at", async () => {
    const { result, deliver } = start();
    await deliver(verifyingSnapshot(1));
    await deliver(activeSnapshot(2));

    const expected = await roomMembershipFingerprint({
      room_id: ROOM_ID,
      membership_epoch: 1,
      members: [
        {
          participant_id: HOST_ID, display_name: "ken",
          signing_public_key: HOST_KEYS.signing, encryption_public_key: HOST_KEYS.encryption,
        },
        {
          participant_id: GUEST_ID, display_name: "sota",
          signing_public_key: GUEST_KEYS.signing, encryption_public_key: GUEST_KEYS.encryption,
        },
      ],
    });
    expect(await result).toEqual({ outcome: "active", snapshot: activeSnapshot(2), fingerprint: expected });
  });

  it("does not confirm twice for the same membership_epoch", async () => {
    const { result, deliver, mutate } = start();
    await deliver(verifyingSnapshot(1));
    await deliver(verifyingSnapshot(1));
    await deliver(verifyingSnapshot(1));
    expect(mutate).toHaveBeenCalledTimes(1);
    await deliver(activeSnapshot(2));
    await result;
  });

  // The relay 409s a confirm from a participant it has already marked verified,
  // and a transient network failure must not take the Room down with it.
  it("survives a confirm the relay refuses", async () => {
    const mutate = vi.fn().mockRejectedValue(new Error("409"));
    const { result, deliver } = start({ mutate });
    await expect(deliver(verifyingSnapshot(1))).resolves.toBeUndefined();
    await deliver(activeSnapshot(2));
    expect(await result).toMatchObject({ outcome: "active" });
  });

  it("resolves closed immediately if the room is already closed", async () => {
    const { result, deliver } = start();
    await deliver(closedSnapshot("idle"));
    expect(await result).toEqual({ outcome: "closed", reason: "idle" });
  });

  it("reports a Room that closed during verification rather than hanging", async () => {
    const { result, deliver } = start();
    await deliver(verifyingSnapshot(1));
    await deliver(closedSnapshot("host_left"));
    expect(await result).toEqual({ outcome: "closed", reason: "host_left" });
  });
});
