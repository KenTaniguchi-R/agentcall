import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getPaths, type Paths } from "./paths.js";
import { ask as ttyAsk } from "./tty.js";
import { loadConfig, saveConfig, relayUrl, type Config } from "./config.js";
import { registerHandle } from "./api.js";
import { publishCard } from "./card.js";
import { DEFAULT_POLICY } from "./policy.js";
import { isEphemeralDir, preferDurableBin } from "./bin.js";
import { appendSnippet } from "./snippet.js";
import { installLaunchAgent } from "./launchd.js";
import { formatCheck, verifyAgent, type VerifyCheck, type VerifyFns } from "./verify.js";

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
  callerOnly?: boolean;
  // false skips post-setup agent verification (commander's --no-verify).
  verify?: boolean;
  io?: { ask(question: string): Promise<string> };
  // Test seams — production callers should leave these as the defaults.
  hasBin?: (name: string) => boolean;
  resolveBin?: (name: string) => string | null;
  installLaunchAgentFn?: typeof installLaunchAgent;
  verifyFns?: VerifyFns;
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

// Whether this install should answer calls (run the listener) or stay
// caller-only. Precedence: explicit --caller-only > a reused config that is
// already callable > explicit --agent > no agent binary on PATH (fall back
// to caller-only instead of failing setup) > --yes > ask.
async function decideCallable(
  opts: SetupOpts,
  hasBin: (name: string) => boolean,
  ask: (q: string) => Promise<string>,
  reusedCfg: Config | undefined,
): Promise<boolean> {
  if (opts.callerOnly) return false;
  if (reusedCfg?.agent_kind) return true;
  if (opts.agent) return true;
  if (!hasBin("claude") && !hasBin("codex")) {
    console.log(
      "No claude or codex found on PATH — setting up as caller-only.\n" +
        "Install one and re-run `agentcall setup` to make your agent callable.",
    );
    return false;
  }
  if (opts.yes) return true;
  const answer = (await ask("Make your agent callable by others? [Y/n]: ")).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

export async function runSetup(opts: SetupOpts): Promise<{ ready: boolean }> {
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
  const reusedCfg =
    existingCfg !== undefined && (!opts.handle || opts.handle === existingCfg.handle) ? existingCfg : undefined;

  const callable = await decideCallable(opts, hasBinFn, ask, reusedCfg);

  // A caller-only outcome must not clobber an existing callable install:
  // config.json is machine-global, and the installed LaunchAgent would keep
  // relaunching `agentcall listen` against a config it can no longer serve
  // (assertCallableConfig throws -> crash loop) while the old handle
  // silently went offline. Refuse and point at uninstall instead.
  if (!callable && existingCfg?.agent_kind) {
    console.error(
      `This machine already answers calls as "${existingCfg.handle}". To stop answering calls, run ` +
        "`agentcall uninstall` (config is kept; re-run `agentcall setup` to come back).",
    );
    return { ready: false };
  }

  // On reuse the saved agent_kind is what actually gets spawned (see
  // listener.ts), so skip detection entirely — it may prompt ("Which should
  // agentcall use?") and its answer would be ignored anyway.
  let agentKind: "claude" | "codex" | undefined;
  if (callable) {
    agentKind = reusedCfg?.agent_kind ?? (await detectAgentKind(opts, hasBinFn, ask));
    warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
    warnIfOutsideLaunchdPath("npx", resolveBinFn);
  }

  let cfg: Config;
  let address: string;
  if (reusedCfg) {
    cfg = reusedCfg;
    if (callable && !cfg.agent_kind && agentKind) {
      // Upgrade caller-only -> callable: keep handle/token, add the agent
      // locally. The relay's stored agent_kind stays NULL, which is fine —
      // the relay never reads that column after registration.
      cfg = { ...cfg, agent_kind: agentKind };
      saveConfig(paths, cfg);
    }
    address = addressFromConfig(cfg);
    console.log(`Reusing existing registration for ${cfg.handle}`);
  } else {
    const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
    if (!handle) throw new Error("A handle is required.");

    const relay = (opts.relay ?? relayUrl()).replace(/\/+$/, "");

    console.log(`Registering ${handle} with ${relay} ...`);
    const { token, address: registeredAddress } = await registerHandle(relay, handle, agentKind);
    cfg = agentKind ? { handle, token, agent_kind: agentKind, relay } : { handle, token, relay };
    address = registeredAddress;
    saveConfig(paths, cfg);
  }

  // Everything below the config is listener-side (callee) machinery: a
  // caller-only install (no agent_kind) has no tasks or card to publish and
  // no listener to install, so it needs none of it.
  let verifyFailure: VerifyCheck | undefined;
  if (cfg.agent_kind) {
    mkdirSync(paths.publicDir, { recursive: true });
    mkdirSync(paths.tasksDir, { recursive: true });
    if (!existsSync(paths.policyFile)) {
      writeFileSync(paths.policyFile, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n");
    }

    // Publish the agent card (task menu) to the relay so callers can discover
    // what this agent offers before calling. Best-effort: a relay hiccup here
    // must not abort setup — `agentcall card push` re-publishes any time.
    try {
      await publishCard(cfg, paths);
    } catch (e) {
      console.error(`Warning: could not publish the agent card (${String(e)}). Run \`agentcall card push\` later.`);
    }

    if (!opts.skipLaunchd) {
      const extraPathDirs = resolveExtraPathDirs([cfg.agent_kind, "npx"], resolveBinFn);
      (opts.installLaunchAgentFn ?? installLaunchAgent)(paths, undefined, extraPathDirs);
    }

    if (opts.verify !== false) {
      console.log(`\nVerifying ${cfg.agent_kind} can answer a test call (takes ~10-30s)...`);
      const checks = await verifyAgent(cfg.agent_kind, paths, opts.verifyFns);
      for (const c of checks) console.log(formatCheck(c));
      verifyFailure = checks.find((c) => !c.ok);
    }
  }

  if (opts.snippet !== false) {
    appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
    appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
  }

  if (cfg.agent_kind && verifyFailure) {
    console.error(
      `\nagentcall is set up, but your agent is NOT ready to answer calls.\n` +
        `  Failed check: ${verifyFailure.name}${verifyFailure.detail ? ` — ${verifyFailure.detail}` : ""}\n` +
        (verifyFailure.hint ? `  Fix: ${verifyFailure.hint}\n` : "") +
        `\nOnce fixed, run \`agentcall doctor\` to confirm — calls start working immediately, no setup re-run needed.\n\n` +
        `  Handle:  ${cfg.handle}\n` +
        `  Agent:   ${cfg.agent_kind}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n`,
    );
    return { ready: false };
  }
  if (cfg.agent_kind) {
    console.log(
      `\nagentcall is set up.\n` +
        (opts.verify !== false ? `  ✓ agent verified (${cfg.agent_kind} answered a test call)\n` : "") +
        `  Handle:  ${cfg.handle}\n` +
        `  Agent:   ${cfg.agent_kind}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n\n` +
        `Share your address so others can call your agent:\n` +
        `  agentcall call ${address} "hello"\n`,
    );
  } else {
    console.log(
      `\nagentcall is set up (caller-only).\n` +
        `  Handle:  ${cfg.handle}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n\n` +
        `You can call other agents:\n` +
        `  agentcall call ken@agentcall.benree.tech "hello"\n\n` +
        `To make your own agent callable later, install claude or codex and re-run \`agentcall setup\`.\n`,
    );
  }
  return { ready: true };
}
