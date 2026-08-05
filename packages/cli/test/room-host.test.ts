import { describe, expect, it, vi } from "vitest";
import { randomBase64Url } from "@benree/agentcall-shared";
import { runRoomHost } from "../src/room-host.js";
import type { RoomPollOptions } from "../src/room-poll.js";
import type { RoomLineListener } from "../src/tty.js";

const ROOM_ID = `room_${randomBase64Url(16)}`;
const HOST_ID = `rp_${randomBase64Url(16)}`;

// parseRoomCapability (real, not mocked) parses this, so it must actually
// satisfy RoomCapability's format -- a hand-typed placeholder like "rp_host"
// or "a".repeat(43) is too short / not canonical base64url and fails. Left
// untyped (not `as never`) so property access like created.credential below
// still typechecks; only the mock's resolved-value assignment needs `never`.
const created = {
  room: { room_id: ROOM_ID, state: "waiting", membership_epoch: 0, expected_participants: 2 },
  participants: [],
  credential: `acrp.${ROOM_ID}.${HOST_ID}.${randomBase64Url(32)}`,
  invite: {
    invite: `acri.${ROOM_ID}.ri_${randomBase64Url(16)}.${randomBase64Url(32)}`,
    expires_at: Date.now() + 300_000, seats_remaining: 1,
  },
};

function waitingSnapshot(participants: unknown[]) {
  return { room: { room_id: ROOM_ID, state: "waiting", membership_epoch: 0 }, participants } as never;
}

function fakePoll() {
  let captured: RoomPollOptions | undefined;
  const stop = vi.fn();
  const poll = (options: RoomPollOptions) => { captured = options; return { stop }; };
  // runRoomHost awaits real key generation and createRoomFn before it ever
  // reaches poll(...), so anything delivered immediately after calling
  // runRoomHost can race ahead of poll() being invoked at all.
  const waitReady = () => vi.waitFor(() => { if (!captured) throw new Error("poll() not called yet"); });
  const deliver = async (s: never) => {
    await waitReady();
    return captured!.onSnapshot(s);
  };
  return { poll, deliver, waitReady, stop };
}

function fakeListener() {
  let handler: ((line: string) => void) | undefined;
  const printed: string[] = [];
  const close = vi.fn();
  const factory = (): RoomLineListener => ({
    onLine: (h) => { handler = h; }, print: (t) => printed.push(t), close,
  });
  return { factory, emit: (line: string) => handler?.(line), printed, close };
}

function baseDeps() {
  const { poll, deliver, waitReady } = fakePoll();
  const listener = fakeListener();
  const mutate = vi.fn().mockResolvedValue(undefined);
  const runVerification = vi.fn().mockResolvedValue({ outcome: "active", snapshot: { participants: [1, 2] } });
  const createRoomFn = vi.fn().mockResolvedValue(created as never);
  return { poll, deliver, waitReady, listener, mutate, runVerification, createRoomFn };
}

describe("runRoomHost", () => {
  it("throws before creating anything when the machine is ineligible", async () => {
    const deps = baseDeps();
    const checkEligibility = vi.fn().mockReturnValue({ supported: false, reason: "no evidence" });
    await expect(runRoomHost({
      seats: 2, relay: "https://relay.test", checkEligibility,
      createRoomFn: deps.createRoomFn, poll: deps.poll, mutate: deps.mutate,
      createListener: deps.listener.factory, runVerification: deps.runVerification,
    })).rejects.toThrow(/no evidence/);
    expect(deps.createRoomFn).not.toHaveBeenCalled();
  });

  it("rejects seat counts outside 2-6 without any network call", async () => {
    const deps = baseDeps();
    await expect(runRoomHost({ seats: 7, relay: "https://relay.test", createRoomFn: deps.createRoomFn }))
      .rejects.toThrow(/2 and 6/);
    expect(deps.createRoomFn).not.toHaveBeenCalled();
  });

  it("admits on a 'y' line and hands off to verification once locked", async () => {
    const deps = baseDeps();
    const checkEligibility = vi.fn().mockReturnValue({ supported: true, evidence: { cliVersion: "9.9.9" } });
    const resultPromise = runRoomHost({
      seats: 2, relay: "https://relay.test", checkEligibility,
      createRoomFn: deps.createRoomFn, poll: deps.poll, mutate: deps.mutate,
      createListener: deps.listener.factory, runVerification: deps.runVerification,
    });

    // onSnapshot blocks on the admit answer, so it must not be awaited yet --
    // awaiting it here would deadlock on an answer nobody has given.
    const admitting = deps.deliver(waitingSnapshot([
      { participant_id: "rp_guest", state: "pending", display_name: "sota" },
    ]));
    await vi.waitFor(() => expect(deps.listener.printed.join("")).toContain("sota wants to join. Admit?"));
    deps.listener.emit("y");
    await vi.waitFor(() => expect(deps.mutate).toHaveBeenCalledWith(
      "https://relay.test", created.credential, "admit", "rp_guest",
    ));
    await admitting;

    await deps.deliver({ room: { room_id: "room_x", state: "verifying", membership_epoch: 1 }, participants: [] } as never);
    const result = await resultPromise;
    expect(deps.runVerification).toHaveBeenCalledWith(expect.objectContaining({ credential: created.credential }));
    expect(result).toEqual({ outcome: "active", snapshot: { participants: [1, 2] } });
    expect(deps.listener.close).toHaveBeenCalled();
  });

  it("denies on anything other than an empty or 'y' line", async () => {
    const deps = baseDeps();
    const resultPromise = runRoomHost({
      seats: 2, relay: "https://relay.test",
      checkEligibility: () => ({ supported: true, evidence: { cliVersion: "9.9.9" } } as never),
      createRoomFn: deps.createRoomFn, poll: deps.poll, mutate: deps.mutate,
      createListener: deps.listener.factory, runVerification: deps.runVerification,
    });
    const denying = deps.deliver(waitingSnapshot([
      { participant_id: "rp_guest", state: "pending", display_name: "sota" },
    ]));
    await vi.waitFor(() => expect(deps.listener.printed.join("")).toContain("sota wants to join. Admit?"));
    deps.listener.emit("n");
    await vi.waitFor(() => expect(deps.mutate).toHaveBeenCalledWith(
      "https://relay.test", created.credential, "deny", "rp_guest",
    ));
    await denying;
    await deps.deliver({ room: { room_id: "room_x", state: "closed", close_reason: "insufficient_participants" }, participants: [] } as never);
    expect(await resultPromise).toEqual({ outcome: "closed", reason: "insufficient_participants" });
  });

  it("resolves closed without calling runVerification if the Room closes while waiting", async () => {
    const deps = baseDeps();
    const resultPromise = runRoomHost({
      seats: 2, relay: "https://relay.test",
      checkEligibility: () => ({ supported: true, evidence: { cliVersion: "9.9.9" } } as never),
      createRoomFn: deps.createRoomFn, poll: deps.poll, mutate: deps.mutate,
      createListener: deps.listener.factory, runVerification: deps.runVerification,
    });
    await deps.deliver({ room: { room_id: "room_x", state: "closed", close_reason: "abuse_limit" }, participants: [] } as never);
    expect(await resultPromise).toEqual({ outcome: "closed", reason: "abuse_limit" });
    expect(deps.runVerification).not.toHaveBeenCalled();
  });

  it("/start with fewer than 2 admitted warns instead of locking", async () => {
    const deps = baseDeps();
    const resultPromise = runRoomHost({
      seats: 3, relay: "https://relay.test",
      checkEligibility: () => ({ supported: true, evidence: { cliVersion: "9.9.9" } } as never),
      createRoomFn: deps.createRoomFn, poll: deps.poll, mutate: deps.mutate,
      createListener: deps.listener.factory, runVerification: deps.runVerification,
    });
    // The line listener is only registered after generateKeys/createRoomFn
    // resolve, same as poll() -- wait for that before emitting, or the line
    // arrives before anything is listening and is silently lost.
    await deps.waitReady();
    deps.listener.emit("/start");
    await deps.deliver(waitingSnapshot([]));
    expect(deps.mutate).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "lock");
    expect(deps.listener.printed.join("")).toMatch(/at least one guest/i);
    await deps.deliver({ room: { room_id: "room_x", state: "closed", close_reason: "expired" }, participants: [] } as never);
    await resultPromise;
  });

  it("/start with at least one admitted guest locks early", async () => {
    const deps = baseDeps();
    const resultPromise = runRoomHost({
      seats: 3, relay: "https://relay.test",
      checkEligibility: () => ({ supported: true, evidence: { cliVersion: "9.9.9" } } as never),
      createRoomFn: deps.createRoomFn, poll: deps.poll, mutate: deps.mutate,
      createListener: deps.listener.factory, runVerification: deps.runVerification,
    });
    await deps.waitReady();
    deps.listener.emit("/start");
    await deps.deliver(waitingSnapshot([{ participant_id: "rp_guest", state: "admitted", display_name: "sota", seat: 2 }]));
    await vi.waitFor(() => expect(deps.mutate).toHaveBeenCalledWith(
      "https://relay.test", created.credential, "lock",
    ));
    await deps.deliver({ room: { room_id: "room_x", state: "verifying", membership_epoch: 1 }, participants: [] } as never);
    await resultPromise;
  });
});
