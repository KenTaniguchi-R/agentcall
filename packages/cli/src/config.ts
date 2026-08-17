import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentKindSchema, formatAddress, HOSTED_RELAY_HOST, ORG_RE, type AgentKind,
} from "@benree/agentcall-shared";
import { writeJsonAtomic } from "./json-store.js";
import { getPaths, type Paths } from "./paths.js";

export interface Config {
  org: string;
  handle: string;
  token: string;
  relay: string;
  /** Absent means this installation can call but cannot answer. */
  agent_kind?: AgentKind;
}
export type CallableConfig = Config & { agent_kind: AgentKind };

export const ConfigSchema = z.object({
  org: z.string().regex(ORG_RE),
  handle: z.string().min(1),
  token: z.string().min(1),
  relay: z.string().min(1),
  agent_kind: AgentKindSchema.optional(),
});

export interface Installation {
  paths: Paths;
  config: Config;
}

function legacyInstallMessage(paths: Paths): string {
  return `Legacy multi-line installation detected at ${join(paths.dir, "lines")}. ` +
    "AgentCall will not choose or merge identities automatically. Follow the explicit migration guide at " +
    "https://agentcall.mintlify.app/guides/single-identity-migration before continuing.";
}

export function loadConfig(paths: Paths): Config {
  if (!existsSync(paths.configFile)) {
    if (existsSync(join(paths.dir, "lines"))) throw new Error(legacyInstallMessage(paths));
    throw new Error("No agentcall installation found. Run `agentcall setup` first.");
  }
  const dir = lstatSync(paths.dir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error(`AgentCall state at ${paths.dir} must be a real directory, not a symlink.`);
  }
  const file = lstatSync(paths.configFile);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error(`AgentCall config at ${paths.configFile} must be a regular file, not a symlink.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (error) {
    throw new Error(`Corrupt config.json at ${paths.configFile}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    return ConfigSchema.parse(raw);
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
      : String(error);
    throw new Error(`Corrupt config.json at ${paths.configFile}: ${detail}.`, { cause: error });
  }
}

export function saveConfig(paths: Paths, config: Config): void {
  writeJsonAtomic(paths.configFile, config);
}

export function loadInstallation(paths: Paths = getPaths()): Installation {
  return { paths, config: loadConfig(paths) };
}

export function assertCallable(config: Config): asserts config is CallableConfig {
  if (!config.agent_kind) {
    throw new Error("This installation is caller-only — re-run `agentcall setup` after installing claude or codex to make it callable.");
  }
}

const DEFAULT_RELAY = `https://${HOSTED_RELAY_HOST}`;
export function normalizeRelay(url: string): string { return url.replace(/\/+$/, ""); }
export function relayUrl(config?: Config): string {
  const envRelay = process.env.AGENTCALL_RELAY || undefined;
  return normalizeRelay(envRelay ?? config?.relay ?? DEFAULT_RELAY);
}
export function relayHostOf(relay: string): string { return new URL(relay).hostname; }
export function configAddress(config: Config): string { return formatAddress(config.org, config.handle); }
