import { describe, expect, it, vi } from "vitest";
import { randomBase64Url } from "@benree/agentcall-shared";
import { runRoomVerification } from "../src/room-verification.js";
import type { RoomPollOptions } from "../src/room-poll.js";
import type { RoomLineListener } from "../src/tty.js";

const ROOM_ID = `room_${randomBase64Url(16)}`;
const HOST_ID = `rp_${randomBase64Url(16)}`;
const GUEST_ID = `rp_${randomBase64Url(16)}`;

function member(id: string, name: string) {
  return {
    participant_id: id, display_name: name, state: "verified",
    signing_public_key: randomBase64Url(32), encryption_public_key: randomBase64Url(32),
  } as never;
}

function verifyingSnapshot(epoch: number, deadlineMs: number) {
  return {
    room: {
      room_id: ROOM_ID, state: "verifying", membership_epoch: epoch,
      verification_deadline: Date.now() + deadlineMs,
    },
    participants: [member(HOST_ID, "ken"), member(GUEST_ID, "sota")],
  } as never;
}

function activeSnapshot(epoch: number) {
  return { room: { room_id: ROOM_ID, state: "active", membership_epoch: epoch }, participants: [] } as never;
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

function fakeListener() {
  let handler: ((line: string) => void) | undefined;
  const printed: string[] = [];
  const close = vi.fn();
  const factory = (): RoomLineListener => ({
    onLine: (h) => { handler = h; },
    print: (t) => printed.push(t),
    close,
  });
  return { factory, emit: (line: string) => handler?.(line), printed, close };
}

describe("runRoomVerification", () => {
  it("confirms on 'y' and resolves active once the poll reports it", async () => {
    const { poll, deliver } = fakePoll();
    const mutate = vi.fn().mockResolvedValue(undefined);
    const listener = fakeListener();
    const resultPromise = runRoomVerification({
      relay: "https://relay.test", credential: "acrp.x", ownParticipantId: "rp_host",
      poll, mutate, createListener: listener.factory,
    });

    // onSnapshot for a "verifying" snapshot doesn't resolve until the prompt
    // is answered, so this must not be awaited yet -- awaiting it here would
    // deadlock on an answer nobody has given.
    const verifying = deliver(verifyingSnapshot(1, 60_000));
    await vi.waitFor(() => expect(listener.printed.join("")).toContain("Compare this code with everyone"));
    listener.emit("y");
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledWith("https://relay.test", "acrp.x", "confirm"));
    await verifying;
    expect(listener.close).toHaveBeenCalled();

    await deliver(activeSnapshot(2));
    const result = await resultPromise;
    expect(result).toEqual({ outcome: "active", snapshot: activeSnapshot(2) });
  });

  it("rejects on anything other than 'y'", async () => {
    const { poll, deliver } = fakePoll();
    const mutate = vi.fn().mockResolvedValue(undefined);
    const listener = fakeListener();
    const resultPromise = runRoomVerification({
      relay: "https://relay.test", credential: "acrp.x", ownParticipantId: "rp_host",
      poll, mutate, createListener: listener.factory,
    });
    const verifying = deliver(verifyingSnapshot(1, 60_000));
    await vi.waitFor(() => expect(listener.printed.join("")).toContain("Compare this code with everyone"));
    listener.emit("n");
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledWith("https://relay.test", "acrp.x", "reject"));
    await verifying;
    await deliver(closedSnapshot("verification_failed"));
    expect(await resultPromise).toEqual({ outcome: "closed", reason: "verification_failed" });
  });

  it("treats a deadline timeout as a rejection and tears down the listener", async () => {
    const { poll, deliver } = fakePoll();
    const mutate = vi.fn().mockResolvedValue(undefined);
    const listener = fakeListener();
    const resultPromise = runRoomVerification({
      relay: "https://relay.test", credential: "acrp.x", ownParticipantId: "rp_host",
      poll, mutate, createListener: listener.factory,
    });
    // Deadline already effectively passed -- the race resolves via the timer, not a typed line.
    const verifying = deliver(verifyingSnapshot(1, 0));
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledWith("https://relay.test", "acrp.x", "reject"), { timeout: 3_000 });
    await verifying;
    expect(listener.close).toHaveBeenCalled();
    await deliver(closedSnapshot("verification_failed"));
    await resultPromise;
  }, 5_000);

  it("does not re-prompt for the same membership_epoch on a repeated snapshot", async () => {
    const { poll, deliver } = fakePoll();
    const mutate = vi.fn().mockResolvedValue(undefined);
    let listenerCount = 0;
    const listener = fakeListener();
    const countingFactory = () => { listenerCount += 1; return listener.factory(); };
    const resultPromise = runRoomVerification({
      relay: "https://relay.test", credential: "acrp.x", ownParticipantId: "rp_host",
      poll, mutate, createListener: countingFactory,
    });
    const firstVerifying = deliver(verifyingSnapshot(1, 60_000));
    await vi.waitFor(() => expect(listenerCount).toBe(1));
    // Same epoch, still verifying: onSnapshot returns immediately (the
    // early-return guard, before ever touching the listener), so this one
    // is safe to await directly.
    await deliver(verifyingSnapshot(1, 60_000));
    expect(listenerCount).toBe(1);
    listener.emit("y");
    await firstVerifying;
    await deliver(activeSnapshot(2));
    await resultPromise;
  });

  it("resolves closed immediately if the room is already closed", async () => {
    const { poll, deliver } = fakePoll();
    const resultPromise = runRoomVerification({
      relay: "https://relay.test", credential: "acrp.x", ownParticipantId: "rp_host",
      poll, mutate: vi.fn(), createListener: fakeListener().factory,
    });
    await deliver(closedSnapshot("idle"));
    expect(await resultPromise).toEqual({ outcome: "closed", reason: "idle" });
  });
});
