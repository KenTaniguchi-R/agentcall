import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPaths, type Paths } from "./paths.js";
import { ask as ttyAsk } from "./tty.js";
import { loadConfig, saveConfig, relayUrl, type Config } from "./config.js";
import { registerHandle } from "./api.js";
import { srtSettings, toolchainReadDirs } from "./srt.js";
import { appendSnippet } from "./snippet.js";
import { installLaunchAgent } from "./launchd.js";

// Directories launchd's fixed PATH (see launchd.ts's plistContent) actually
// searches. If claude/codex/npx resolve outside of these, the background
// listener won't find them even though an interactive shell (with nvm/fnm
// on PATH) does.
const LAUNCHD_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface SetupOpts {
  handle?: string;
  agent?: "claude" | "codex";
  yes?: boolean;
  snippet?: boolean;
  relay?: string;
  skipLaunchd?: boolean;
  io?: { ask(question: string): Promise<string> };
  // Test seams — production callers should leave these as the defaults.
  hasBin?: (name: string) => boolean;
  resolveBin?: (name: string) => string | null;
  installLaunchAgentFn?: typeof installLaunchAgent;
}

// Roots whose contents don't survive the session that created them. A dir
// under any of these must never be baked into the LaunchAgent's PATH:
// terminal wrappers (e.g. cmux) plant per-session bin shims in $TMPDIR that
// shadow the real agent binary, then vanish — or worse, linger and exec a
// wrapper for a dead session. /var/folders and /tmp are listed alongside
// os.tmpdir() (and in /private-prefixed form, their macOS realpath) because
// the per-user temp tree differs per machine.
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

// Dirnames of the resolved bins, deduped and skipping any that failed to
// resolve. Used to widen the LaunchAgent's PATH (see launchd.ts) so the
// listener can find an agent/npx install that lives outside its base dirs.
// Ephemeral dirs (see EPHEMERAL_ROOTS) are dropped even if that's where the
// bin resolved — a PATH entry into temp is wrong in a persistent LaunchAgent.
export function resolveExtraPathDirs(names: string[], resolveBin: (name: string) => string | null): string[] {
  const dirs = names
    .map((name) => resolveBin(name))
    .filter((path): path is string => path !== null)
    .map((path) => dirname(path))
    .filter((dir) => !isEphemeralDir(dir));
  return [...new Set(dirs)];
}

function defaultResolveBin(name: string): string | null {
  try {
    const out = execFileSync("which", ["-a", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return preferDurableBin(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

async function detectAgentKind(
  opts: SetupOpts, hasBin: (name: string) => boolean, ask: (q: string) => Promise<string>,
): Promise<"claude" | "codex"> {
  if (opts.agent) {
    if (opts.agent !== "claude" && opts.agent !== "codex") {
      throw new Error(`--agent must be "claude" or "codex", got "${opts.agent}"`);
    }
    return opts.agent;
  }
  const hasClaude = hasBin("claude");
  const hasCodex = hasBin("codex");
  if (hasClaude && !hasCodex) return "claude";
  if (hasCodex && !hasClaude) return "codex";
  if (hasClaude && hasCodex) {
    if (opts.yes) return "claude";
    const answer = (await ask("Both claude and codex found on PATH. Which should agentcall use? [claude/codex]: "))
      .trim()
      .toLowerCase();
    return answer === "codex" ? "codex" : "claude";
  }
  throw new Error(
    "Neither `claude` nor `codex` was found on PATH. Install one of them, or pass --agent to override detection.",
  );
}

export function warnIfOutsideLaunchdPath(name: string, resolveBin: (n: string) => string | null): void {
  const path = resolveBin(name);
  if (!path) return; // already surfaced via detectAgentKind's error, or not required (e.g. npx)
  if (!LAUNCHD_PATH_DIRS.includes(dirname(path))) {
    console.error(
      `Warning: ${name} is outside the background listener's PATH — if calls fail with ` +
        `"command not found", run: ln -s ${path} ${LAUNCHD_PATH_DIRS[0]}/${name}`,
    );
  }
}

// Derives the address a fresh registration would have produced, for reuse's
// sake, without calling the relay: register's response is always
// `${handle}@${host of relay}` (see apps/relay's RELAY_HOST), so a saved
// config's handle + relay is enough to reconstruct it locally.
function addressFromConfig(cfg: Config): string {
  try {
    return `${cfg.handle}@${new URL(cfg.relay).host}`;
  } catch {
    return `${cfg.handle}@${cfg.relay}`;
  }
}

export async function runSetup(opts: SetupOpts): Promise<void> {
  const paths: Paths = getPaths();
  const hasBinFn = opts.hasBin ?? ((name) => (opts.resolveBin ?? defaultResolveBin)(name) !== null);
  const resolveBinFn = opts.resolveBin ?? defaultResolveBin;
  const ask = opts.io?.ask ?? ttyAsk;

  // Idempotency: a re-run against an already-registered handle used to
  // always POST /v1/register, which the relay correctly 409s (the handle is
  // taken — by this same install) — aborting setup even though a valid
  // token already sits in config.json. If a usable config already exists
  // for the handle we'd otherwise register, skip registration entirely and
  // just re-do the local steps below, which are all idempotent anyway.
  let existingCfg: Config | undefined;
  try {
    existingCfg = loadConfig(paths);
  } catch {
    existingCfg = undefined;
  }
  const canReuse = existingCfg !== undefined && (!opts.handle || opts.handle === existingCfg.handle);

  // On reuse the saved agent_kind is what actually gets spawned (see
  // listener.ts), so skip detection entirely — it may prompt ("Which should
  // agentcall use?") and its answer would be ignored anyway.
  const agentKind =
    canReuse && existingCfg ? existingCfg.agent_kind : await detectAgentKind(opts, hasBinFn, ask);
  warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
  warnIfOutsideLaunchdPath("npx", resolveBinFn);

  let cfg: Config;
  let address: string;
  if (canReuse && existingCfg) {
    cfg = existingCfg;
    address = addressFromConfig(cfg);
    console.log(`Reusing existing registration for ${cfg.handle}`);
  } else {
    const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
    if (!handle) throw new Error("A handle is required.");

    const relay = (opts.relay ?? relayUrl()).replace(/\/+$/, "");

    console.log(`Registering ${handle} with ${relay} ...`);
    const { token, address: registeredAddress } = await registerHandle(relay, handle, agentKind);
    cfg = { handle, token, agent_kind: agentKind, relay };
    address = registeredAddress;
    saveConfig(paths, cfg);
  }

  // Seed srt.json with the current toolchain's read dirs (see srt.ts's
  // toolchainReadDirs) so the sandboxed agent can execute node/npx/itself
  // from first call, not just after runAgent's first real spawn rewrites
  // it. If resolution throws (an odd PATH during setup), fall back to the
  // base allowlist rather than failing setup outright — runAgent rewrites
  // srt.json before every real spawn anyway, so this only affects the
  // file's content between `setup` and the first real call.
  //
  // Uses cfg.agent_kind (the registered/reused agent), not the freshly
  // detected agentKind: on a reuse run those could disagree (e.g. both
  // claude and codex are now on PATH) and cfg.agent_kind is what actually
  // gets spawned (see listener.ts).
  let extraReadDirs: string[] = [];
  try {
    extraReadDirs = toolchainReadDirs(cfg.agent_kind);
  } catch {
    /* fall back to srtSettings(paths, cfg.agent_kind) below */
  }
  writeFileSync(paths.srtFile, JSON.stringify(srtSettings(paths, cfg.agent_kind, extraReadDirs), null, 2) + "\n");
  mkdirSync(paths.publicDir, { recursive: true });

  if (!opts.skipLaunchd) {
    const extraPathDirs = resolveExtraPathDirs([cfg.agent_kind, "npx"], resolveBinFn);
    (opts.installLaunchAgentFn ?? installLaunchAgent)(paths, undefined, extraPathDirs);
  }

  if (opts.snippet !== false) {
    appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
    appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
  }

  console.log(
    `\nagentcall is set up.\n` +
      `  Handle:  ${cfg.handle}\n` +
      `  Agent:   ${cfg.agent_kind}\n` +
      `  Relay:   ${cfg.relay}\n` +
      `  Address: ${address}\n\n` +
      `Share your address so others can call your agent:\n` +
      `  agentcall call ${address} "hello"\n`,
  );
}
