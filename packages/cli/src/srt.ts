import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import type { Paths } from "./paths.js";
import { FULL_ACCESS_ENVELOPE, type Envelope } from "./tasks.js";

// Shape verified against the installed @anthropic-ai/sandbox-runtime README
// (`npm view @anthropic-ai/sandbox-runtime readme`): settings are flat
// top-level `filesystem` / `network` objects, not nested under a
// `permissions` key.
//
// Two things below aren't from the README — they're from actually running
// the installed @anthropic-ai/sandbox-runtime@0.0.65 against real settings
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
// `claude -p` outright rather than just degrading a security margin — the
// residual risk this leaves open is that a hostile prompt could rewrite the
// mcpServers block in that file to register a malicious MCP server, which
// would then run unsandboxed the next time the real user invokes claude.
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

// Per-agent home config dir + persistence-surface carve-outs (see the
// denyWrite rationale above the ALLOWED_DOMAINS comment block), collapsed
// into one table per agent kind. Each `protected` entry drives BOTH the
// srtSettings denyWrite list (below) AND the create-if-missing targets in
// ensureDenyWriteTargetsExist — a single source of truth so the two can
// never drift apart. Files whose content must be valid JSON on the agent's
// next startup are marked `json: true` and seeded with "{}\n"; everything
// else (markdown/toml instructions, or directories) needs no seeding.
//
// ~/.codex mirrors ~/.claude: config.toml (mcp_servers/hooks config) and
// AGENTS.md/AGENTS.override.md (instructions read on the next unsandboxed
// invocation, with the override file taking priority) are codex's analogues
// of settings.json/CLAUDE.md, hooks.json is an explicit lifecycle-hook
// definition file, and plugins/skills/prompts are extension points (prompts
// holds codex's custom slash-command definitions, the analogue of claude's
// commands dir) — all denyWrite'd. auth.json, sessions/, and the sqlite
// state/log/cache files are left writable: like ~/.claude.json, they're
// rewritten on nearly every invocation, so denying them risks breaking
// `codex exec` outright rather than just degrading a security margin.
interface ProtectedEntry { rel: string; isDir: boolean; json?: boolean }
interface AgentHome { dotDir: string; extraAllow: string[]; protected: ProtectedEntry[] }

const AGENT_HOME: Record<"claude" | "codex", AgentHome> = {
  claude: {
    dotDir: ".claude",
    extraAllow: ["~/.claude.json"],
    protected: [
      { rel: "settings.json", isDir: false, json: true },
      { rel: "settings.local.json", isDir: false, json: true },
      { rel: "CLAUDE.md", isDir: false },
      { rel: "hooks", isDir: true },
      { rel: "plugins", isDir: true },
      { rel: "commands", isDir: true },
      { rel: "agents", isDir: true },
      { rel: "skills", isDir: true },
    ],
  },
  codex: {
    dotDir: ".codex",
    extraAllow: [],
    protected: [
      { rel: "config.toml", isDir: false },
      { rel: "AGENTS.md", isDir: false },
      { rel: "AGENTS.override.md", isDir: false },
      { rel: "hooks.json", isDir: false, json: true },
      { rel: "plugins", isDir: true },
      { rel: "skills", isDir: true },
      { rel: "prompts", isDir: true },
    ],
  },
};

export function srtSettings(
  p: Paths, agentKind: "claude" | "codex", extraReadDirs: string[] = [], envelope: Envelope = FULL_ACCESS_ENVELOPE,
): object {
  const home = AGENT_HOME[agentKind];
  const homeDir = "~/" + home.dotDir;
  // Task envelopes name their writable dirs relative to ~/AgentCall
  // ("public" -> p.publicDir). WRITE_PATH_RE in tasks.ts forbids "." so
  // traversal outside ~/AgentCall cannot be expressed.
  const taskWriteDirs = envelope.write_paths.map((wp) => join(p.home, "AgentCall", wp));
  return {
    filesystem: {
      denyRead: ["~"],
      allowRead: [
        ...new Set([p.publicDir, homeDir, ...home.extraAllow, "/tmp", "/private/tmp", "/var/folders", ...extraReadDirs]),
      ],
      allowWrite: [...taskWriteDirs, homeDir, ...home.extraAllow, "/tmp", "/private/tmp", "/var/folders"],
      denyWrite: home.protected.map((e) => `~/${home.dotDir}/${e.rel}`),
    },
    network: {
      allowedDomains: [...ALLOWED_DOMAINS[agentKind], ...envelope.network],
      deniedDomains: [],
    },
  };
}

// Must be called once before spawning a sandboxed agent (see srtSettings'
// point 2 above): pre-creates each denyWrite target under the agent's home
// config dir that doesn't already exist, so srt's deny rule actually has
// something to bind to instead of silently letting a create-new-file slip
// through. Idempotent and harmless if the paths already have real content
// — it only ever creates, never overwrites. `home` is overridable for
// tests; production callers should leave it as the real home directory,
// since this always targets the real user's ~/.claude or ~/.codex
// regardless of AGENTCALL_HOME (agentcall doesn't get its own agent
// config).
export function ensureDenyWriteTargetsExist(agentKind: "claude" | "codex", home: string = homedir()): void {
  const { dotDir, protected: entries } = AGENT_HOME[agentKind];
  const agentDir = join(home, dotDir);
  for (const e of entries) {
    const target = join(agentDir, e.rel);
    if (e.isDir) {
      if (!existsSync(target)) mkdirSync(target, { recursive: true });
      continue;
    }
    if (existsSync(target)) continue;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(target, e.json ? "{}\n" : "");
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
// Roots whose contents don't survive the session that created them. A dir
// under any of these must never be treated as the preferred resolution of a
// PATH search: terminal wrappers (e.g. cmux) plant per-session bin shims in
// $TMPDIR that shadow the real agent binary, then vanish — or worse, linger
// and exec a wrapper for a dead session. /var/folders and /tmp are listed
// alongside os.tmpdir() (and in /private-prefixed form, their macOS
// realpath) because the per-user temp tree differs per machine.
const EPHEMERAL_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

export function isEphemeralDir(dir: string): boolean {
  const normalized = resolve(dir);
  return EPHEMERAL_ROOTS.some((root) => normalized === root || normalized.startsWith(root + "/"));
}

// First candidate whose dir survives the current session; falls back to the
// first match (better a warning-producing shim than claiming the binary
// doesn't exist at all) and null when there are no candidates.
export function preferDurableBin(candidates: string[]): string | null {
  return candidates.find((c) => !isEphemeralDir(dirname(c))) ?? candidates[0] ?? null;
}

// which()-style PATH search, resolving every match's real (symlink-
// followed) absolute path, then preferring a durable install (see
// preferDurableBin/EPHEMERAL_ROOTS above) over an ephemeral per-session
// shim that happens to sit earlier on PATH — e.g. a cmux session's
// $TMPDIR/cmux-cli-shims/<uuid>/claude, which fails with exit 127 once the
// session that created it is gone. Falls back to the first match when every
// candidate is ephemeral. Returns null rather than throwing so callers that
// only *want* an optional extra read dir (e.g. npx) can skip it.
function resolveOnPath(name: string, pathEnv: string): string | null {
  const matches: string[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      matches.push(realpathSync(candidate));
    } catch {
      continue;
    }
  }
  return preferDurableBin(matches);
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

// Recomputes srtSettings with the current toolchain's read dirs, so a
// node/npm-manager upgrade or reinstall since `setup` doesn't leave a stale
// allowlist that denies the sandboxed process its own binary.
function srtBody(p: Paths, agentKind: "claude" | "codex", envelope: Envelope): string {
  return JSON.stringify(srtSettings(p, agentKind, toolchainReadDirs(agentKind), envelope), null, 2) + "\n";
}

// Writes the shared, user-inspectable ~/.agentcall/srt.json. This is a record
// of the sandbox config, NOT what any live call enforces — see
// writeCallSrtSettings below for why those are now separate.
export function writeSrtSettings(p: Paths, agentKind: "claude" | "codex", envelope: Envelope = FULL_ACCESS_ENVELOPE): void {
  writeFileSync(p.srtFile, srtBody(p, agentKind, envelope));
}

export interface CallSrtSettings {
  /** Settings path to hand srt for exactly one spawn. */
  file: string;
  /** Removes the per-call file and its directory. Idempotent. */
  cleanup(): void;
}

// The settings srt actually enforces for ONE spawn, written to a private
// temp dir that no other process knows the name of.
//
// srt.json can't play that role: it's one machine-global path, but an
// envelope is per-call, and `agentcall setup` (which writes it with the
// full-access default) and `agentcall doctor` both write it from their own
// processes — potentially in the window between the listener writing srt.json
// for a narrow task and srt actually reading it. A private per-call copy
// closes that window, and makes the design safe if the listener's serial
// queue ever runs more than one call at a time, where a shared file would
// mean one call's envelope silently governing another's.
//
// srt.json is still refreshed with the same content so `agentcall doctor` and
// a curious owner can see the current shape of the sandbox; that write is
// best-effort because it is now purely informational — a read-only
// ~/.agentcall must not be able to fail a call.
export function writeCallSrtSettings(
  p: Paths, agentKind: "claude" | "codex", envelope: Envelope = FULL_ACCESS_ENVELOPE,
): CallSrtSettings {
  const body = srtBody(p, agentKind, envelope);
  const dir = mkdtempSync(join(tmpdir(), "agentcall-srt-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, body, { mode: 0o600 });
  try {
    writeFileSync(p.srtFile, body);
  } catch {
    /* reference copy only — never fail a call over it */
  }
  return {
    file,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
  };
}
