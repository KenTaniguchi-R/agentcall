import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { resolveLine } from "../src/lineContext.js";
import { rotateLine } from "../src/commands/rotate.js";

let m: MachinePaths;
const base = { handle: "ken", token: "old", relay: "https://r.example", agent_kind: "claude" as const };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-rot-"));
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
});
