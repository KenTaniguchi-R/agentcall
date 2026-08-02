import { execFileSync } from "node:child_process";
import { getStatus } from "./api.js";
import { callAgent } from "./callClient.js";
import { relayUrl, resolveLineWorkdir, type LineConfig, type Workdir } from "./config.js";
import { isLaunchAgentInstalled, LAUNCH_LABEL } from "./launchd.js";
import { listLines } from "./lines.js";
import type { MachinePaths } from "./paths.js";
import type { AgentKind } from "./runner.js";
import {
  checkCodexGuard, checkGuard, checkRelaySelfCall, formatCheck, short, verifyAgent,
  type CodexGuardProbeFn, type GuardBinaryProbeFn, type GuardProbeFn,
  type VerifyCheck, type VerifyFns,
} from "./verify.js";

export interface DoctorDeps {
  machine: MachinePaths;
  // Test seams — production callers should leave these as the defaults.
  verifyFns?: VerifyFns;
  getStatusFn?: typeof getStatus;
  callFn?: typeof callAgent;
  launchctlList?: () => string;
  isDarwin?: boolean;
  log?: (line: string) => void;
  guardFn?: GuardProbeFn;
  guardBinaryFn?: GuardBinaryProbeFn;
  codexGuardFn?: CodexGuardProbeFn;
}

const defaultLaunchctlList = () =>
  execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Verifies every line on this install can answer calls, printing one line
// per check under a `line <name>` header for each. Ladder semantics (see the
// design spec): static checks are informational and never block the agent
// checks, EXCEPT a missing/corrupt config (nothing to verify) and
// caller-only (nothing to verify, and that's fine — contributes no
// failure). The relay-status result gates only the relay self-call; the
// verifyAgent ladder stops itself at its first failure. Returns the process
// exit code: 0 iff no check printed as ✗ — a `!` warning is a check that
// could not be proven, not one that failed, and does not turn the run red.
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const log = deps.log ?? console.log;
  const checks: VerifyCheck[] = [];
  const report = (c: VerifyCheck) => {
    checks.push(c);
    log(formatCheck(c));
  };

  // Machine-level, once: there is one plist and one supervised process
  // serving every line, so a per-line launchd check would be meaningless
  // (and would misreport N-1 lines as broken whenever the listener is down).
  if (deps.isDarwin ?? process.platform === "darwin") {
    let loaded = false;
    try {
      loaded = (deps.launchctlList ?? defaultLaunchctlList)().includes(LAUNCH_LABEL);
    } catch {
      loaded = false;
    }
    report({
      name: "background listener (launchd)",
      ok: loaded,
      hint: loaded ? undefined : "re-run `agentcall setup` to install it, or run `agentcall listen` in a terminal",
    });
    // Diagnostic only, never fatal on its own: this distinguishes "setup
    // never installed the plist" from "it's installed but not currently
    // loaded" (e.g. someone ran `launchctl bootout` by hand). Both explain
    // the same failed check above, so this must not double-count it.
    if (!loaded) {
      const installed = isLaunchAgentInstalled(deps.machine);
      report({
        name: "launch agent plist",
        ok: true,
        warn: true,
        detail: installed
          ? "plist file exists but is not currently loaded"
          : "plist file was never installed",
        hint: installed
          ? "try `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tech.benree.agentcall.listener.plist`, or re-run `agentcall setup`"
          : "run `agentcall setup`",
      });
    }
  }

  const lineList = listLines(deps.machine);
  if (lineList.length === 0) {
    // "No agentcall config found" is pinned by the packed-CLI consumer job in
    // .github/workflows/ci.yml, which asserts what an unconfigured install
    // tells a first-time user. Keep the phrase if you reword this.
    report({ name: "config", ok: false, detail: "No agentcall config found — this machine has no lines", hint: "run `agentcall setup` first" });
    return checks.every((c) => c.ok) ? 0 : 1;
  }

  // Probed once per distinct agent_kind across all lines, not once per
  // line — the claude guard protects the binary, not any particular line, so
  // re-probing it for every line sharing that kind would just be N-1 wasted
  // (and slow) spawns proving the same fact again. Only claude is cached: the
  // codex probe takes the line's workdir as an input (hooks/list is asked
  // about a specific cwd, and trust is per-directory), so its answer is not
  // shared across lines.
  const guardCache = new Map<AgentKind, VerifyCheck>();

  for (const line of lineList) {
    log(`line ${line.name}`);

    if (!line.ok || !line.config) {
      report({
        name: "config",
        ok: false,
        detail: short(line.error),
        hint: `fix or remove this line: \`agentcall line remove ${line.name}\``,
      });
      continue;
    }
    const cfg: LineConfig = line.config;
    report({ name: "config", ok: true, detail: `${cfg.handle} -> ${relayUrl(cfg)}` });

    if (!cfg.agent_kind) {
      log("caller-only — no agent to verify. You can still call others.");
      continue;
    }

    // A workdir that's relative, missing, or a file stops startListener
    // dead, so diagnose it here rather than letting the owner discover it as
    // a listener that won't stay up.
    let workdir: Workdir | undefined;
    try {
      workdir = resolveLineWorkdir(cfg, line.paths);
      report({ name: "workdir", ok: true, detail: workdir.dir });
    } catch (e) {
      report({ name: "workdir", ok: false, detail: short(e), hint: "fix or remove `workdir` in ~/.agentcall/lines/<line>/config.json" });
    }

    // LineConfigSchema types `relay` as a bare string, so a syntactically
    // broken value still parses as a valid config and would otherwise only
    // surface as a network failure from the status check below —
    // indistinguishable from a listener that simply isn't running. Caught
    // here, before that call, so the two read differently in the output.
    let relayValid = true;
    try {
      new URL(relayUrl(cfg));
    } catch {
      relayValid = false;
      // relayUrl(cfg), not cfg.relay: AGENTCALL_RELAY, when set, is what
      // relayUrl actually validates (it takes precedence over cfg.relay — see
      // config.ts). Naming cfg.relay here would send the owner to fix a
      // config.json field that a valid AGENTCALL_RELAY override already
      // bypassed.
      report({
        name: "relay config",
        ok: false,
        detail: `"${relayUrl(cfg)}" is not a valid URL`,
        hint: "fix `relay` in ~/.agentcall/lines/<line>/config.json — or, if set, AGENTCALL_RELAY, which takes precedence",
      });
    }

    let online = false;
    if (relayValid) {
      try {
        online = (await (deps.getStatusFn ?? getStatus)(
          relayUrl(cfg), cfg.handle, { org: cfg.org, handle: cfg.handle, token: cfg.token },
        )).online;
        report({
          name: "relay status",
          ok: online,
          detail: online ? "online" : "offline",
          hint: online ? undefined : "the listener isn't connected — check ~/.agentcall/listener.log",
        });
      } catch (e) {
        report({ name: "relay status", ok: false, detail: short(e) });
      }
    }

    // Falls back to shareDir when workdir didn't resolve: per the ladder
    // semantics above, a static-check failure reports itself but must not
    // stop the agent checks from running.
    const agentWorkdir = workdir?.dir ?? line.paths.shareDir;
    const agentChecks = await verifyAgent(cfg.agent_kind, agentWorkdir, deps.verifyFns);
    for (const c of agentChecks) report(c);
    const agentOk = agentChecks.every((c) => c.ok);

    // Runtime-specific guard evidence. Claude needs a real tool attempt plus a
    // direct binary fallback; Codex exposes its effective hook status through
    // app-server without another model call. Gated on agentOk because probing
    // through a broken agent install tests nothing.
    if (cfg.agent_kind === "claude" && agentOk) {
      let guardCheck = guardCache.get(cfg.agent_kind);
      if (!guardCheck) {
        guardCheck = await checkGuard(deps.guardFn, deps.guardBinaryFn);
        guardCache.set(cfg.agent_kind, guardCheck);
      }
      report(guardCheck);
    } else if (cfg.agent_kind === "codex" && agentOk) {
      report(await checkCodexGuard(agentWorkdir, deps.codexGuardFn));
    }

    if (agentOk && online) {
      report(await checkRelaySelfCall(cfg, deps.callFn));
    } else if (agentOk) {
      log("skipping relay self-call (agent offline).");
    }
  }

  return checks.every((c) => c.ok) ? 0 : 1;
}
