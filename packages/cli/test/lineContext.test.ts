import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { savePerson } from "../src/person.js";
import { resolveLine } from "../src/lineContext.js";
import { tempDir } from "./helpers.js";

let m: MachinePaths;
const cfg = { org: "acme", handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

beforeEach(() => {
  const root = tempDir("agentcall-linectx-");
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
  delete process.env.AGENTCALL_LINE;
});
afterEach(() => { delete process.env.AGENTCALL_LINE; });

describe("resolveLine", () => {
  it("prefers an explicit --line over everything", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    savePerson(m, { primary_line: "claude" });
    process.env.AGENTCALL_LINE = "claude";
    expect(resolveLine(m, { line: "codex" }).name).toBe("codex");
  });

  it("falls back to AGENTCALL_LINE, then to the primary", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    savePerson(m, { primary_line: "claude" });
    process.env.AGENTCALL_LINE = "codex";
    expect(resolveLine(m).name).toBe("codex");
    delete process.env.AGENTCALL_LINE;
    expect(resolveLine(m).name).toBe("claude");
  });

  it("returns the config alongside the paths, from the same line", () => {
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    const ctx = resolveLine(m, { line: "codex" });
    expect(ctx.config.handle).toBe("ken-cdx");
    expect(ctx.paths.configFile).toContain(join("lines", "codex"));
  });

  it("treats an empty-string AGENTCALL_LINE as unset, falling back to the primary", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    savePerson(m, { primary_line: "claude" });
    process.env.AGENTCALL_LINE = "";
    expect(resolveLine(m).name).toBe("claude");
  });

  it("names the available lines when asked for one that does not exist", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    expect(() => resolveLine(m, { line: "nope" })).toThrow(/claude/);
  });

  it("refuses an orphaned line rather than returning a partial context", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    expect(() => resolveLine(m, { line: "half" })).toThrow(/config\.json/);
  });
});
