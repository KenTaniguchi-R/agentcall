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

  // "tasks" and "public" are otherwise well-formed names, but a line's
  // authored content lives at ~/AgentCall/<line>/{tasks,public} and the
  // guard denies the legacy ~/AgentCall/tasks path wholesale — a line named
  // "tasks" would nest its own tasks dir inside a denied root and fail
  // every call silently. "doctor-probe" is reserved for an unrelated
  // reason — it's verify.ts's GUARD_PROBE_LINE, the synthetic line name
  // every doctor/setup verification spawn runs under. See the comment on
  // RESERVED_LINE_NAMES in lineName.ts.
  it.each(["tasks", "public", "doctor-probe"])("rejects the reserved name %j", (name) => {
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

  // Re-homed from main's config.test.ts, where it covered loadConfig. `org`
  // moved onto the LINE with the rest of the tenant identity, so this is now
  // loadLineConfig's job. The message must stay distinct from the generic
  // "corrupt config.json" one: `org` cannot be recovered locally, so the only
  // useful instruction is to re-enroll against an invite.
  it("rejects a line config without an organization, pointing at re-enrollment", () => {
    const l = getLinePaths(m, "preorg");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ handle: "ken", token: "old", relay: "https://relay.example" }));
    expect(() => loadLineConfig(l)).toThrow(/no organization.*line add.*--invite/i);
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

  // An older CLI reading, updating, and saving a config written by a newer
  // release must not silently drop the fields it doesn't know about.
  it("preserves unknown fields across a load and save", () => {
    const l = getLinePaths(m, "future");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ ...cfg, future_option: true }));
    saveLineConfig(l, loadLineConfig(l));
    expect(JSON.parse(readFileSync(l.configFile, "utf8"))).toMatchObject({ future_option: true });
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
