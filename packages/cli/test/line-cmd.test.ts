import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { loadPerson, savePerson } from "../src/person.js";
import { addLine, removeLine, setPrimary } from "../src/commands/line.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-linecmd-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const ok = async () => ({ token: "tok", address: "ken-cdx@r.example" });
const base = { handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("addLine", () => {
  it("registers, then writes config.json as the first thing on disk", async () => {
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false });
    const l = getLinePaths(m, "codex");
    expect(JSON.parse(readFileSync(l.configFile, "utf8")).token).toBe("tok");
  });

  it("leaves the disk untouched when the handle is taken", async () => {
    const taken = async () => { throw new Error("Handle \"ken-cdx\" is already taken."); };
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: taken, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already taken/);
    expect(readdirSync(m.linesDir)).toEqual([]);
  });

  it("rejects an invalid line name before registering", async () => {
    let called = false;
    await expect(addLine(m, { name: "../evil", handle: "x", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { token: "t", address: "a" }; },
      installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/line name/i);
    expect(called).toBe(false);
  });

  it("refuses a name that already exists", async () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    await expect(addLine(m, { name: "codex", handle: "other", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already/);
  });

  it("refuses a handle another line already holds", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken-cdx" });
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/ken-cdx/);
  });

  it("warns when the handle is a predictable derivative of an existing one", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    const warnings: string[] = [];
    await addLine(m, { name: "codex", handle: "ken-codex", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false,
      warn: (s) => warnings.push(s) });
    expect(warnings.join(" ")).toMatch(/guess/i);
  });

  it("installs no launch agent for a caller-only line", async () => {
    let installed = false;
    await addLine(m, { name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
      register: ok, installLaunchAgentFn: () => { installed = true; }, publishCardFn: async () => undefined, verify: false });
    expect(installed).toBe(false);
  });
});

describe("removeLine", () => {
  it("archives the line rather than deleting it", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "codex", { confirm: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(getLinePaths(m, "codex").dir)).toBe(false);
    expect(readdirSync(m.removedDir)[0]).toMatch(/^codex-/);
  });

  it("deletes outright with --purge", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "codex", { confirm: true, purge: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(m.removedDir)).toBe(false);
  });

  it("refuses the primary while another line exists", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/line primary/);
  });

  it("refuses the only line", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/uninstall --purge/);
  });

  it("requires confirmation, because the handle can never be reclaimed", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "codex", { confirm: false, uninstallFn: () => {} })).toThrow(/--yes/);
  });

  it("removes an orphaned line directory", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "half", { confirm: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(getLinePaths(m, "half").dir)).toBe(false);
  });
});

describe("setPrimary", () => {
  it("rewrites person.json and nothing else", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), base);
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(getLinePaths(m, "claude").configFile, "utf8");
    setPrimary(m, "codex");
    expect(loadPerson(m).primary_line).toBe("codex");
    expect(readFileSync(getLinePaths(m, "claude").configFile, "utf8")).toBe(before);
  });

  it("refuses a line that does not exist", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    expect(() => setPrimary(m, "nope")).toThrow(/nope/);
  });
});
