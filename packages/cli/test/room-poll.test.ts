import { describe, expect, it, vi } from "vitest";
import { pollRoomState } from "../src/room-poll.js";

function snapshot(state: string, ownState: string) {
  return {
    room: { room_id: "room_x", state, membership_epoch: 1 },
    participants: [{ participant_id: "rp_self", state: ownState, display_name: "ken" }],
    participant: { participant_id: "rp_self", state: ownState, display_name: "ken" },
  } as never;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

describe("pollRoomState", () => {
  it("polls via GET while pending, switches to heartbeat once admitted", async () => {
    // fetchState reports "admitted" on its very first (and only) call -- mode
    // switching is driven by the *previous* response's own-state, so every
    // tick after that must go through heartbeat, never fetchState again.
    // (Not asserting an intermediate "not yet called" point: with a 10ms
    // interval, the second tick can land before a fixed few-ms checkpoint,
    // which made this racy rather than actually wrong.)
    const fetchState = vi.fn().mockResolvedValue(snapshot("waiting", "admitted"));
    const heartbeat = vi.fn().mockResolvedValue(snapshot("waiting", "admitted"));
    const handle = pollRoomState({
      relay: "http://relay.test", credential: "acrp.x", ownParticipantId: "rp_self",
      intervalMs: 10, fetchState, heartbeat, onSnapshot: () => {},
    });
    await sleep(35);
    handle.stop();
    expect(heartbeat).toHaveBeenCalled();
    expect(fetchState).toHaveBeenCalledTimes(1);
  });

  it("calls onSnapshot with each successful poll", async () => {
    const seen: string[] = [];
    const fetchState = vi.fn().mockResolvedValue(snapshot("waiting", "pending"));
    const handle = pollRoomState({
      relay: "http://relay.test", credential: "acrp.x", ownParticipantId: "rp_self",
      intervalMs: 10, fetchState, heartbeat: vi.fn(),
      onSnapshot: (s) => { seen.push(s.room.state); },
    });
    await sleep(35);
    handle.stop();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("calls onError and keeps polling instead of throwing", async () => {
    let calls = 0;
    const fetchState = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("network blip")) : Promise.resolve(snapshot("waiting", "pending"));
    });
    const errors: unknown[] = [];
    const seen: string[] = [];
    const handle = pollRoomState({
      relay: "http://relay.test", credential: "acrp.x", ownParticipantId: "rp_self",
      intervalMs: 10, fetchState, heartbeat: vi.fn(),
      onSnapshot: (s) => { seen.push(s.room.state); }, onError: (e) => errors.push(e),
    });
    await sleep(40);
    handle.stop();
    expect(errors).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("stop() halts further polling", async () => {
    const fetchState = vi.fn().mockResolvedValue(snapshot("waiting", "pending"));
    const handle = pollRoomState({
      relay: "http://relay.test", credential: "acrp.x", ownParticipantId: "rp_self",
      intervalMs: 10, fetchState, heartbeat: vi.fn(), onSnapshot: () => {},
    });
    await sleep(15);
    handle.stop();
    const callsAtStop = fetchState.mock.calls.length;
    await sleep(40);
    expect(fetchState.mock.calls.length).toBe(callsAtStop);
  });

  it("stops polling once the AbortSignal fires", async () => {
    const controller = new AbortController();
    const fetchState = vi.fn().mockResolvedValue(snapshot("waiting", "pending"));
    pollRoomState({
      relay: "http://relay.test", credential: "acrp.x", ownParticipantId: "rp_self",
      intervalMs: 10, fetchState, heartbeat: vi.fn(), onSnapshot: () => {}, signal: controller.signal,
    });
    await sleep(15);
    controller.abort();
    const callsAtAbort = fetchState.mock.calls.length;
    await sleep(40);
    expect(fetchState.mock.calls.length).toBe(callsAtAbort);
  });
});
