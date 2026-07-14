import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Paths } from "./paths.js";

// Shape verified against the installed @anthropic-ai/sandbox-runtime README
// (`npm view @anthropic-ai/sandbox-runtime readme`): settings are flat
// top-level `filesystem` / `network` objects, not nested under a
// `permissions` key.
//
// Two things below aren't from the README — they're from actually running
// the installed @anthropic-ai/sandbox-runtime@1.0.0 against real settings
// files (`npx -y @anthropic-ai/sandbox-runtime --settings <file> -- <cmd>`):
//
// 1. `network.deniedDomains` is REQUIRED by the package's own schema
//    validation, even though the README's example shows a config without
//    explaining that. Omitting it makes srt refuse to start at all
//    ("network.deniedDomains: Required") — every sandboxed spawn would
//    fail closed before running claude/codex at all. Must always include it
//    (empty array is fine; we don't need a denylist on top of an allowlist).
//
// 2. `denyWrite` is a silent no-op for a path that doesn't already exist
//    on disk when the sandbox starts — `mkdir -p` and `echo > file` both
//    succeeded against a denyWrite-listed path in testing, because the deny
//    rule apparently only binds to *existing* filesystem objects, not to
//    "creating something new with this name". Confirmed on both files and
//    directories, and this matters here: `~/.claude/agents` doesn't exist
//    on a stock Claude Code install until the user creates a custom agent,
//    so without ensureDenyWriteTargetsExist() below, a hostile prompt could
//    just *create* `~/.claude/agents/evil.md` instead of overwriting an
//    existing file, and denyWrite would never even see it as protected.
//
// Reads are allow-by-default in srt (only `denyRead` regions are blocked;
// anything not covered by a deny region stays readable) — so denying a
// handful of dotfiles would still leave the rest of $HOME (browser
// profiles, other repos' .env files, etc.) readable by the sandboxed
// agent, which could then exfiltrate whatever it reads via its reply. We
// flip that to deny-by-default: deny the whole home directory for reads,
// then re-allow only the paths the agent actually needs. `allowRead` takes
// precedence over `denyRead` (per the README, and confirmed in testing), so
// this narrows reads to exactly those paths regardless of what else
// denyRead covers.
//
// Writes are already allow-by-default-deny (nothing writable unless listed
// in allowWrite), but ~/.claude is in that allowlist so `claude -p` can run
// at all — and several paths under it are executable configuration
// surfaces: CLAUDE.md, hooks, plugins, commands, and agents run
// UNsandboxed the next time the real user invokes claude, so a hostile
// agent could use them to persist beyond this one call. `denyWrite` takes
// precedence over `allowWrite` for paths that exist (per the README, and
// confirmed in testing), so we carve those specific paths back out of the
// write allowlist while leaving the rest of ~/.claude (session state,
// caches, etc.) writable.
//
// ~/.claude.json is deliberately NOT in denyWrite. Inspecting the real file
// on this machine shows it isn't a narrow credentials file — it's Claude
// Code's general state blob (numStartups, projects, toolUsage, skillUsage,
// caches, etc.), rewritten on essentially every invocation alongside
// oauthAccount and mcpServers. Blocking writes to it risks breaking
// `claude -p` outright rather than just degrading a security margin; see
// the fix note in task-7-report.md for the mcpServers residual-risk
// tradeoff this leaves open.
export function srtSettings(p: Paths): object {
  return {
    filesystem: {
      denyRead: ["~"],
      allowRead: [p.publicDir, "~/.claude", "~/.claude.json", "/tmp", "/private/tmp", "/var/folders"],
      allowWrite: [p.publicDir, "~/.claude", "~/.claude.json", "/tmp", "/private/tmp", "/var/folders"],
      denyWrite: [
        "~/.claude/settings.json",
        "~/.claude/settings.local.json",
        "~/.claude/CLAUDE.md",
        "~/.claude/hooks",
        "~/.claude/plugins",
        "~/.claude/commands",
        "~/.claude/agents",
      ],
    },
    network: {
      allowedDomains: ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io", "claude.ai"],
      deniedDomains: [],
    },
  };
}

const DENY_WRITE_DIRS = ["hooks", "plugins", "commands", "agents"];
const DENY_WRITE_FILES = ["settings.json", "settings.local.json", "CLAUDE.md"];

// Must be called once before spawning a sandboxed agent (see srtSettings'
// point 2 above): pre-creates each denyWrite target under ~/.claude that
// doesn't already exist, so srt's deny rule actually has something to
// bind to instead of silently letting a create-new-file slip through.
// Idempotent and harmless if the paths already have real content — it
// only ever creates, never overwrites. `home` is overridable for tests;
// production callers should leave it as the real home directory, since
// this always targets the real user's ~/.claude regardless of
// AGENTCALL_HOME (agentcall doesn't get its own claude config).
export function ensureDenyWriteTargetsExist(home: string = homedir()): void {
  const claudeDir = join(home, ".claude");
  for (const rel of DENY_WRITE_DIRS) {
    const dir = join(claudeDir, rel);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  for (const rel of DENY_WRITE_FILES) {
    const file = join(claudeDir, rel);
    if (existsSync(file)) continue;
    mkdirSync(claudeDir, { recursive: true });
    // settings.json / settings.local.json are parsed as JSON by claude on
    // startup; an empty file would fail to parse, so seed valid empty JSON.
    // CLAUDE.md is freeform markdown, so an empty file is safe as-is.
    writeFileSync(file, rel.endsWith(".json") ? "{}\n" : "");
  }
}
