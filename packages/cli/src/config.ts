import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { Paths } from "./paths.js";

export interface Config {
  handle: string;
  token: string;
  // Absent = caller-only: this install can call others but is not callable.
  agent_kind?: "claude" | "codex";
  relay: string;
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

export function loadConfig(p: Paths): Config {
  if (!existsSync(p.configFile)) {
    throw new Error(`No agentcall config found. Run \`agentcall setup\` first.`);
  }
  return JSON.parse(readFileSync(p.configFile, "utf8")) as Config;
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
