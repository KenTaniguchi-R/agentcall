import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureDenyWriteTargetsExist, resolveAgentBin, srtSettings, toolchainReadDirs, writeSrtSettings,
} from "../src/srt.js";
import { getPaths } from "../src/paths.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-srt-test-")); }

describe("srtSettings", () => {
  it("includes network.deniedDomains, required by the installed sandbox-runtime's own schema", () => {
    // Confirmed against the real package (`npx -y @anthropic-ai/sandbox-runtime
    // --settings ... `): omitting deniedDomains makes srt refuse to start
    // ("network.deniedDomains: Required"), so every sandboxed agent spawn
    // would fail closed. This isn't documented in the README's example.
    const settings = srtSettings(getPaths("/tmp/fakehome"), "claude") as any;
    expect(settings.network.deniedDomains).toEqual([]);
  });

  it("denies reads broadly and re-allows only the paths the agent needs", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome"), "claude") as any;
    expect(settings.filesystem.denyRead).toEqual(["~"]);
    expect(settings.filesystem.allowRead).toContain("~/.claude");
    expect(settings.filesystem.allowRead).toContain("~/.claude.json");
  });

  it("denies writes to executable claude config surfaces but not to ~/.claude.json", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome"), "claude") as any;
    expect(settings.filesystem.denyWrite).toEqual(
      expect.arrayContaining(["~/.claude/settings.json", "~/.claude/CLAUDE.md", "~/.claude/hooks",
        "~/.claude/plugins", "~/.claude/commands", "~/.claude/agents", "~/.claude/skills"]),
    );
    // See srt.ts comment: ~/.claude.json is Claude Code's general state
    // blob (rewritten on nearly every invocation), not a narrow
    // credentials file — denying it risks breaking claude -p outright.
    expect(settings.filesystem.denyWrite).not.toContain("~/.claude.json");
  });

  it("merges extraReadDirs into allowRead without dropping the base deny/allow rules", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome"), "claude", ["/x/.local"]) as any;
    expect(settings.filesystem.allowRead).toContain("/x/.local");
    expect(settings.filesystem.allowRead).toContain("~/.claude");
    expect(settings.filesystem.denyRead).toEqual(["~"]);
    expect(settings.network.deniedDomains).toEqual([]);
  });

  it("allowlists Anthropic domains for claude", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome"), "claude") as any;
    expect(settings.network.allowedDomains).toEqual([
      "api.anthropic.com", "statsig.anthropic.com", "*.sentry.io", "claude.ai",
    ]);
  });

  it("allowlists OpenAI domains for codex, not the claude allowlist", () => {
    // Regression: allowedDomains used to be hardcoded to the claude list
    // regardless of agentKind, so a srt-wrapped codex process could never
    // reach api.openai.com and every codex call failed closed.
    const settings = srtSettings(getPaths("/tmp/fakehome"), "codex") as any;
    expect(settings.network.allowedDomains).toEqual([
      "api.openai.com", "auth.openai.com", "chatgpt.com", "*.sentry.io",
    ]);
    expect(settings.network.allowedDomains).not.toContain("api.anthropic.com");
  });

  it("re-allows ~/.codex for reads/writes for codex, not ~/.claude", () => {
    // Regression: filesystem allow/deny lists used to be hardcoded to
    // ~/.claude regardless of agentKind, so a srt-wrapped codex process
    // could never even read its own config.toml — confirmed live: `agent
    // exited 1: Error loading config.toml: ... Operation not permitted`.
    const settings = srtSettings(getPaths("/tmp/fakehome"), "codex") as any;
    expect(settings.filesystem.allowRead).toContain("~/.codex");
    expect(settings.filesystem.allowWrite).toContain("~/.codex");
    expect(settings.filesystem.allowRead).not.toContain("~/.claude");
  });

  it("denies writes to executable codex config surfaces but not to session/state files", () => {
    const settings = srtSettings(getPaths("/tmp/fakehome"), "codex") as any;
    expect(settings.filesystem.denyWrite).toEqual(
      expect.arrayContaining(["~/.codex/config.toml", "~/.codex/AGENTS.md", "~/.codex/AGENTS.override.md",
        "~/.codex/hooks.json", "~/.codex/plugins", "~/.codex/skills", "~/.codex/prompts"]),
    );
    // auth.json, sessions/, sqlite state, etc. are rewritten on nearly
    // every invocation (same rationale as ~/.claude.json) — denying them
    // risks breaking `codex exec` outright rather than just degrading a
    // security margin.
    expect(settings.filesystem.denyWrite).not.toContain("~/.codex/auth.json");
  });
});

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
});

describe("toolchainReadDirs", () => {
  it("includes the dir containing the running node binary", () => {
    const dirs = toolchainReadDirs("claude", "/no-such-home", { PATH: "" });
    expect(dirs).toContain(dirname(realpathSync(process.execPath)));
  });

  it("adds both the bin dir and the home-level install root for a toolchain living under home", () => {
    const home = tempHome();
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "npx"), "#!/bin/sh\necho fake npx\n");
    const dirs = toolchainReadDirs("claude", home, { PATH: binDir });
    // Compared via realpath, not the raw joined path: on macOS, os.tmpdir()
    // (what tempHome() is built from) is itself a symlink into /private, and
    // toolchainReadDirs resolves everything through fs.realpathSync.
    expect(dirs).toContain(dirname(realpathSync(join(binDir, "npx"))));
    expect(dirs).toContain(join(home, ".local"));
    rmSync(home, { recursive: true, force: true });
  });

  it("dedupes and drops entries that fail to resolve", () => {
    const dirs = toolchainReadDirs("claude", "/no-such-home", { PATH: "" });
    expect(dirs.length).toBe(new Set(dirs).size);
  });
});

describe("writeSrtSettings", () => {
  it("writes srt.json with the current toolchain's read dirs merged into allowRead", () => {
    const home = tempHome();
    const p = getPaths(home);
    mkdirSync(p.dir, { recursive: true });
    writeSrtSettings(p, "claude");
    const written = JSON.parse(readFileSync(p.srtFile, "utf8"));
    expect(written.filesystem.allowRead).toContain(dirname(realpathSync(process.execPath)));
    expect(written.filesystem.denyRead).toEqual(["~"]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("ensureDenyWriteTargetsExist", () => {
  it("creates missing denyWrite dirs and seeds missing files with parseable content", () => {
    const home = tempHome();
    ensureDenyWriteTargetsExist("claude", home);
    expect(existsSync(join(home, ".claude", "hooks"))).toBe(true);
    expect(existsSync(join(home, ".claude", "plugins"))).toBe(true);
    expect(existsSync(join(home, ".claude", "commands"))).toBe(true);
    expect(existsSync(join(home, ".claude", "agents"))).toBe(true);
    expect(statSync(join(home, ".claude", "agents")).isDirectory()).toBe(true);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
    expect(statSync(join(home, ".claude", "skills")).isDirectory()).toBe(true);
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

    ensureDenyWriteTargetsExist("claude", home);

    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe('{"real":"config"}');
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toBe("# real instructions\n");
    expect(readFileSync(join(claudeDir, "agents", "existing-agent.md"), "utf8")).toBe("real agent");
    rmSync(home, { recursive: true, force: true });
  });

  it("creates missing codex denyWrite dirs/files under ~/.codex, not ~/.claude", () => {
    const home = tempHome();
    ensureDenyWriteTargetsExist("codex", home);
    expect(existsSync(join(home, ".codex", "plugins"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))).toEqual({});
    expect(existsSync(join(home, ".codex", "prompts"))).toBe(true);
    expect(statSync(join(home, ".codex", "prompts")).isDirectory()).toBe(true);
    expect(existsSync(join(home, ".codex", "AGENTS.override.md"))).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("single source of truth: denyWrite <-> ensureDenyWriteTargetsExist", () => {
  it.each(["claude", "codex"] as const)(
    "creates exactly the paths that srtSettings denyWrite lists (%s)",
    (kind) => {
      const home = tempHome();
      const settings = srtSettings(getPaths("/tmp/fakehome"), kind) as any;
      const dotDir = join(home, kind === "claude" ? ".claude" : ".codex");
      const expected = new Set(
        (settings.filesystem.denyWrite as string[]).map((rel) => join(home, rel.replace(/^~\//, ""))),
      );

      ensureDenyWriteTargetsExist(kind, home);

      const actual = new Set(readdirSync(dotDir).map((name) => join(dotDir, name)));
      expect(actual).toEqual(expected);
      rmSync(home, { recursive: true, force: true });
    },
  );
});
