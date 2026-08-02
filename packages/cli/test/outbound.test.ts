import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { savePerson } from "../src/person.js";
import { pickOutboundLine } from "../src/outbound.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-out-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const A = "https://a.example";
const B = "https://b.example";

describe("pickOutboundLine", () => {
  it("uses the only line on the destination's relay", () => {
    saveLineConfig(getLinePaths(m, "work"), { handle: "ken-w", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    expect(pickOutboundLine(m, B).name).toBe("work");
  });

  it("uses the primary when several lines share the destination relay", () => {
    saveLineConfig(getLinePaths(m, "claude"), { handle: "ken", token: "t", relay: A });
    saveLineConfig(getLinePaths(m, "codex"), { handle: "ken-cdx", token: "t", relay: A });
    savePerson(m, { primary_line: "codex" });
    expect(pickOutboundLine(m, A).name).toBe("codex");
  });

  it("refuses when the primary is on another relay and several candidates tie", () => {
    saveLineConfig(getLinePaths(m, "w1"), { handle: "k1", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "w2"), { handle: "k2", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    savePerson(m, { primary_line: "home" });
    expect(() => pickOutboundLine(m, B)).toThrow(/--as/);
  });

  it("names the relays this machine holds lines on when none match", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    expect(() => pickOutboundLine(m, B)).toThrow(/a\.example/);
  });

  it("honours --as, even across relays, but rejects a mismatch", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    saveLineConfig(getLinePaths(m, "work"), { handle: "ken-w", token: "t", relay: B });
    expect(pickOutboundLine(m, B, { as: "work" }).name).toBe("work");
    expect(() => pickOutboundLine(m, B, { as: "home" })).toThrow(/a\.example/);
  });

  it("matches on relay host, ignoring a trailing slash", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: "https://a.example/" });
    expect(pickOutboundLine(m, A).name).toBe("home");
  });

  it("gracefully degrades when resolvePrimary throws: several candidates, no primary recorded", () => {
    saveLineConfig(getLinePaths(m, "w1"), { handle: "k1", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "w2"), { handle: "k2", token: "t", relay: B });
    // deliberately NOT calling savePerson(), so resolvePrimary will throw
    expect(() => pickOutboundLine(m, B)).toThrow(/--as/);
  });

  it("rejects --as with mismatched relay, naming both hosts", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    saveLineConfig(getLinePaths(m, "work"), { handle: "ken-w", token: "t", relay: B });
    let error: Error | undefined;
    try {
      pickOutboundLine(m, B, { as: "home" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    // Check that error message names BOTH the line's relay (a.example) AND the destination relay (b.example)
    expect(error!.message).toMatch(/a\.example/);
    expect(error!.message).toMatch(/b\.example/);
  });

  it("rejects --as when the named line doesn't exist", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    expect(() => pickOutboundLine(m, A, { as: "nonexistent" })).toThrow(/No line named "nonexistent"/);
  });

  // Wiring guard for `index.ts`'s `call`/`status`: proves the same function
  // this file already exercises above is what selects a line from the
  // destination's relay, not some fixed per-process config.
  it("call resolves its line from the destination address, not from a fixed config", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    const ctx = pickOutboundLine(m, A);
    expect(ctx.config.handle).toBe("ken");
    expect(ctx.config.token).toBe("t");
  });
});
