import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { assertValidLineName, listLines, loadLineConfig, saveLineConfig } from "../src/lines.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-lines-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const cfg = { handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("assertValidLineName", () => {
  it("accepts lowercase alphanumeric and hyphens", () => {
    expect(() => assertValidLineName("codex-2")).not.toThrow();
  });

  it.each(["../escape", "Codex", "has space", "-leading", "", "a".repeat(33)])(
    "rejects %j",
    (name) => {
      expect(() => assertValidLineName(name)).toThrow(/line name/i);
    },
  );

  // "tasks" and "public" are otherwise well-formed names, but a line's
  // authored content lives at ~/AgentCall/<line>/{tasks,public} and the
  // guard denies the legacy ~/AgentCall/tasks path wholesale — a line named
  // "tasks" would nest its own tasks dir inside a denied root and fail
  // every call silently. See the comment on RESERVED_LINE_NAMES in
  // lineName.ts.
  it.each(["tasks", "public"])("rejects the reserved name %j", (name) => {
    expect(() => assertValidLineName(name)).toThrow(/reserved/i);
  });
});

describe("saveLineConfig / loadLineConfig", () => {
  it("round-trips and writes 0600 under a 0700 directory", () => {
    const l = getLinePaths(m, "claude");
    saveLineConfig(l, cfg);
    expect(loadLineConfig(l)).toEqual(cfg);
    expect(statSync(l.configFile).mode & 0o777).toBe(0o600);
    expect(statSync(l.dir).mode & 0o777).toBe(0o700);
  });

  it("round-trips a caller-only line (no agent_kind)", () => {
    const l = getLinePaths(m, "caller");
    const callerOnly = { handle: "solo", token: "t", relay: "https://r.example" };
    saveLineConfig(l, callerOnly);
    expect(loadLineConfig(l)).toEqual(callerOnly);
    expect(loadLineConfig(l).agent_kind).toBeUndefined();
  });
});

describe("listLines", () => {
  it("returns nothing when linesDir does not exist", () => {
    const empty = getMachinePaths(mkdtempSync(join(tmpdir(), "agentcall-none-")));
    expect(listLines(empty)).toEqual([]);
  });

  it("lists valid lines sorted by name", () => {
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    expect(listLines(m).map((l) => l.name)).toEqual(["claude", "codex"]);
    expect(listLines(m).every((l) => l.ok)).toBe(true);
  });

  it("reports a line with no config.json as an orphan rather than throwing", () => {
    mkdirSync(join(m.linesDir, "half-made"), { recursive: true });
    const [line] = listLines(m);
    expect(line!.ok).toBe(false);
    expect(line!.error).toMatch(/config\.json/);
  });

  it("reports a schema-invalid config as an orphan", () => {
    const l = getLinePaths(m, "broken");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ handle: "x" }));
    expect(listLines(m)[0]!.ok).toBe(false);
  });

  it("ignores files and invalid names sitting in linesDir", () => {
    writeFileSync(join(m.linesDir, "stray.txt"), "x");
    mkdirSync(join(m.linesDir, "Bad Name"), { recursive: true });
    expect(listLines(m)).toEqual([]);
  });
});
