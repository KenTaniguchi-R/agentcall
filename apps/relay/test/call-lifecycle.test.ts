import { describe, expect, it } from "vitest";
import {
  advanceAuthorizedCall, authorizedPrincipalKey, beginAuthorizedCall, expireAuthorizedCall,
  roomCallPrincipal, teamCallPrincipal, terminateAuthorizedCall,
} from "../src/call-lifecycle.js";

describe("identity-neutral authorized call lifecycle", () => {
  it("keeps durable Team and ephemeral Room principals discriminated", () => {
    const team = teamCallPrincipal({
      org: "acme", handle: "ken", agentId: `agt_${"a".repeat(32)}`, role: "member", recoveryGeneration: 2,
    });
    const room = roomCallPrincipal({
      roomId: `room_${"A".repeat(22)}`,
      participantId: `rp_${"B".repeat(22)}`,
      membershipEpoch: 3,
    });
    expect(team).toEqual({
      kind: "team", organization: "acme", participant: "ken", credential_generation: 2,
    });
    expect(room).toEqual({
      kind: "room",
      room_id: `room_${"A".repeat(22)}`,
      participant_id: `rp_${"B".repeat(22)}`,
      membership_epoch: 3,
    });
    expect(authorizedPrincipalKey(team)).toBe("team:acme:ken:2");
    expect(authorizedPrincipalKey(room)).toBe(`room:room_${"A".repeat(22)}:3:rp_${"B".repeat(22)}`);
  });

  it("advances live phases monotonically for both routing paths", () => {
    const principals = [
      teamCallPrincipal({ org: "acme", handle: "ken", agentId: `agt_${"a".repeat(32)}`, role: "member", recoveryGeneration: 2 }),
      roomCallPrincipal({
        roomId: `room_${"A".repeat(22)}`,
        participantId: `rp_${"B".repeat(22)}`,
        membershipEpoch: 3,
      }),
    ];
    for (const principal of principals) {
      const submitted = beginAuthorizedCall(principal, 100);
      const accepted = advanceAuthorizedCall(submitted, "accepted");
      const working = advanceAuthorizedCall(accepted, "working");
      expect(accepted.phase).toBe("accepted");
      expect(working.phase).toBe("working");
      expect(advanceAuthorizedCall(working, "accepted")).toBe(working);
      expect(advanceAuthorizedCall(working, "working")).toBe(working);
      expect(expireAuthorizedCall(working, 99)).toBeUndefined();
      expect(expireAuthorizedCall(working, 100)).toMatchObject({ principal, terminal: "expired" });
      expect(terminateAuthorizedCall(working, "canceled")).toMatchObject({ principal, terminal: "canceled" });
    }
  });
});
