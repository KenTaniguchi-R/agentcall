import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { resolveLine } from "../src/lineContext.js";
import { rotateLine } from "../src/commands/rotate.js";
import { tempDir } from "./helpers.js";

let m: MachinePaths;
const base = { org: "acme", handle: "ken", token: "old", relay: "https://r.example", agent_kind: "claude" as const };

beforeEach(() => {
  const root = tempDir("agentcall-rot-");
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

describe("rotateLine", () => {
  it("writes the new token to that line only", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    await rotateLine(resolveLine(m, { line: "claude" }), { rotate: async () => ({ token: "new" }) });
    expect(JSON.parse(readFileSync(getLinePaths(m, "claude").configFile, "utf8")).token).toBe("new");
    expect(JSON.parse(readFileSync(getLinePaths(m, "codex").configFile, "utf8")).token).toBe("old");
  });

  it("tells the owner the listener picks it up on the next reconnect, not immediately", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    const out: string[] = [];
    await rotateLine(resolveLine(m, { line: "claude" }),
      { rotate: async () => ({ token: "new" }), log: (s) => out.push(s) });
    expect(out.join(" ")).toMatch(/next reconnect/i);
  });

  // The safety-relevant half of the message: if the old token leaked, the
  // owner needs to know a restart is what forces it off the relay NOW,
  // rather than waiting on an unbounded "next reconnect".
  it("tells the owner how to force the old token off the relay if it may have leaked", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    const out: string[] = [];
    await rotateLine(resolveLine(m, { line: "claude" }),
      { rotate: async () => ({ token: "new" }), log: (s) => out.push(s) });
    expect(out.join(" ")).toMatch(/restart the listener/i);
  });

  it("uses systemd restart guidance on Linux", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    const out: string[] = [];
    await rotateLine(resolveLine(m, { line: "claude" }), {
      rotate: async () => ({ token: "new" }),
      log: (s) => out.push(s),
      platform: "linux",
    });
    expect(out.join(" ")).toContain("systemctl --user restart agentcall-listener.service");
    expect(out.join(" ")).not.toContain("launchctl");
  });

  // A caller-only line (no agent_kind) has no listener socket of its own — the
  // pre-lines code guarded this with `else if (cfg.agent_kind)`; lines dropped
  // it and started printing reconnect/restart guidance unconditionally, which
  // makes no sense for a line that was never listening in the first place.
  it("does not print listener guidance for a caller-only line", async () => {
    saveLineConfig(getLinePaths(m, "caller"), { org: "acme", handle: "ken-c", token: "old", relay: "https://r.example" });
    const out: string[] = [];
    await rotateLine(resolveLine(m, { line: "caller" }),
      { rotate: async () => ({ token: "new" }), log: (s) => out.push(s) });
    expect(out.join(" ")).not.toMatch(/listener/i);
    expect(out.join(" ")).not.toMatch(/reconnect/i);
  });
});
