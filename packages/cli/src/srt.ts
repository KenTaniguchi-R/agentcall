import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
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
// extraReadDirs (see toolchainReadDirs below) widens allowRead with the
// directories the sandboxed process actually needs to *execute* its own
// toolchain (node/npx/claude|codex) — distinct from the fixed dirs below,
// which are what the agent's *work* needs (publicDir, claude state, tmp).
// Network allowlist is agent-kind-specific: claude talks to Anthropic's API,
// codex talks to OpenAI's. This used to be hardcoded to the claude list
// regardless of which agent was being spawned, which meant a srt-wrapped
// codex process could never reach api.openai.com — every codex call failed
// closed with a network error before the model ever saw the prompt.
const ALLOWED_DOMAINS: Record<"claude" | "codex", string[]> = {
  claude: ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io", "claude.ai"],
  codex: ["api.openai.com", "auth.openai.com", "chatgpt.com", "*.sentry.io"],
};

export function srtSettings(p: Paths, agentKind: "claude" | "codex", extraReadDirs: string[] = []): object {
  return {
    filesystem: {
      denyRead: ["~"],
      allowRead: [
        ...new Set([p.publicDir, "~/.claude", "~/.claude.json", "/tmp", "/private/tmp", "/var/folders", ...extraReadDirs]),
      ],
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
      allowedDomains: ALLOWED_DOMAINS[agentKind],
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

// --- Toolchain read-access (allowRead) -------------------------------
//
// srtSettings' denyRead:["~"] blocks reads of the *whole* home directory
// by default, re-allowed only via allowRead. That's a problem for a
// toolchain installed under $HOME: on a real machine, `claude -p` was
// found to resolve to ~/.local/bin/claude, and the sandbox denied it with
// "Operation not permitted" until ~/.local was added to allowRead — the
// binary and its runtime support files live under $HOME just like the
// dotfiles denyRead is meant to protect, so the agent couldn't even start.
// This isn't specific to a native install: nvm (~/.nvm), volta (~/.volta),
// fnm (~/.fnm), and bun (~/.bun) all put node/npx/the agent under $HOME
// too. Homebrew installs (/opt/homebrew, /usr/local) fall outside $HOME
// and are already unaffected by denyRead:["~"], so they need no extra
// entry — but toolchainReadDirs adds their bin dir anyway since it's
// harmless and keeps the logic uniform across install methods.
//
// which()-style PATH search, resolving the first match's real (symlink-
// followed) absolute path. Returns null rather than throwing so callers
// that only *want* an optional extra read dir (e.g. npx) can skip it.
function resolveOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

// Resolves the absolute, symlink-followed path to the claude/codex binary
// via a PATH search, throwing a clear error if it can't be found — used by
// buildSpawnSpec (a bare "claude"/"codex" arg fails inside srt's sandboxed
// shell, see runner.ts) and by toolchainReadDirs below. `env` is overridable
// for tests; production callers should leave it as process.env.
export function resolveAgentBin(agentKind: "claude" | "codex", env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveOnPath(agentKind, env.PATH ?? "");
  if (!resolved) {
    throw new Error(
      `Could not find \`${agentKind}\` on PATH. Install it, or make sure it's discoverable via PATH before running agentcall.`,
    );
  }
  return resolved;
}

// If realPath lives under home (e.g. /Users/x/.local/bin/claude with home
// /Users/x), returns the first path segment under home as its own allowRead
// root (e.g. /Users/x/.local) — covering the whole install (support files,
// node_modules, etc.), not just the one resolved binary's directory.
// Returns null for paths outside home (system dirs, homebrew), which don't
// need this treatment since denyRead:["~"] doesn't touch them. home is
// realpath'd before comparison — on macOS, `os.tmpdir()` (used by test temp
// homes) is itself a symlink into /private, so comparing a resolved binary
// path against the unresolved home would silently never match.
function homeInstallRoot(realPath: string, home: string): string | null {
  let resolvedHome: string;
  try {
    resolvedHome = realpathSync(home);
  } catch {
    resolvedHome = home; // home may not exist (e.g. a made-up test path)
  }
  const prefix = resolvedHome.endsWith(sep) ? resolvedHome : resolvedHome + sep;
  if (!realPath.startsWith(prefix)) return null;
  // Root is built from the original (unresolved) `home`, not resolvedHome,
  // so the returned allowRead entry matches the path form callers actually
  // pass around (e.g. os.homedir()'s own return value).
  const firstSegment = realPath.slice(prefix.length).split(sep)[0];
  return firstSegment ? join(home, firstSegment) : null;
}

// Directories to add to srtSettings' allowRead so the sandboxed process can
// execute its own toolchain: node (process.execPath), npx, and the agent
// binary. For each, adds its containing dir plus — if it resolves under
// home — the home-level install root (see homeInstallRoot). Entries that
// fail to resolve are skipped rather than throwing, since a missing npx (for
// example) shouldn't block the agent's own read access; `home`/`env` are
// overridable for tests.
export function toolchainReadDirs(
  agentKind: "claude" | "codex", home: string = homedir(), env: NodeJS.ProcessEnv = process.env,
): string[] {
  let nodePath: string | null;
  try {
    nodePath = realpathSync(process.execPath);
  } catch {
    nodePath = null;
  }
  const npxPath = resolveOnPath("npx", env.PATH ?? "");
  let agentPath: string | null;
  try {
    agentPath = resolveAgentBin(agentKind, env);
  } catch {
    agentPath = null;
  }

  const dirs = new Set<string>();
  for (const resolved of [nodePath, npxPath, agentPath]) {
    if (!resolved) continue;
    dirs.add(dirname(resolved));
    const root = homeInstallRoot(resolved, home);
    if (root) dirs.add(root);
  }
  return [...dirs];
}

// Recomputes srtSettings with the current toolchain's read dirs and writes
// it to p.srtFile. Called from runAgent before every real spawn (not just
// once at `setup` time) so a node/npm-manager upgrade or reinstall since
// setup doesn't leave a stale allowlist that denies the sandboxed process
// its own binary.
export function writeSrtSettings(p: Paths, agentKind: "claude" | "codex"): void {
  writeFileSync(p.srtFile, JSON.stringify(srtSettings(p, agentKind, toolchainReadDirs(agentKind)), null, 2) + "\n");
}
