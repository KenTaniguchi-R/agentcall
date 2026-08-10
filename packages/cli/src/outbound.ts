import { loadInstallation, type Installation } from "./config.js";
import type { Paths } from "./paths.js";

export function host(relay: string): string {
  try { return new URL(relay).host; }
  catch { return relay.replace(/\/+$/, ""); }
}

/** Resolve the installation once and enforce the organization routing invariant. */
export function outboundInstallation(paths: Paths, destinationOrg: string): Installation {
  const installation = loadInstallation(paths);
  if (installation.config.org !== destinationOrg) {
    throw new Error(
      `This installation belongs to organization "${installation.config.org}", but that address is in "${destinationOrg}". ` +
      "AgentCall only calls within its own organization.",
    );
  }
  return installation;
}
