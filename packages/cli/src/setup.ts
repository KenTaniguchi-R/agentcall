import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatAddress, type AgentKind } from "@benree/agentcall-shared";
import {
  publishEncryptionKey, publishIdentityKey, registerHandle,
} from "./api.js";
import { publishCard } from "./card.js";
import {
  loadConfig, loadInstallation, normalizeRelay, relayUrl, saveConfig, type Config,
} from "./config.js";
import { withFileLock } from "./file-lock.js";
import { generateIdentityKeys, type StoredKeys } from "./keys.js";
import { writeJsonAtomic } from "./json-store.js";
import { getPaths, type Paths } from "./paths.js";
import { DEFAULT_POLICY } from "./policy.js";
import { defaultScope, loadScope, workdirFor } from "./scope.js";
import { canPrompt, ask as ttyAsk } from "./tty.js";
import { defaultResolveBin, listenerPathDirs } from "./listener-path.js";
import { isEphemeralDir } from "./bin.js";
import { appendSnippet } from "./snippet.js";
import { installListenerService } from "./listener-service.js";
import { formatCheck, verifyAgent, type VerifyCheck, type VerifyFns } from "./verify.js";

export interface SetupOpts {
  paths?: Paths;
  invite?: string;
  handle?: string;
  agent?: AgentKind;
  yes?: boolean;
  snippet?: boolean;
  relay?: string;
  skipService?: boolean;
  callerOnly?: boolean;
  verify?: boolean;
  io?: { ask(question: string): Promise<string> };
  hasBin?: (name: string) => boolean;
  resolveBin?: (name: string) => string | null;
  installListenerServiceFn?: typeof installListenerService;
  verifyFns?: VerifyFns;
  registerFn?: typeof registerHandle;
  publishKeysFn?: (config: Config, keys: StoredKeys, paths: Paths) => Promise<void>;
  publishCardFn?: (config: Config, paths: Paths) => Promise<unknown>;
  log?: (line: string) => void;
}

function normalizeInvite(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted?.[2] ?? trimmed).trim();
}

async function resolveInvite(opts: SetupOpts, ask: (q: string) => Promise<string>): Promise<string> {
  const supplied = opts.invite ?? process.env.AGENTCALL_INVITE;
  const answerable = !opts.yes && (opts.io !== undefined || canPrompt());
  const invite = normalizeInvite(supplied !== undefined ? supplied : answerable ? await ask("Paste your invite: ") : "");
  if (!invite) throw new Error("An organization invite is required. Run `agentcall setup --invite <token>`.");
  return invite;
}

async function detectAgentKind(
  opts: SetupOpts, hasBin: (name: string) => boolean, ask: (q: string) => Promise<string>,
): Promise<AgentKind> {
  if (opts.agent) return opts.agent;
  const hasClaude = hasBin("claude");
  const hasCodex = hasBin("codex");
  if (hasClaude && !hasCodex) return "claude";
  if (hasCodex && !hasClaude) return "codex";
  if (hasClaude && hasCodex) {
    if (opts.yes) return "claude";
    return (await ask("Both claude and codex found on PATH. Which should agentcall use? [claude/codex]: ")).trim().toLowerCase() === "codex"
      ? "codex" : "claude";
  }
  throw new Error("Neither `claude` nor `codex` was found on PATH. Install one, or use --caller-only.");
}

async function decideCallable(
  opts: SetupOpts, hasBin: (name: string) => boolean, ask: (q: string) => Promise<string>, existing?: Config,
): Promise<boolean> {
  if (opts.callerOnly) return false;
  if (existing?.agent_kind || opts.agent) return true;
  if (!hasBin("claude") && !hasBin("codex")) return false;
  if (opts.yes) return true;
  const answer = (await ask("Make your agent callable by others? Offered tasks run automatically. [Y/n]: ")).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

export function warnIfEphemeralServiceBin(name: string, resolveBin: (name: string) => string | null): void {
  const path = resolveBin(name);
  if (path && isEphemeralDir(dirname(path))) {
    console.error(`Warning: ${name} resolves from an ephemeral directory (${path}); install it in a durable location before starting the background listener.`);
  }
}

async function publishStoredKeys(config: Config, keys: StoredKeys, paths: Paths): Promise<void> {
  const auth = { org: config.org, handle: config.handle, token: config.token };
  await publishIdentityKey(config.relay, auth, keys);
  await publishEncryptionKey(config.relay, auth, paths);
}

async function createInstallation(
  paths: Paths, configInput: { handle: string; relay: string; invite: string; agentKind?: AgentKind }, opts: SetupOpts,
): Promise<Config> {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return withFileLock(paths.configFile, "installation credential", async () => {
    if (existsSync(paths.configFile)) return loadConfig(paths);
    const keys = await generateIdentityKeys(paths);
    let registration: Awaited<ReturnType<typeof registerHandle>>;
    try {
      registration = await (opts.registerFn ?? registerHandle)(
        configInput.relay, configInput.invite, configInput.handle, configInput.agentKind,
      );
    } catch (error) {
      rmSync(paths.identityKeyFile, { force: true });
      throw error;
    }
    const config: Config = configInput.agentKind
      ? { org: registration.org, handle: configInput.handle, token: registration.token, relay: configInput.relay, agent_kind: configInput.agentKind }
      : { org: registration.org, handle: configInput.handle, token: registration.token, relay: configInput.relay };
    saveConfig(paths, config);
    writeJsonAtomic(paths.scopeFile, defaultScope(paths.userHome));
    try { await (opts.publishKeysFn ?? publishStoredKeys)(config, keys, paths); }
    catch (error) { console.error(`Warning: keys are stored but could not be published (${String(error)}). Run \`agentcall keys publish\` later.`); }
    return config;
  });
}

async function prepareCallable(config: Config, paths: Paths, opts: SetupOpts, resolveBin: (name: string) => string | null): Promise<void> {
  if (!config.agent_kind) return;
  mkdirSync(paths.shareDir, { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  if (!existsSync(paths.policyFile)) writeJsonAtomic(paths.policyFile, DEFAULT_POLICY);
  try { await (opts.publishCardFn ?? publishCard)(config, paths); }
  catch (error) { console.error(`Warning: could not publish the card (${String(error)}). Run \`agentcall card push\` later.`); }
  if (!opts.skipService) {
    (opts.installListenerServiceFn ?? installListenerService)(paths, {
      extraPathDirs: listenerPathDirs(config.agent_kind, resolveBin),
    });
  }
}

export async function runSetup(opts: SetupOpts): Promise<{ ready: boolean }> {
  const paths = opts.paths ?? getPaths();
  const resolveBin = opts.resolveBin ?? defaultResolveBin;
  const hasBin = opts.hasBin ?? ((name) => resolveBin(name) !== null);
  const ask = opts.io?.ask ?? ttyAsk;
  const log = opts.log ?? console.log;

  let existing: Config | undefined;
  if (existsSync(paths.configFile)) existing = loadConfig(paths);
  else if (existsSync(join(paths.dir, "lines"))) loadInstallation(paths); // fail with explicit migration guidance

  if (existing) {
    if (opts.handle && opts.handle !== existing.handle) throw new Error(`This installation already owns ${existing.handle}; setup cannot replace it with ${opts.handle}.`);
    if (opts.relay && normalizeRelay(existing.relay) !== normalizeRelay(opts.relay)) throw new Error(`This installation is registered with ${existing.relay}; setup cannot move it to ${opts.relay}.`);
    const callable = await decideCallable(opts, hasBin, ask, existing);
    if (callable && !existing.agent_kind) {
      const agentKind = await detectAgentKind(opts, hasBin, ask);
      existing = { ...existing, agent_kind: agentKind };
      saveConfig(paths, existing);
    }
    await prepareCallable(existing, paths, opts, resolveBin);
    log(`agentcall is already set up as ${formatAddress(existing.org, existing.handle)}.`);
    return { ready: true };
  }

  const invite = await resolveInvite(opts, ask);
  const callable = await decideCallable(opts, hasBin, ask);
  const agentKind = callable ? await detectAgentKind(opts, hasBin, ask) : undefined;
  if (agentKind) {
    warnIfEphemeralServiceBin(agentKind, resolveBin);
    warnIfEphemeralServiceBin("npx", resolveBin);
  }
  const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
  if (!handle) throw new Error("A handle is required.");
  const relay = opts.relay?.replace(/\/+$/, "") ?? relayUrl();
  log(`Registering ${handle} with ${relay} ...`);
  const config = await createInstallation(paths, { handle, relay, invite, agentKind }, opts);
  await prepareCallable(config, paths, opts, resolveBin);

  let verifyFailure: VerifyCheck | undefined;
  if (config.agent_kind && opts.verify !== false) {
    log(`\nVerifying ${config.agent_kind} can answer a test call (takes ~10-30s)...`);
    const checks = await verifyAgent(config.agent_kind, workdirFor(loadScope(paths), paths.shareDir, paths.userHome), opts.verifyFns);
    for (const check of checks) log(formatCheck(check));
    verifyFailure = checks.find((check) => !check.ok);
  }
  if (opts.snippet !== false) {
    appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
    appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
  }
  const address = formatAddress(config.org, config.handle);
  if (verifyFailure) {
    console.error(`\nagentcall is set up, but the agent is NOT ready. ${verifyFailure.name}${verifyFailure.detail ? ` — ${verifyFailure.detail}` : ""}`);
    return { ready: false };
  }
  log(config.agent_kind
    ? `\nagentcall is set up.\n  Address: ${address}\n  Agent:   ${config.agent_kind}\n\nShare your address:\n  agentcall call ${address} "hello"\n`
    : `\nagentcall is set up (caller-only).\n  Address: ${address}\n\nInstall claude or codex and re-run \`agentcall setup\` to answer calls.\n`);
  return { ready: true };
}
