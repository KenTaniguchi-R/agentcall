import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { HANDLE_RE, ORG_RE } from "@benree/agentcall-shared";
import { z } from "zod";
import { writeJsonAtomic } from "./json-store.js";
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

const RelayUrl = z.string().min(1).refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "must be an absolute HTTP(S) URL");

// Keep unknown top-level keys so an older CLI does not discard fields added by
// a newer release when setup loads, updates, and saves this credential store.
const ConfigSchema = z.object({
  org: z.string().regex(ORG_RE),
  handle: z.string().regex(HANDLE_RE),
  token: z.string().min(1),
  agent_kind: z.enum(["claude", "codex"]).optional(),
  relay: RelayUrl,
  workdir: z.string().optional(),
}).loose();

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
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(p.configFile, "utf8")));
  } catch (error) {
    let problem = "could not be read";
    if (error instanceof SyntaxError) {
      problem = "invalid JSON";
    } else if (error instanceof z.ZodError) {
      problem = error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ");
    }
    throw new Error(
      `Corrupt agentcall config at ${p.configFile}: ${problem}. ` +
        `Fix or remove this file, then re-run \`agentcall setup --invite <token>\`.`,
      { cause: error },
    );
  }
}

export function saveConfig(p: Paths, cfg: Config): void {
  writeJsonAtomic(p.configFile, cfg);
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
