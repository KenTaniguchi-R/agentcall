import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";
import { addLine, listLinesReport } from "./commands/line.js";
import { listLines } from "./lines.js";
import { resolveLine } from "./lineContext.js";
import { getMachinePaths } from "./paths.js";
import { ask as ttyAsk } from "./tty.js";
import { addressHost, relayUrl, resolveLineWorkdir, type LineConfig } from "./config.js";
import { defaultResolveBin } from "./launchPath.js";
import { host } from "./outbound.js";
import { appendSnippet } from "./snippet.js";
import { installLaunchAgent } from "./launchd.js";
import { formatCheck, verifyAgent, type VerifyCheck, type VerifyFns } from "./verify.js";

// Directories launchd's fixed PATH (see launchd.ts's plistContent) actually
// searches. If claude/codex/npx resolve outside of these, the background
// listener won't find them even though an interactive shell (with nvm/fnm
// on PATH) does.
const LAUNCHD_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface SetupOpts {
  invite?: string;
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
  reusedCfg: LineConfig | undefined,
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
  const answer = (await ask(
    "Make your agent callable by others? Offered tasks run automatically without per-call approval. [Y/n]: ",
  )).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

export async function runSetup(opts: SetupOpts): Promise<{ ready: boolean }> {
  const hasBinFn = opts.hasBin ?? ((name) => (opts.resolveBin ?? defaultResolveBin)(name) !== null);
  const resolveBinFn = opts.resolveBin ?? defaultResolveBin;
  const ask = opts.io?.ask ?? ttyAsk;
  const log = opts.log ?? console.log;

  // Idempotency (main's #43/#79 concern, re-homed onto lines): a re-run must
  // not POST /v1/register for a handle this machine already holds — the relay
  // correctly 409s it, aborting setup even though a valid token already sits
  // on disk. Under the per-line model the check is "does this machine have any
  // line at all", handled by the `existing.length > 0` branch below, which
  // registers nothing and only re-does the idempotent local steps.
  const machine = getMachinePaths();
  const existing = listLines(machine);
  const requestedRelay = opts.relay?.replace(/\/+$/, "");

  // Setup is first-run only. Adding an address to a machine that already has
  // one is `line add` — which is also why the old clobber path (#43) is gone:
  // there is no single config.json left to overwrite.
  if (existing.length > 0) {
    // #79, re-homed. There, a `--relay` that disagreed with the saved
    // registration was silently ignored on a reuse run; the fix was to refuse
    // rather than pretend. The same silent-ignore exists here — this branch
    // registers nothing, so `--relay`/`--handle` would have no effect at all —
    // but the remedy differs, because several relays on one machine are now
    // LEGAL (that is what lines are for). So this refuses only when the flag
    // asks for something no existing line provides, and points at `line add`
    // rather than at `uninstall`.
    const ready = existing.filter((l) => l.config);
    if (requestedRelay !== undefined && !ready.some((l) => host(l.config!.relay) === host(requestedRelay))) {
      throw new Error(
        `This machine has no line on ${requestedRelay} (it has: ` +
          `${[...new Set(ready.map((l) => host(l.config!.relay)))].join(", ") || "none"}). ` +
          "`agentcall setup` only ever creates the first line — add another with " +
          `\`agentcall line add <name> --relay ${requestedRelay} --handle <handle> --invite <token>\`.`,
      );
    }
    if (opts.handle !== undefined && !ready.some((l) => l.config!.handle === opts.handle)) {
      throw new Error(
        `This machine holds no line for the handle "${opts.handle}" (it holds: ` +
          `${ready.map((l) => l.config!.handle).join(", ") || "none"}). ` +
          "`agentcall setup` only ever creates the first line — add another with " +
          `\`agentcall line add <name> --handle ${opts.handle} --invite <token>\`.`,
      );
    }
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
  if (callable) {
    log(
      "Callable mode: offered tasks run automatically without per-call approval. " +
        "Review activity later with `agentcall history`.",
    );
  }
  // No `reusedCfg` branch any more: setup is first-run only, so there is never
  // a saved agent_kind to prefer over detection. A second run stops earlier
  // and points at `line add`.
  const agentKind = callable ? await detectAgentKind(opts, hasBinFn, ask) : undefined;
  if (agentKind) {
    warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
    warnIfOutsideLaunchdPath("npx", resolveBinFn);
  }

  // Checked before the handle prompt so a run that cannot possibly register
  // fails immediately instead of after an interactive question.
  const invite = opts.invite?.trim();
  if (!invite) throw new Error("An organization invite is required. Run `agentcall setup --invite <token>`.");
  const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
  if (!handle) throw new Error("A handle is required.");
  const relay = requestedRelay ?? relayUrl();
  // The line name is local; default it to the agent kind, which is what the
  // owner will call it anyway.
  const name = agentKind ?? "caller";

  log(`Registering ${handle} with ${relay} ...`);
  // extraPathDirs (widening the LaunchAgent's PATH past its fixed base dirs
  // for an agent/npx binary resolved outside them, e.g. an nvm/fnm-managed
  // install) is NOT computed here: addLine derives it itself from every
  // ready line on the machine (launchPathDirs), not just the one being
  // created — one process serves every line, so a single-line computation
  // would drop coverage the moment a second line runs a different agent.
  // resolveBin is threaded through so a test override still reaches that
  // derivation.
  const { address } = await (opts.addLineFn ?? addLine)(machine, {
    name,
    handle,
    relay,
    invite,
    agent: agentKind,
    callerOnly: !callable,
    installLaunchAgentFn: opts.skipLaunchd ? () => {} : opts.installLaunchAgentFn,
    resolveBin: resolveBinFn,
    // addLine has its own post-registration verify step (AddLineOpts.verify,
    // default on) — always false here because runSetup below does its own,
    // richer verify pass (formatted checks plus the ready/not-ready summary)
    // over the exact same line. Without this, `agentcall setup` would spawn
    // the agent twice for one verification.
    verify: false,
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
        `  agentcall call ken@${addressHost(cfg)} "hello"\n\n` +
        // NOT "re-run `agentcall setup`" any more: setup is first-run only, so
        // a re-run prints the line list and changes nothing. Before lines, a
        // re-run genuinely upgraded a caller-only install in place, keeping the
        // handle; there is no in-place upgrade now, and saying otherwise would
        // send the owner round a loop that silently does nothing. `line add`
        // is the honest instruction — note it yields a NEW address, so this is
        // a real capability gap, not just different wording.
        `To answer calls later, install claude or codex and add a callable line:\n` +
        `  agentcall line add <name> --agent <claude|codex> --invite <token>\n` +
        `That registers a NEW address — "${cfg.handle}" itself stays caller-only.\n`,
    );
  }
  return { ready: true };
}
