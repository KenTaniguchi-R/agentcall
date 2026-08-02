import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";
import { isEphemeralDir, preferDurableBin } from "./bin.js";
import { readyLines } from "./lines.js";
import type { MachinePaths } from "./paths.js";

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

export function defaultResolveBin(name: string): string | null {
  try {
    const out = execFileSync("which", ["-a", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return preferDurableBin(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

// One process serves every line (see listenAll.ts), so there is exactly one
// LaunchAgent plist and its PATH has to cover every callable line's agent
// binary, not just whichever line happened to be added first or most
// recently. Computing this per-caller (as setup used to, for its own
// agentKind only) silently drops coverage the moment a second line runs a
// different agent — this derives it fresh from machine state instead, so
// every installLaunchAgent call site (setup -> addLine, addLine directly,
// removeLine's reinstall) gets the same, complete answer without having to
// individually track what's already installed. `agentcall rotate` used to be
// a call site too; Task 12 removed rotate's own installLaunchAgent call, so
// only commands/line.ts's addLine and removeLine remain.
export function launchPathDirs(
  m: MachinePaths, resolveBin: (name: string) => string | null = defaultResolveBin,
): string[] {
  const kinds = new Set<AgentKind>();
  for (const line of readyLines(m)) {
    if (line.config.agent_kind) kinds.add(line.config.agent_kind);
  }
  return resolveExtraPathDirs([...kinds, "npx"], resolveBin);
}
