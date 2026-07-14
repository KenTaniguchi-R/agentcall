import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDenyWriteTargetsExist, srtSettings } from "../src/srt.js";
import { getPaths } from "../src/paths.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-srt-test-")); }

describe("srtSettings", () => {
  it("includes network.deniedDomains, required by the installed sandbox-runtime's own schema", () => {
    // Confirmed against the real package (`npx -y @anthropic-ai/sandbox-runtime
    // --settings ... `): omitting deniedDomains makes srt refuse to start
    // ("network.deniedDomains: Required"), so every sandboxed agent spawn
    // would fail closed. This isn't documented in the README's example.
    const settings = srtSettings(getPaths("/tmp/fakehome")) as any;
    expect(settings.network.deniedDomains).toEqual([]);
  });

  it("denies reads broadly and re-allows only the paths the agent needs", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome")) as any;
    expect(settings.filesystem.denyRead).toEqual(["~"]);
    expect(settings.filesystem.allowRead).toContain("~/.claude");
    expect(settings.filesystem.allowRead).toContain("~/.claude.json");
  });

  it("denies writes to executable claude config surfaces but not to ~/.claude.json", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome")) as any;
    expect(settings.filesystem.denyWrite).toEqual(
      expect.arrayContaining(["~/.claude/settings.json", "~/.claude/CLAUDE.md", "~/.claude/hooks",
        "~/.claude/plugins", "~/.claude/commands", "~/.claude/agents"]),
    );
    // See srt.ts comment: ~/.claude.json is Claude Code's general state
    // blob (rewritten on nearly every invocation), not a narrow
    // credentials file — denying it risks breaking claude -p outright.
    expect(settings.filesystem.denyWrite).not.toContain("~/.claude.json");
  });
});

describe("ensureDenyWriteTargetsExist", () => {
  it("creates missing denyWrite dirs and seeds missing files with parseable content", () => {
    const home = tempHome();
    ensureDenyWriteTargetsExist(home);
    expect(existsSync(join(home, ".claude", "hooks"))).toBe(true);
    expect(existsSync(join(home, ".claude", "plugins"))).toBe(true);
    expect(existsSync(join(home, ".claude", "commands"))).toBe(true);
    expect(existsSync(join(home, ".claude", "agents"))).toBe(true);
    expect(statSync(join(home, ".claude", "agents")).isDirectory()).toBe(true);
    // JSON files get valid empty JSON, not a 0-byte file that would fail
    // to parse on claude's next startup.
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.local.json"), "utf8"))).toEqual({});
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("never overwrites files or dirs that already exist", () => {
    const home = tempHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), '{"real":"config"}');
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# real instructions\n");
    mkdirSync(join(claudeDir, "agents"), { recursive: true });
    writeFileSync(join(claudeDir, "agents", "existing-agent.md"), "real agent");

    ensureDenyWriteTargetsExist(home);

    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe('{"real":"config"}');
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toBe("# real instructions\n");
    expect(readFileSync(join(claudeDir, "agents", "existing-agent.md"), "utf8")).toBe("real agent");
    rmSync(home, { recursive: true, force: true });
  });
});
