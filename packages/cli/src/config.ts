import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ORG_RE } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

export interface Config {
  org: string;
  handle: string;
  token: string;
  // Absent = caller-only: this install can call others but is not callable.
  agent_kind?: "claude" | "codex";
  relay: string;
  // Absolute path the answering agent runs in. Absent = ~/AgentCall/public.
  // Deliberately not prompted for during setup: "which directory should your
  // agent answer from?" is a two-second question for a developer and an
  // unanswerable one for everyone else, and a wrong answer quietly makes the
  // agent useless. Owners who want their agent answering with real project
  // context set it by hand; everyone else never sees it.
  workdir?: string;
}

export type CallableConfig = Config & { agent_kind: "claude" | "codex" };

// Guards commands that spawn the local agent: a caller-only install has no
// agent_kind and cannot answer calls.
export function assertCallableConfig(cfg: Config): asserts cfg is CallableConfig {
  if (!cfg.agent_kind) {
    throw new Error("This install is caller-only — re-run `agentcall setup` to make your agent callable.");
  }
}

export const DEFAULT_RELAY = "https://agentcall.benree.tech";

export interface Workdir {
  /** Absolute directory the agent is spawned in. */
  dir: string;
  /**
   * Whether the prompt should tell the agent to stay inside `dir`. True only
   * for the default ~/AgentCall/public share folder — an owner who points
   * workdir at a real project did so precisely so the agent would use it.
   *
   * Note this has never been an enforced boundary since the OS sandbox was
   * removed; it is an instruction the model can decline either way.
   */
  confined: boolean;
}

// Resolved once at listener start rather than per call, so a misconfigured
// workdir fails loudly at `agentcall listen` instead of turning every inbound
// call into a cryptic spawn ENOENT.
export function resolveWorkdir(cfg: Config, p: Paths): Workdir {
  if (cfg.workdir === undefined) return { dir: p.publicDir, confined: true };
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

export function loadConfig(p: Paths): Config {
  if (!existsSync(p.configFile)) {
    throw new Error(`No agentcall config found. Run \`agentcall setup\` first.`);
  }
  const parsed = JSON.parse(readFileSync(p.configFile, "utf8")) as Partial<Config>;
  if (!parsed.org) {
    throw new Error(`Agentcall config at ${p.configFile} has no organization. Run \`agentcall setup --org <organization>\`.`);
  }
  if (!ORG_RE.test(parsed.org)) throw new Error(`Invalid organization slug "${parsed.org}" in ${p.configFile}.`);
  return parsed as Config;
}

export function saveConfig(p: Paths, cfg: Config): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
  writeFileSync(p.configFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p.configFile, 0o600);
}

// Strips a trailing slash so callers can build "${relayUrl(cfg)}/v1/..." without
// risking a double slash when the env/config/default value already ends in one.
export function normalizeRelay(url: string): string {
  return url.replace(/\/+$/, "");
}

export function relayUrl(cfg?: Config): string {
  // An empty-string AGENTCALL_RELAY (e.g. exported but unset in a shell profile)
  // is treated as unset rather than as "point at the empty string".
  const envRelay = process.env.AGENTCALL_RELAY || undefined;
  return normalizeRelay(envRelay ?? cfg?.relay ?? DEFAULT_RELAY);
}

export function addressHost(cfg: Config): string {
  const host = new URL(relayUrl(cfg)).hostname;
  return host === "agentcall.benree.tech" ? `${cfg.org}.${host}` : host;
}
