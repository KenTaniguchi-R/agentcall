import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";
import { isEphemeralDir, preferDurableBin } from "./bin.js";

// Dirnames of the resolved bins, deduped and skipping any that failed to
// resolve. Used to widen the listener service's PATH so it can find an
// agent/npx install that lives outside its base dirs. Ephemeral dirs (see
// EPHEMERAL_ROOTS) are dropped even if that's where the bin resolved — a PATH
// entry into temp is wrong in a persistent listener service.
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

export function listenerPathDirs(
  agentKind: AgentKind, resolveBin: (name: string) => string | null = defaultResolveBin,
): string[] {
  return resolveExtraPathDirs([agentKind, "npx"], resolveBin);
}
