import { describe, expect, it, vi } from "vitest";
import { inspectPeer, inspectionExitCode, type PeerInspectionIO } from "../src/peer-inspection.js";
import { getPaths } from "../src/paths.js";

const paths = getPaths("/state", "/home");
const config = { org: "acme", handle: "me", token: "tok", relay: "https://relay.test", agent_kind: "claude" as const };
const card = {
  handle: "ken", description: "Architecture owner", agent_kind: "claude" as const,
  tasks: [{ id: "ask", name: "Ask", description: "Ask about architecture", examples: ["Why this design?"], keywords: [] }],
  offline_delivery: { enabled: false },
  updated_at: 1,
};

function io(overrides: Partial<PeerInspectionIO> = {}): PeerInspectionIO {
  return {
    loadInstallation: () => ({ paths, config }),
    resolveAddress: (_paths, value, org) => value === "ken"
      ? { ok: true, org: org ?? "acme", handle: "ken", address: "@acme/ken" }
      : { ok: true, org: "acme", handle: "me", address: "@acme/me" },
    loadContacts: () => ({ contacts: [{ name: "ken", address: "@acme/ken", note: "Ask about architecture" }] }),
    getStatus: async () => ({ online: true }),
    fetchKeys: async () => ({}) as never,
    fetchCard: async () => card,
    inspectIdentity: async () => ({ state: "matched", pinned_fingerprint: "SHA256:pinned", served_fingerprint: "SHA256:pinned" }),
    ...overrides,
  };
}

describe("inspectPeer", () => {
  it("combines contact context, non-mutating identity comparison, card, and a safe next command", async () => {
    const status = vi.fn(async () => ({ online: true }));
    const result = await inspectPeer("ken", paths, io({ getStatus: status }));

    expect(result).toMatchObject({
      address: "@acme/ken",
      contact: { name: "ken", note: "Ask about architecture" },
      availability: { state: "undisclosed" },
      identity: { state: "matched", pinned_fingerprint: "SHA256:pinned" },
      card: { state: "available", value: { handle: "ken" } },
      next_command: 'agentcall call @acme/ken --task ask "<message>"',
    });
    expect(status).not.toHaveBeenCalled();
    expect(inspectionExitCode(result)).toBe(0);
  });

  it("reports self presence and uses exit 2 for offline", async () => {
    const result = await inspectPeer("@acme/me", paths, io({ getStatus: async () => ({ online: false }) }));
    expect(result.availability).toEqual({ state: "offline" });
    expect(inspectionExitCode(result)).toBe(2);
  });

  it("uses exit 3 for a missing card without conflating it with identity failure", async () => {
    const result = await inspectPeer("ken", paths, io({
      fetchCard: async () => { throw Object.assign(new Error("missing"), { code: "unknown_handle" }); },
    }));
    expect(result.identity.state).toBe("matched");
    expect(result.card).toEqual({ state: "missing" });
    expect(inspectionExitCode(result)).toBe(3);
  });

  it("keeps changed identity and missing card as separate machine-readable states", async () => {
    const result = await inspectPeer("ken", paths, io({
      inspectIdentity: async () => ({ state: "changed", pinned_fingerprint: "SHA256:old", served_fingerprint: "SHA256:new" }),
      fetchCard: async () => { throw Object.assign(new Error("missing"), { code: "unknown_handle" }); },
    }));
    expect(result.identity).toEqual({ state: "changed", pinned_fingerprint: "SHA256:old", served_fingerprint: "SHA256:new" });
    expect(result.card).toEqual({ state: "missing" });
    expect(inspectionExitCode(result)).toBe(1);
  });

  it("preserves independent key and card failures", async () => {
    const result = await inspectPeer("ken", paths, io({
      fetchKeys: async () => { throw new Error("keys unavailable"); },
      fetchCard: async () => { throw new Error("card unavailable"); },
    }));
    expect(result.identity).toEqual({ state: "unavailable", detail: "keys unavailable" });
    expect(result.card).toEqual({ state: "unavailable", detail: "card unavailable" });
    expect(inspectionExitCode(result)).toBe(1);
  });
});
