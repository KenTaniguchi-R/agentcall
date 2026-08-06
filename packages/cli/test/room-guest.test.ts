import { describe, expect, it, vi } from "vitest";
import { runRoomGuest } from "../src/room-guest.js";
import { RoomApiError } from "../src/room-api.js";
import type { RoomPollOptions } from "../src/room-poll.js";

const VALID_INVITE = "acri.room_" + "a".repeat(22) + ".ri_" + "b".repeat(22) + "." + "c".repeat(43);

function fakePoll() {
  let captured: RoomPollOptions | undefined;
  const stop = vi.fn();
  const poll = (options: RoomPollOptions) => { captured = options; return { stop }; };
  return { poll, deliver: (s: never) => captured!.onSnapshot(s) };
}

// Left untyped (not `as never`) so property access like joinedResponse().credential
// below still typechecks; cast only where it's fed to a mock's resolved value.
function joinedResponse(overrides: Partial<{ participant: unknown; credential: string }> = {}) {
  return {
    room: { room_id: "room_x", state: "waiting", membership_epoch: 0 },
    participants: [],
    participant: { participant_id: "rp_guest", state: "pending", display_name: "sota" },
    credential: "acrp.room_x.rp_guest." + "d".repeat(43),
    ...overrides,
  };
}

function baseEligibility() {
  return vi.fn().mockReturnValue({ supported: true, evidence: { cliVersion: "9.9.9" } });
}

describe("runRoomGuest", () => {
  it("throws before prompting for an invite when the machine is ineligible", async () => {
    const askInvite = vi.fn();
    const checkEligibility = vi.fn().mockReturnValue({ supported: false, reason: "no evidence" });
    await expect(runRoomGuest({ relay: "https://relay.test", checkEligibility, askInvite }))
      .rejects.toThrow(/no evidence/);
    expect(askInvite).not.toHaveBeenCalled();
  });

  it("rejects a malformed invite without ever calling join", async () => {
    const join = vi.fn();
    await expect(runRoomGuest({
      relay: "https://relay.test", checkEligibility: baseEligibility(),
      askInvite: async () => "not-an-invite", askName: async () => "sota", join,
    })).rejects.toThrow(/doesn't look like a Room invitation/);
    expect(join).not.toHaveBeenCalled();
  });

  it("joins, waits while pending, then hands off to verification once admitted", async () => {
    const { poll, deliver } = fakePoll();
    const join = vi.fn().mockResolvedValue(joinedResponse() as never);
    const runVerification = vi.fn().mockResolvedValue({ outcome: "active", snapshot: { participants: [1, 2] }, fingerprint: "ABC-123-XYZ-789" });
    const resultPromise = runRoomGuest({
      relay: "https://relay.test", checkEligibility: baseEligibility(),
      askInvite: async () => VALID_INVITE, askName: async () => "sota",
      join, poll, runVerification,
    });
    await vi.waitFor(() => expect(join).toHaveBeenCalled());
    await deliver({
      room: { room_id: "room_x", state: "waiting" },
      participant: { participant_id: "rp_guest", state: "admitted", display_name: "sota" },
      participants: [],
    } as never);
    const result = await resultPromise;
    expect(runVerification).toHaveBeenCalledWith(expect.objectContaining({ credential: joinedResponse().credential }));
    expect(result).toEqual({ outcome: "active", snapshot: { participants: [1, 2] }, fingerprint: "ABC-123-XYZ-789" });
  });

  it("resolves closed if the Room closes while still pending admission", async () => {
    const { poll, deliver } = fakePoll();
    const join = vi.fn().mockResolvedValue(joinedResponse() as never);
    const resultPromise = runRoomGuest({
      relay: "https://relay.test", checkEligibility: baseEligibility(),
      askInvite: async () => VALID_INVITE, askName: async () => "sota",
      join, poll, runVerification: vi.fn(),
    });
    await vi.waitFor(() => expect(join).toHaveBeenCalled());
    await deliver({ room: { room_id: "room_x", state: "closed", close_reason: "idle" }, participants: [] } as never);
    expect(await resultPromise).toEqual({ outcome: "closed", reason: "idle" });
  });

  it("retries with a suggested name after a duplicate-name conflict, then succeeds", async () => {
    const { poll, deliver } = fakePoll();
    const join = vi.fn()
      .mockRejectedValueOnce(new RoomApiError("display name taken", "conflict"))
      .mockResolvedValueOnce(joinedResponse() as never);
    const askName = vi.fn().mockResolvedValueOnce("sota").mockResolvedValueOnce("sota2");
    const runVerification = vi.fn().mockResolvedValue({ outcome: "active", snapshot: { participants: [1, 2] }, fingerprint: "ABC-123-XYZ-789" });
    const resultPromise = runRoomGuest({
      relay: "https://relay.test", checkEligibility: baseEligibility(),
      askInvite: async () => VALID_INVITE, askName, join, poll, runVerification,
    });
    await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(2));
    await deliver({
      room: { room_id: "room_x", state: "waiting" },
      participant: { participant_id: "rp_guest", state: "admitted", display_name: "sota2" },
      participants: [],
    } as never);
    await resultPromise;
    expect(askName).toHaveBeenCalledTimes(2);
  });

  it("gives up and throws after MAX_NAME_RETRIES duplicate-name conflicts", async () => {
    const join = vi.fn().mockRejectedValue(new RoomApiError("display name taken", "conflict"));
    await expect(runRoomGuest({
      relay: "https://relay.test", checkEligibility: baseEligibility(),
      askInvite: async () => VALID_INVITE, askName: async () => "sota",
      join, poll: vi.fn(), runVerification: vi.fn(),
    })).rejects.toThrow(/display name taken/);
  });

  it("does not retry on a non-conflict error", async () => {
    const join = vi.fn().mockRejectedValue(new RoomApiError("Room invitation unavailable", "invalid"));
    const askName = vi.fn().mockResolvedValue("sota");
    await expect(runRoomGuest({
      relay: "https://relay.test", checkEligibility: baseEligibility(),
      askInvite: async () => VALID_INVITE, askName, join, poll: vi.fn(), runVerification: vi.fn(),
    })).rejects.toThrow(/invitation unavailable/);
    expect(askName).toHaveBeenCalledTimes(1);
  });
});
