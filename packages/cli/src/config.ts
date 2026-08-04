import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { HOSTED_RELAY_HOST, type AgentKind } from "@benree/agentcall-shared";
import type { LinePaths } from "./paths.js";

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
  workdir?: string;
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

export interface Workdir {
  /** Absolute directory the agent is spawned in. */
  dir: string;
  /**
   * Whether the prompt should tell the agent to stay inside `dir`. True only
   * for the default ~/AgentCall/<line>/public share folder — an owner who
   * points workdir at a real project did so precisely so the agent would use it.
   *
   * Note this has never been an enforced boundary since the OS sandbox was
   * removed; it is an instruction the model can decline either way.
   */
  confined: boolean;
}

// Resolved once at listener start rather than per call, so a misconfigured
// workdir fails loudly at `agentcall listen` instead of turning every inbound
// call into a cryptic spawn ENOENT. Defaults to p.shareDir (the line's
// authored public folder).
export function resolveLineWorkdir(cfg: LineConfig, p: LinePaths): Workdir {
  if (cfg.workdir === undefined) return { dir: p.shareDir, confined: true };
  if (!isAbsolute(cfg.workdir)) {
    throw new Error(`config.json workdir must be an absolute path, got "${cfg.workdir}".`);
  }
  if (!existsSync(cfg.workdir)) {
    throw new Error(`config.json workdir "${cfg.workdir}" does not exist.`);
  }
  if (!statSync(cfg.workdir).isDirectory()) {
    throw new Error(`config.json workdir "${cfg.workdir}" is not a directory.`);
  }
  return { dir: cfg.workdir, confined: false };
}

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

export function addressHost(cfg: LineConfig): string {
  return relayAddressHost(relayUrl(cfg), cfg.org);
}

export function relayAddressHost(relay: string, org: string): string {
  const host = new URL(relay).hostname;
  return host === HOSTED_RELAY_HOST ? `${org}.${host}` : host;
}
