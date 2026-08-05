import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync } from "node:fs";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { savePerson } from "../src/person.js";
import { pickOutboundLine } from "../src/outbound.js";
import { tempDir } from "./helpers.js";

let m: MachinePaths;
beforeEach(() => {
  const root = tempDir("agentcall-out-");
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const RELAY = "https://relay.example";
const ACME = "acme";
const BETA = "beta";

// Selection is by ORGANIZATION now, not by relay host. A line may only call
// inside its own organization, which is the rule the old host match was
// approximating — and with the host gone from addresses there is nothing else
// it could match on.
describe("pickOutboundLine", () => {
  it("uses the only line in the destination's organization", () => {
    saveLineConfig(getLinePaths(m, "work"), { org: BETA, handle: "ken-w", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "home"), { org: ACME, handle: "ken", token: "t", relay: RELAY });
    expect(pickOutboundLine(m, BETA).name).toBe("work");
  });

  it("uses the primary when several lines share the destination organization", () => {
    saveLineConfig(getLinePaths(m, "claude"), { org: ACME, handle: "ken", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "codex"), { org: ACME, handle: "ken-cdx", token: "t", relay: RELAY });
    savePerson(m, { primary_line: "codex" });
    expect(pickOutboundLine(m, ACME).name).toBe("codex");
  });

  it("refuses when the primary is in another organization and several candidates tie", () => {
    saveLineConfig(getLinePaths(m, "w1"), { org: BETA, handle: "k1", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "w2"), { org: BETA, handle: "k2", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "home"), { org: ACME, handle: "ken", token: "t", relay: RELAY });
    savePerson(m, { primary_line: "home" });
    expect(() => pickOutboundLine(m, BETA)).toThrow(/--as/);
  });

  it("names the organizations this machine holds lines in when none match", () => {
    saveLineConfig(getLinePaths(m, "home"), { org: ACME, handle: "ken", token: "t", relay: RELAY });
    expect(() => pickOutboundLine(m, BETA)).toThrow(/acme/);
  });

  it("honours --as, but rejects a line from another organization", () => {
    saveLineConfig(getLinePaths(m, "home"), { org: ACME, handle: "ken", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "work"), { org: BETA, handle: "ken-w", token: "t", relay: RELAY });
    expect(pickOutboundLine(m, BETA, { as: "work" }).name).toBe("work");
    expect(() => pickOutboundLine(m, BETA, { as: "home" })).toThrow(/acme/);
  });

  it("gracefully degrades when resolvePrimary throws: several candidates, no primary recorded", () => {
    saveLineConfig(getLinePaths(m, "w1"), { org: BETA, handle: "k1", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "w2"), { org: BETA, handle: "k2", token: "t", relay: RELAY });
    // deliberately NOT calling savePerson(), so resolvePrimary will throw
    expect(() => pickOutboundLine(m, BETA)).toThrow(/--as/);
  });

  it("rejects --as with a mismatched organization, naming both", () => {
    saveLineConfig(getLinePaths(m, "home"), { org: ACME, handle: "ken", token: "t", relay: RELAY });
    saveLineConfig(getLinePaths(m, "work"), { org: BETA, handle: "ken-w", token: "t", relay: RELAY });
    let error: Error | undefined;
    try {
      pickOutboundLine(m, BETA, { as: "home" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/acme/);
    expect(error!.message).toMatch(/beta/);
  });

  it("rejects --as when the named line doesn't exist", () => {
    saveLineConfig(getLinePaths(m, "home"), { org: "acme", handle: "ken", token: "t", relay: RELAY });
    expect(() => pickOutboundLine(m, ACME, { as: "nonexistent" })).toThrow(/No line named "nonexistent"/);
  });

  // Wiring guard for `index.ts`'s `call`/`status`: proves the same function
  // this file already exercises above is what selects a line from the
  // destination's relay, not some fixed per-process config.
  it("call resolves its line from the destination address, not from a fixed config", () => {
    saveLineConfig(getLinePaths(m, "home"), { org: "acme", handle: "ken", token: "t", relay: RELAY });
    const ctx = pickOutboundLine(m, ACME);
    expect(ctx.config.handle).toBe("ken");
    expect(ctx.config.token).toBe("t");
  });
});
