import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";
import { addLine, listLinesReport } from "./commands/line.js";
import { listLines } from "./lines.js";
import { resolveLine } from "./lineContext.js";
import { getMachinePaths } from "./paths.js";
import { ask as ttyAsk } from "./tty.js";
import { relayUrl, resolveLineWorkdir, type Config } from "./config.js";
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
  agent?: AgentKind;
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
  addLineFn?: typeof addLine;
  log?: (s: string) => void;
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
): Promise<AgentKind> {
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
  const hasBinFn = opts.hasBin ?? ((name) => (opts.resolveBin ?? defaultResolveBin)(name) !== null);
  const resolveBinFn = opts.resolveBin ?? defaultResolveBin;
  const ask = opts.io?.ask ?? ttyAsk;
  const log = opts.log ?? console.log;

  const machine = getMachinePaths();
  const existing = listLines(machine);

  // Setup is first-run only. Adding an address to a machine that already has
  // one is `line add` — which is also why the old clobber path (#43) is gone:
  // there is no single config.json left to overwrite.
  if (existing.length > 0) {
    log("agentcall is already set up on this machine.\n");
    for (const row of listLinesReport(machine)) {
      log(`  ${row.name.padEnd(10)} ${row.address}${row.primary ? "   primary" : ""}`);
    }
    log(`\nTo add another address:  agentcall line add <name> --handle <handle>`);
    if (opts.snippet !== false) {
      appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
      appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
    }
    return { ready: true };
  }

  const callable = await decideCallable(opts, hasBinFn, ask, undefined);
  const agentKind = callable ? await detectAgentKind(opts, hasBinFn, ask) : undefined;
  if (agentKind) {
    warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
    warnIfOutsideLaunchdPath("npx", resolveBinFn);
  }

  const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
  if (!handle) throw new Error("A handle is required.");
  const relay = (opts.relay ?? relayUrl()).replace(/\/+$/, "");
  // The line name is local; default it to the agent kind, which is what the
  // owner will call it anyway.
  const name = agentKind ?? "caller";

  log(`Registering ${handle} with ${relay} ...`);
  // Same fix setup used to apply directly: widen the LaunchAgent's PATH past
  // its fixed base dirs when the agent/npx binary resolved outside them (e.g.
  // an nvm/fnm-managed install) — otherwise the supervised listener can't
  // find its own agent at spawn time. addLine doesn't compute this itself;
  // the caller does and threads it through.
  const extraPathDirs = agentKind ? resolveExtraPathDirs([agentKind, "npx"], resolveBinFn) : [];
  const { address } = await (opts.addLineFn ?? addLine)(machine, {
    name,
    handle,
    relay,
    agent: agentKind,
    callerOnly: !callable,
    installLaunchAgentFn: opts.skipLaunchd ? () => {} : opts.installLaunchAgentFn,
    extraPathDirs,
  });

  const ctx = resolveLine(machine, { line: name });
  const cfg = ctx.config;

  let verifyFailure: VerifyCheck | undefined;
  if (cfg.agent_kind && opts.verify !== false) {
    log(`\nVerifying ${cfg.agent_kind} can answer a test call (takes ~10-30s)...`);
    const checks = await verifyAgent(cfg.agent_kind, resolveLineWorkdir(cfg, ctx.paths).dir, opts.verifyFns);
    for (const c of checks) log(formatCheck(c));
    verifyFailure = checks.find((c) => !c.ok);
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
    log(
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
    log(
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
