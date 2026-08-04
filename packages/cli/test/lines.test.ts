import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, statSync } from "node:fs";
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

const cfg = { org: "acme", handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

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

  it.each(["tasks", "public"])("accepts the current-layout line name %j", (name) => {
    expect(() => assertValidLineName(name)).not.toThrow();
  });

  // verify.ts uses this synthetic line name for doctor/setup probes.
  it("rejects the reserved doctor probe name", () => {
    const name = "doctor-probe";
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
    const callerOnly = { org: "acme", handle: "solo", token: "t", relay: "https://r.example" };
    saveLineConfig(l, callerOnly);
    expect(loadLineConfig(l)).toEqual(callerOnly);
    expect(loadLineConfig(l).agent_kind).toBeUndefined();
  });

  it("does not let the legacy fixed temp path block a credential save", () => {
    const l = getLinePaths(m, "poisoned-temp");
    mkdirSync(`${l.configFile}.tmp`, { recursive: true });

    expect(() => saveLineConfig(l, cfg)).not.toThrow();
    expect(loadLineConfig(l)).toEqual(cfg);
    expect(statSync(`${l.configFile}.tmp`).isDirectory()).toBe(true);
  });

  it("preserves the previous credential when serialization fails", () => {
    const l = getLinePaths(m, "serialization-failure");
    saveLineConfig(l, cfg);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => saveLineConfig(l, { ...cfg, token: "replacement", circular } as never))
      .toThrow(/circular/i);
    expect(loadLineConfig(l)).toEqual(cfg);
  });

  it("treats a line config missing a current required field as corrupt", () => {
    const l = getLinePaths(m, "preorg");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ handle: "ken", token: "old", relay: "https://relay.example" }));
    expect(() => loadLineConfig(l)).toThrow(/corrupt config\.json.*org.*line add.*--invite/i);
  });

  it("rejects a malformed organization slug", () => {
    const l = getLinePaths(m, "badorg");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ ...cfg, org: "Not A Slug" }));
    expect(() => loadLineConfig(l)).toThrow(/corrupt config\.json/i);
  });

  // The rest of #131's credential-store validation, re-homed from main's
  // config.test.ts (loadConfig/saveConfig) onto the per-line store that
  // replaced it.
  it("names an invalid JSON config and explains how to recover", () => {
    const l = getLinePaths(m, "badjson");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, "{\n");
    expect(() => loadLineConfig(l)).toThrow(
      new RegExp(`corrupt config\\.json.*${l.configFile}.*invalid JSON.*line add`, "i"),
    );
  });

  it("rejects valid JSON when credential fields have the wrong shape", () => {
    const l = getLinePaths(m, "badshape");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ org: "acme", handle: 42, token: [], relay: false }));
    expect(() => loadLineConfig(l)).toThrow(/corrupt config\.json.*handle.*token.*relay.*line add/i);
  });

  // Falling back to the public default for a missing relay would silently
  // address the line at the wrong tenant.
  it("does not silently fall back to the public relay when relay is missing", () => {
    const l = getLinePaths(m, "norelay");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ org: "acme", handle: "ken", token: "secret" }));
    expect(() => loadLineConfig(l)).toThrow(/corrupt config\.json.*relay.*line add/i);
  });

  // Deliberately the opposite of a missing relay: a syntactically broken one
  // still LOADS, so `doctor` and `line list` can name it per line instead of
  // one typo making the line unreportable. See LineConfigSchema's comment.
  it("loads a syntactically invalid relay so it can be diagnosed per line", () => {
    const l = getLinePaths(m, "badrelay");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ ...cfg, relay: "not a url" }));
    expect(loadLineConfig(l).relay).toBe("not a url");
  });

  it("writes only fields owned by the current line schema", () => {
    const l = getLinePaths(m, "future");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ ...cfg, future_option: true }));
    saveLineConfig(l, loadLineConfig(l));
    expect(JSON.parse(readFileSync(l.configFile, "utf8"))).not.toHaveProperty("future_option");
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

  it("rejects a non-regular config before attempting to read it", () => {
    const l = getLinePaths(m, "nonregular");
    mkdirSync(l.configFile, { recursive: true });
    expect(() => loadLineConfig(l)).toThrow(/regular file/);
  });

  it("reports a symlinked line directory instead of silently omitting it", () => {
    const target = getLinePaths(m, "target");
    saveLineConfig(target, cfg);
    symlinkSync(target.dir, getLinePaths(m, "linked").dir);

    const linked = listLines(m).find((line) => line.name === "linked");

    expect(linked).toMatchObject({ ok: false });
    expect(linked?.error).toMatch(/real directory, not a symlink/);
  });

  it("ignores files and invalid names sitting in linesDir", () => {
    writeFileSync(join(m.linesDir, "stray.txt"), "x");
    mkdirSync(join(m.linesDir, "Bad Name"), { recursive: true });
    expect(listLines(m)).toEqual([]);
  });
});
