import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchPathDirs, resolveExtraPathDirs } from "../src/launchPath.js";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import type { LineConfig } from "../src/config.js";

function newMachine(): MachinePaths {
  const root = mkdtempSync(join(tmpdir(), "agentcall-launchpath-"));
  return getMachinePaths(root, root);
}

const base: LineConfig = { org: "acme", handle: "ken", token: "t", relay: "https://r.example" };

describe("resolveExtraPathDirs", () => {
  it("returns unique dirnames of resolved bins, skipping unresolved ones", () => {
    const resolveBin = (name: string) =>
      name === "claude" ? "/Users/x/.local/bin/claude" : name === "npx" ? "/Users/x/.local/bin/npx" : null;
    expect(resolveExtraPathDirs(["claude", "npx"], resolveBin)).toEqual(["/Users/x/.local/bin"]);
  });
  it("falls back to [] when nothing resolves", () => {
    expect(resolveExtraPathDirs(["claude", "npx"], () => null)).toEqual([]);
  });
  it("excludes ephemeral temp dirs so session-scoped shims never get baked into the plist PATH", () => {
    // Regression: setup run inside a cmux session resolved `claude` to a shim
    // under $TMPDIR/cmux-cli-shims/<uuid>/; that dir got written into the
    // LaunchAgent's PATH and shadowed the real binary after the session died.
    const resolveBin = (name: string) =>
      name === "claude"
        ? "/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude"
        : name === "npx"
          ? "/Users/x/.local/bin/npx"
          : null;
    expect(resolveExtraPathDirs(["claude", "npx"], resolveBin)).toEqual(["/Users/x/.local/bin"]);
  });
});

describe("launchPathDirs", () => {
  // The motivating case: claude on one line, codex on another. A per-caller
  // computation (setup's old approach, scoped to whichever line it happened
  // to be creating) drops one of these; this derives from every ready line
  // on the machine, so both are always present regardless of which line
  // triggered the (re)install.
  it("collects distinct agent kinds across every ready line, plus npx", () => {
    const m = newMachine();
    saveLineConfig(getLinePaths(m, "claude"), { ...base, agent_kind: "claude" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx", agent_kind: "codex" });
    const resolveBin = (name: string) =>
      name === "claude" ? "/opt/claude-dir/claude"
      : name === "codex" ? "/opt/codex-dir/codex"
      : name === "npx" ? "/opt/npx-dir/npx"
      : null;
    expect([...launchPathDirs(m, resolveBin)].sort()).toEqual(
      ["/opt/claude-dir", "/opt/codex-dir", "/opt/npx-dir"].sort(),
    );
  });

  it("ignores caller-only lines (no agent_kind) but still resolves npx", () => {
    const m = newMachine();
    saveLineConfig(getLinePaths(m, "caller"), { ...base }); // no agent_kind
    const resolveBin = (name: string) => (name === "npx" ? "/opt/npx-dir/npx" : null);
    expect(launchPathDirs(m, resolveBin)).toEqual(["/opt/npx-dir"]);
  });

  it("returns [] when nothing resolves, even with no lines at all", () => {
    const m = newMachine();
    expect(launchPathDirs(m, () => null)).toEqual([]);
  });

  it("dedupes when two lines share an agent kind", () => {
    const m = newMachine();
    saveLineConfig(getLinePaths(m, "claude1"), { ...base, agent_kind: "claude" });
    saveLineConfig(getLinePaths(m, "claude2"), { ...base, handle: "ken2", agent_kind: "claude" });
    const resolveBin = (name: string) => (name === "claude" ? "/opt/claude-dir/claude" : null);
    expect(launchPathDirs(m, resolveBin)).toEqual(["/opt/claude-dir"]);
  });

  it("defaults resolveBin to the real bin lookup when none is given", () => {
    // Not asserting a specific value (that depends on the machine running
    // this test) — just that it runs without a resolveBin argument and
    // returns an array, proving the default parameter is wired up.
    const m = newMachine();
    expect(Array.isArray(launchPathDirs(m))).toBe(true);
  });
});
