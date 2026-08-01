import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getStatus } from "./api.js";
import { callAgent } from "./callClient.js";
import { loadConfig, relayUrl, type Config } from "./config.js";
import { LAUNCH_LABEL } from "./launchd.js";
import type { Paths } from "./paths.js";
import { checkRelaySelfCall, formatCheck, short, verifyAgent, type VerifyCheck, type VerifyFns } from "./verify.js";

export interface DoctorDeps {
  paths: Paths;
  // Test seams — production callers should leave these as the defaults.
  verifyFns?: VerifyFns;
  getStatusFn?: typeof getStatus;
  callFn?: typeof callAgent;
  launchctlList?: () => string;
  isDarwin?: boolean;
  log?: (line: string) => void;
}

const defaultLaunchctlList = () =>
  execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Verifies this install can answer calls, printing one line per check.
// Ladder semantics (see the design spec): static checks are informational
// and never block the agent checks, EXCEPT a missing config (nothing to
// verify) and caller-only (nothing to verify, and that's fine — exit 0).
// The relay-status result gates only the relay self-call; the verifyAgent
// ladder stops itself at its first failure. Returns the process exit code:
// 0 iff every check printed as ✓.
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

  // runAgent rewrites srt.json before every spawn, so a missing file is a
  // sign setup didn't finish rather than a blocker — report and continue.
  report({
    name: "srt.json",
    ok: existsSync(deps.paths.srtFile),
    hint: existsSync(deps.paths.srtFile) ? undefined : "re-run `agentcall setup` to seed the sandbox settings",
  });

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

  const agentChecks = await verifyAgent(cfg.agent_kind, deps.paths, deps.verifyFns);
  for (const c of agentChecks) report(c);
  const agentOk = agentChecks.every((c) => c.ok);

  if (agentOk && online) {
    report(await checkRelaySelfCall(cfg, deps.callFn));
  } else if (agentOk) {
    log("skipping relay self-call (agent offline).");
  }

  return checks.every((c) => c.ok) ? 0 : 1;
}
