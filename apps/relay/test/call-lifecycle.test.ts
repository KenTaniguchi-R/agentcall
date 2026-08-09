import { describe, expect, it } from "vitest";
import {
  advanceAuthorizedCall, beginAuthorizedCall, expireAuthorizedCall,
  teamCallPrincipal, terminateAuthorizedCall,
} from "../src/call-lifecycle.js";

describe("authorized Team call lifecycle", () => {
  it("derives the durable caller principal from authenticated identity", () => {
    expect(teamCallPrincipal({
      org: "acme", handle: "ken", agentId: `agt_${"a".repeat(32)}`, role: "member", recoveryGeneration: 2,
    })).toEqual({
      kind: "team", organization: "acme", participant: "ken", credential_generation: 2,
    });
  });

  it("advances live phases monotonically", () => {
    const principal = teamCallPrincipal({
      org: "acme", handle: "ken", agentId: `agt_${"a".repeat(32)}`, role: "member", recoveryGeneration: 2,
    });
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
  });
});
