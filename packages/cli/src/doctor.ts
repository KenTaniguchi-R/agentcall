import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getRecoveryState, getStatus } from "./api.js";
import { callAgent } from "./callClient.js";
import { loadConfig, relayUrl, resolveWorkdir, type Config, type Workdir } from "./config.js";
import { LAUNCH_LABEL } from "./launchd.js";
import type { Paths } from "./paths.js";
import { checkGuard, checkRelaySelfCall, formatCheck, short, verifyAgent, type GuardBinaryProbeFn, type GuardProbeFn, type VerifyCheck, type VerifyFns } from "./verify.js";

export interface DoctorDeps {
  paths: Paths;
  // Test seams — production callers should leave these as the defaults.
  verifyFns?: VerifyFns;
  getStatusFn?: typeof getStatus;
  getRecoveryStateFn?: typeof getRecoveryState;
  callFn?: typeof callAgent;
  launchctlList?: () => string;
  isDarwin?: boolean;
  log?: (line: string) => void;
  guardFn?: GuardProbeFn;
  guardBinaryFn?: GuardBinaryProbeFn;
}

const defaultLaunchctlList = () =>
  execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Verifies this install can answer calls, printing one line per check.
// Ladder semantics (see the design spec): static checks are informational
// and never block the agent checks, EXCEPT a missing config (nothing to
// verify) and caller-only (nothing to verify, and that's fine — exit 0).
// The relay-status result gates only the relay self-call; the verifyAgent
// ladder stops itself at its first failure. Returns the process exit code:
// 0 iff no check printed as ✗ — a `!` warning is a check that could not be
// proven, not one that failed, and does not turn the run red.
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const log = deps.log ?? console.log;
  const checks: VerifyCheck[] = [];
  const report = (c: VerifyCheck) => {
    checks.push(c);
    log(formatCheck(c));
  };

  let cfg: Config;
  try {
    cfg = loadConfig(deps.paths);
  } catch (e) {
    report({ name: "config", ok: false, detail: short(e), hint: "run `agentcall setup` first" });
    return 1;
  }
  report({ name: "config", ok: true, detail: `${cfg.handle} -> ${relayUrl(cfg)}` });

  if (!cfg.agent_kind) {
    log("caller-only install — no agent to verify. You can still call others.");
    return 0;
  }

  // A workdir that's relative, missing, or a file stops startListener dead,
  // so diagnose it here rather than letting the owner discover it as a
  // listener that won't stay up.
  let workdir: Workdir | undefined;
  try {
    workdir = resolveWorkdir(cfg, deps.paths);
    report({ name: "workdir", ok: true, detail: workdir.dir });
  } catch (e) {
    report({ name: "workdir", ok: false, detail: short(e), hint: "fix or remove `workdir` in ~/.agentcall/config.json" });
  }

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
  }

  let online = false;
  try {
    online = (await (deps.getStatusFn ?? getStatus)(
      relayUrl(cfg), cfg.handle, { handle: cfg.handle, token: cfg.token },
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

  // Reports only what is observable. Whether the owner actually KEPT their
  // code is not, which is why there is no "have you saved it?" nag here.
  try {
    const state = await (deps.getRecoveryStateFn ?? getRecoveryState)(
      relayUrl(cfg), { handle: cfg.handle, token: cfg.token },
    );
    if (!state.issued) {
      report({
        name: "recovery code",
        ok: true,
        warn: true,
        detail: "never issued",
        hint: "run `agentcall recovery issue` — without one, losing config.json loses the handle",
      });
    } else if (state.redeemed_at !== null) {
      const when = new Date(state.redeemed_at).toISOString().slice(0, 10);
      report({
        name: "recovery code",
        ok: true,
        warn: true,
        detail: `redeemed on ${when}`,
        hint: "if that wasn't you, run `agentcall recovery issue` now",
      });
    }
  } catch {
    /* an unreachable relay is already reported by the status check above */
  }

  // Falls back to publicDir when workdir didn't resolve: per the ladder
  // semantics above, a static-check failure reports itself but must not stop
  // the agent checks from running.
  const agentChecks = await verifyAgent(cfg.agent_kind, workdir?.dir ?? deps.paths.publicDir, deps.verifyFns);
  for (const c of agentChecks) report(c);
  const agentOk = agentChecks.every((c) => c.ok);

  // Claude-only: the guard is registered on claude spawns, and checkGuard
  // spawns claude to probe it. Gated on agentOk because probing through a
  // broken agent tests nothing.
  if (cfg.agent_kind === "claude" && agentOk) {
    report(await checkGuard(deps.guardFn, deps.guardBinaryFn));
  }

  if (agentOk && online) {
    report(await checkRelaySelfCall(cfg, deps.callFn));
  } else if (agentOk) {
    log("skipping relay self-call (agent offline).");
  }

  return checks.every((c) => c.ok) ? 0 : 1;
}
