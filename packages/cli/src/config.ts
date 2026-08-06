import { formatAddress, HOSTED_RELAY_HOST, type AgentKind } from "@benree/agentcall-shared";

// Per-line credentials and settings. Config (and the flat Paths it paired
// with) used to be a single machine-wide record; Task 12 deleted that half
// once every consumer moved to LineConfig/LinePaths.
export interface LineConfig {
  // The tenant this line is enrolled in. On the LINE, not on the machine:
  // `org` and `relay` are two halves of one identity — the org names a tenant
  // *on a relay* — and `relay` was already per-line. A machine-wide org would
  // mean a second line on another relay silently inherited the first tenant's
  // slug and addressed itself as `<handle>@<wrong-org>.<host>`.
  org: string;
  handle: string;
  token: string;
  relay: string;
  /** Absent = answer-incapable. The line can still call out. */
  agent_kind?: AgentKind;
  // No `workdir`. #372 deleted it: the sensitivity map already names the
  // directories the owner cares about, and a second setting here could point
  // the agent somewhere the guard would then refuse to let it read. The spawn
  // directory is derived from the map instead — see sensitivity.ts's
  // workdirFor.
}
export type CallableLineConfig = LineConfig & { agent_kind: AgentKind };

// Guards commands that spawn the local agent: a caller-only line has no
// agent_kind and cannot answer calls.
export function assertCallableLine(cfg: LineConfig): asserts cfg is CallableLineConfig {
  if (!cfg.agent_kind) {
    throw new Error("This line is caller-only — re-run `agentcall line add` with an agent to make it callable.");
  }
}

const DEFAULT_RELAY = `https://${HOSTED_RELAY_HOST}`;

// Strips a trailing slash so callers can build "${relayUrl(cfg)}/v1/..." without
// risking a double slash when the env/config/default value already ends in one.
export function normalizeRelay(url: string): string {
  return url.replace(/\/+$/, "");
}

export function relayUrl(cfg?: LineConfig): string {
  // An empty-string AGENTCALL_RELAY (e.g. exported but unset in a shell profile)
  // is treated as unset rather than as "point at the empty string".
  const envRelay = process.env.AGENTCALL_RELAY || undefined;
  return normalizeRelay(envRelay ?? cfg?.relay ?? DEFAULT_RELAY);
}

// The relay's hostname, for the `relay_origin` binding. The org used to be
// glued on as a subdomain; it travels in the address now.
export function relayHostOf(relay: string): string {
  return new URL(relay).hostname;
}

// The line's own address. Formatted from (org, handle), never composed from a
// host and never stored — see the spec on address-as-rendering.
export function lineAddress(cfg: LineConfig): string {
  return formatAddress(cfg.org, cfg.handle);
}
