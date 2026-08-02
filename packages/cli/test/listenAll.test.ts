import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { startAllListeners } from "../src/listenAll.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-all-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const base = { token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("startAllListeners", () => {
  it("starts one listener per callable line", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    const started: string[] = [];
    const h = startAllListeners(m, { start: (d) => { started.push(d.paths.name); return { stop() {} }; } });
    expect(started).toEqual(["claude", "codex"]);
    expect(h.started).toEqual(["claude", "codex"]);
    h.stop();
  });

  it("skips a caller-only line", () => {
    saveLineConfig(getLinePaths(m, "caller"), { handle: "ken", token: "t", relay: "https://r.example" });
    const h = startAllListeners(m, { start: () => ({ stop() {} }) });
    expect(h.started).toEqual([]);
    h.stop();
  });

  it("skips an orphaned line without throwing", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    const h = startAllListeners(m, { start: () => ({ stop() {} }) });
    expect(h.started).toEqual(["claude"]);
    h.stop();
  });

  it("stops every listener it started", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    let stops = 0;
    startAllListeners(m, { start: () => ({ stop() { stops++; } }) }).stop();
    expect(stops).toBe(2);
  });
});
