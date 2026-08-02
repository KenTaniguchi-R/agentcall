import { describe, expect, it, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { loadPerson, savePerson } from "../src/person.js";
import {
  addLine as addLineImpl, listLinesReport,
  removeLine as removeLineImpl, setPrimary,
  type AddLineOpts, type RemoveLineOpts,
} from "../src/commands/line.js";

// addLine/removeLine fall back to the real installLaunchAgent/
// uninstallLaunchAgent whenever a test omits its opts seam
// (installLaunchAgentFn/uninstallFn/installFn) — and the real ones shell out
// to the actual `launchctl bootstrap`/`bootout` on whoever's machine runs
// this suite, regardless of how sandboxed MachinePaths.userHome is (the
// launchd *session* is the real logged-in user's; only the plist file path
// is sandboxed). That already happened once while writing this file: it
// booted out the developer's real listener and replaced it with one
// pointing at a since-deleted tmp dir. Mocking the module here turns a
// missing seam into an immediate, loud test failure instead of a silent
// real-system side effect — every test below must pass its own no-op.
vi.mock("../src/launchd.js", () => ({
  installLaunchAgent: () => {
    throw new Error("real installLaunchAgent reached in a test — pass installLaunchAgentFn/installFn");
  },
  uninstallLaunchAgent: () => {
    throw new Error("real uninstallLaunchAgent reached in a test — pass uninstallFn");
  },
}));

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-linecmd-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const ok = async () => ({ token: "tok", address: "ken-cdx@r.example" });
const base = { handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

// launchPathDirs (addLine's/removeLine's extraPathDirs default — see
// launchPath.ts) falls back to the real `which` via defaultResolveBin
// whenever resolveBin/extraPathDirs is omitted, and it's evaluated eagerly
// as an argument expression, so it runs even when installLaunchAgentFn/
// installFn is a total no-op. These wrappers default resolveBin to a
// deterministic no-op so no test below shells out by accident; the two
// tests that assert on the derivation itself pass their own resolveBin,
// which overrides this default.
const noNetworkResolveBin = () => null;
function addLine(m: MachinePaths, opts: AddLineOpts): ReturnType<typeof addLineImpl> {
  return addLineImpl(m, { resolveBin: noNetworkResolveBin, ...opts });
}
function removeLine(m: MachinePaths, name: string, opts: RemoveLineOpts = {}): void {
  removeLineImpl(m, name, { resolveBin: noNetworkResolveBin, ...opts });
}

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
    let called = false;
    await expect(addLine(m, { name: "codex", handle: "other", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { token: "t", address: "a" }; },
      installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already/);
    expect(called).toBe(false);
  });

  it("refuses a handle another line already holds", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken-cdx" });
    let called = false;
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { token: "t", address: "a" }; },
      installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/ken-cdx/);
    expect(called).toBe(false);
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

  // Regression: a nvm/fnm-managed node install (or claude/npx living outside
  // /opt/homebrew/bin and /usr/local/bin) needs its dir on the LaunchAgent's
  // PATH, or the supervised listener can't find its own agent binary at
  // spawn time. setup used to compute this and pass it straight through;
  // addLine must accept and forward it too, or every line loses the fix.
  it("forwards extraPathDirs into the installLaunchAgent seam", async () => {
    let captured: string[] | undefined;
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, publishCardFn: async () => undefined, verify: false,
      extraPathDirs: ["/Users/x/.nvm/versions/node/v24/bin"],
      installLaunchAgentFn: (_m, _execCmd, extraPathDirs) => { captured = extraPathDirs; } });
    expect(captured).toEqual(["/Users/x/.nvm/versions/node/v24/bin"]);
  });

  // The motivating case for this whole feature: claude on one line, codex on
  // another. When extraPathDirs isn't explicitly given, addLine must derive
  // it from EVERY ready line on the machine (via launchPathDirs), not just
  // the one it's currently adding — otherwise the shared plist only ever
  // learns about whichever agent's line was created/reinstalled most
  // recently.
  it("derives extraPathDirs from every ready line's agent kind, not just the one being added", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, agent_kind: "claude" });
    let captured: string[] | undefined;
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, publishCardFn: async () => undefined, verify: false,
      resolveBin: (name) =>
        name === "claude" ? "/opt/claude-dir/claude"
        : name === "codex" ? "/opt/codex-dir/codex"
        : name === "npx" ? "/opt/npx-dir/npx"
        : null,
      installLaunchAgentFn: (_m, _execCmd, extraPathDirs) => { captured = extraPathDirs; } });
    expect(captured?.slice().sort()).toEqual(["/opt/claude-dir", "/opt/codex-dir", "/opt/npx-dir"].sort());
  });
});

describe("removeLine", () => {
  it("archives the line rather than deleting it, preserving calls.log", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    const callsLogContent = "2026-08-01T00:00:00Z inbound from mia: hello\n";
    writeFileSync(getLinePaths(m, "codex").callsLog, callsLogContent);
    removeLine(m, "codex", { confirm: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(getLinePaths(m, "codex").dir)).toBe(false);
    const archivedName = readdirSync(m.removedDir)[0]!;
    expect(archivedName).toMatch(/^codex-/);
    // The archive exists to preserve the audit trail of what this address
    // disclosed — prove it actually does, not just that a directory moved.
    expect(readFileSync(join(m.removedDir, archivedName, "calls.log"), "utf8")).toBe(callsLogContent);
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

  it("refuses the only usable line even when a stray orphaned directory exists", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    savePerson(m, { primary_line: "claude" });
    // Raw directory count is 2 (claude + the orphan), but only claude is
    // usable — removing it would still leave zero lines that can answer or
    // call, so the guard must trip on usable count, not directory count.
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/uninstall --purge/);
  });

  // Regression: the reinstall branch used to call installLaunchAgent(m) with
  // no extraPathDirs at all, which rewrites the plist with an EMPTY PATH —
  // clobbering the surviving line's agent dir, not just failing to add the
  // removed one's. By the time this branch runs, the removed line's
  // directory is already gone, so launchPathDirs(m) here must reflect only
  // what's left.
  it("reinstall derives extraPathDirs from the surviving line, not an empty list", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, agent_kind: "claude" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx", agent_kind: "codex" });
    savePerson(m, { primary_line: "claude" });
    let captured: string[] | undefined;
    removeLine(m, "codex", {
      confirm: true,
      uninstallFn: () => {},
      installFn: (_m, _execCmd, extraPathDirs) => { captured = extraPathDirs; },
      // codex resolves to a real dir too, not null — if launchPathDirs ran
      // BEFORE the archive (i.e. against a machine state that still has
      // codex), codex's dir would leak into the result and this assertion
      // would fail. A resolveBin that only resolves the survivor would let
      // "not empty" pass regardless of ordering; this pins "survivors only".
      resolveBin: (name) =>
        name === "claude" ? "/opt/claude-dir/claude"
        : name === "codex" ? "/opt/codex-dir/codex"
        : name === "npx" ? "/opt/npx-dir/npx"
        : null,
    });
    expect(captured).toEqual(["/opt/claude-dir", "/opt/npx-dir"]);
  });
});

describe("listLinesReport", () => {
  it("lists a line with an unparseable relay instead of throwing, alongside a healthy one", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "broken"), { ...base, handle: "ken-b", relay: "not-a-url" });
    savePerson(m, { primary_line: "claude" });
    const rows = listLinesReport(m);
    expect(rows.map((r) => r.name)).toEqual(["broken", "claude"]);
    expect(rows.find((r) => r.name === "broken")!.address).toBe("ken-b@not-a-url");
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
