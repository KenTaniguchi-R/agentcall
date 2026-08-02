import { rmSync } from "node:fs";
import { loadConfig, saveConfig, relayUrl, assertCallableConfig } from "../config.js";
import { rotateToken } from "../api.js";
import { startListener } from "../listener.js";
import { runSetup } from "../setup.js";
import { installLaunchAgent, isLaunchAgentInstalled, uninstallLaunchAgent } from "../launchd.js";
import { runDoctor } from "../doctor.js";
import { ExitOnly, type Deps } from "./deps.js";

export interface SetupOptions {
  handle?: string;
  agent?: string;
  relay?: string;
  snippet?: boolean;
  skipLaunchd?: boolean;
  callerOnly?: boolean;
  verify?: boolean;
}

// runSetup does its own printing (io comes from opts.io, defaulted inside
// setup.ts) and its own getPaths() — this command only translates its result
// into the exit-code convention. ExitOnly rather than a message: runSetup has
// already told the owner what went wrong.
export async function setup(_d: Deps, o: SetupOptions): Promise<void> {
  const result = await runSetup({
    handle: o.handle,
    agent: o.agent as "claude" | "codex" | undefined,
    relay: o.relay,
    snippet: o.snippet,
    skipLaunchd: o.skipLaunchd,
    callerOnly: o.callerOnly,
    verify: o.verify,
  });
  if (!result.ready) throw new ExitOnly();
}

// runDoctor's return type is a plain number, not a 0|1 union — set it
// directly rather than through run()'s throw-to-exit-1 convention, which
// could only ever express pass/fail. Mirrors status() in commands/call.ts.
export async function doctor(d: Deps): Promise<void> {
  process.exitCode = await runDoctor({ paths: d.paths });
}

export function listen(d: Deps): void {
  const cfg = loadConfig(d.paths);
  assertCallableConfig(cfg);
  d.io.log(`agentcall listener starting for ${cfg.handle} -> ${relayUrl(cfg)}`);
  const l = startListener({ relay: relayUrl(cfg), config: cfg, paths: d.paths });
  process.on("SIGTERM", () => {
    l.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    l.stop();
    process.exit(0);
  });
  // Keep the process alive without a busy loop; setInterval's max delay.
  setInterval(() => {}, 1 << 30);
}

export async function rotate(d: Deps): Promise<void> {
  const cfg = loadConfig(d.paths);
  const { token } = await rotateToken(relayUrl(cfg), { handle: cfg.handle, token: cfg.token });
  saveConfig(d.paths, { ...cfg, token });
  d.io.log(`Token rotated for ${cfg.handle}. The old token no longer works.`);
  // The background listener read the old token at startup and holds it in
  // memory, so without a restart it reconnects with a dead credential and
  // 401s forever. Only restart a listener that's actually installed —
  // installLaunchAgent would otherwise create one the owner opted out of.
  if (isLaunchAgentInstalled(d.paths)) {
    installLaunchAgent(d.paths);
    d.io.log("Background listener restarted with the new token.");
  } else if (cfg.agent_kind) {
    d.io.log("Restart `agentcall listen` so it picks up the new token.");
  }
}

export function uninstall(d: Deps, o: { purge?: boolean }): void {
  uninstallLaunchAgent(d.paths);
  if (o.purge) rmSync(d.paths.dir, { recursive: true, force: true });
  d.io.log("agentcall listener removed." + (o.purge ? " Config purged." : ""));
}
