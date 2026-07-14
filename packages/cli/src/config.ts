import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { Paths } from "./paths.js";

export interface Config {
  handle: string;
  token: string;
  agent_kind: "claude" | "codex";
  relay: string;
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

export function relayUrl(cfg?: Config): string {
  return process.env.AGENTCALL_RELAY ?? cfg?.relay ?? DEFAULT_RELAY;
}
