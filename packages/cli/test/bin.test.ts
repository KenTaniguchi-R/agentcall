import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isEphemeralDir, preferDurableBin, resolveAgentBin } from "../src/bin.js";

describe("resolveAgentBin", () => {
  it("throws a clear error naming the binary when it isn't on PATH", () => {
    expect(() => resolveAgentBin("claude", { PATH: "" })).toThrow(/claude/i);
  });

  it("returns an absolute, symlink-resolved path when the binary is found on PATH", () => {
    // "node" stands in for a real agent binary: same PATH-search + realpath
    // logic, and guaranteed to exist on PATH wherever this suite runs.
    const resolved = resolveAgentBin("node" as unknown as "claude" | "codex");
    expect(isAbsolute(resolved)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  // Regression: a cmux (or similar terminal wrapper) session plants an
  // ephemeral per-session shim (e.g. $TMPDIR/cmux-cli-shims/<uuid>/claude)
  // ahead of the real, durable install on PATH. resolveOnPath used to return
  // the FIRST PATH match, so the runner spawned the shim — which fails with
  // exit 127 once the session that created it is gone (confirmed live via
  // `which -a claude`). See setup.ts's resolveExtraPathDirs, which needs the
  // same durable-vs-ephemeral logic when widening the LaunchAgent's PATH.
  describe("prefers durable installs over ephemeral session shims", () => {
    function makeFakeBin(dir: string, name: string): string {
      mkdirSync(dir, { recursive: true });
      const target = join(dir, name);
      writeFileSync(target, "#!/bin/sh\necho fake\n");
      return target;
    }

    // A durable, non-tmp dir inside the worktree (not os.tmpdir(), which on
    // macOS resolves under /var/folders and would itself count as
    // ephemeral) — created for this test and removed afterward.
    const durableDir = join(
      dirname(fileURLToPath(import.meta.url)), "..", ".tmp", `bin-${process.pid}-durable`,
    );
    const ephemeralDir = join(tmpdir(), "cmux-cli-shims", `${process.pid}-ephemeral`);

    it("skips an ephemeral shim earlier on PATH for a durable install later on PATH", () => {
      try {
        const durableBin = makeFakeBin(durableDir, "claude");
        makeFakeBin(ephemeralDir, "claude");
        const pathEnv = [ephemeralDir, durableDir].join(delimiter);
        expect(resolveAgentBin("claude", { PATH: pathEnv })).toBe(realpathSync(durableBin));
      } finally {
        rmSync(durableDir, { recursive: true, force: true });
        rmSync(ephemeralDir, { recursive: true, force: true });
      }
    });

    it("falls back to the ephemeral shim when it's the only candidate on PATH", () => {
      try {
        const ephemeralBin = makeFakeBin(ephemeralDir, "claude");
        expect(resolveAgentBin("claude", { PATH: ephemeralDir })).toBe(realpathSync(ephemeralBin));
      } finally {
        rmSync(ephemeralDir, { recursive: true, force: true });
      }
    });
  });
});

describe("isEphemeralDir", () => {
  it("flags dirs under the OS temp root and the macOS per-user temp tree", () => {
    expect(isEphemeralDir(join(tmpdir(), "cmux-cli-shims", "AA8B8E91"))).toBe(true);
    expect(isEphemeralDir("/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91")).toBe(true);
    expect(isEphemeralDir("/private/var/folders/89/xx/T/anything")).toBe(true);
    expect(isEphemeralDir("/tmp/some-bin")).toBe(true);
    expect(isEphemeralDir("/private/tmp/some-bin")).toBe(true);
  });
  it("leaves durable install dirs alone", () => {
    expect(isEphemeralDir("/Users/x/.local/bin")).toBe(false);
    expect(isEphemeralDir("/opt/homebrew/bin")).toBe(false);
    expect(isEphemeralDir("/usr/local/bin")).toBe(false);
    // "/tmpfoo" must not match a "/tmp" prefix check done without a separator
    expect(isEphemeralDir("/tmpfoo/bin")).toBe(false);
  });
});

describe("preferDurableBin", () => {
  it("skips ephemeral matches and returns the first durable one", () => {
    expect(
      preferDurableBin([
        "/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude",
        "/Users/x/.local/bin/claude",
      ]),
    ).toBe("/Users/x/.local/bin/claude");
  });
  it("falls back to the first match when every candidate is ephemeral", () => {
    expect(preferDurableBin(["/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude"])).toBe(
      "/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude",
    );
  });
  it("returns null for no candidates", () => {
    expect(preferDurableBin([])).toBe(null);
  });
});
