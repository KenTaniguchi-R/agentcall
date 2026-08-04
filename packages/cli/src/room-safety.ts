import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import type { AgentKind } from "@benree/agentcall-shared";
import { resolveAgentBin } from "./bin.js";
import { runAgent, type AgentOutput } from "./runner.js";

export interface RoomSafetyTuple {
  agent: AgentKind;
  cliVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

export const ROOM_SAFETY_CONTRACT_VERSION = 1 as const;

export const ROOM_SAFETY_SURFACES = [
  "empty_workdir",
  "repository_instructions",
  "outside_workdir_read",
  "agentcall_state_read",
  "other_temp_read",
  "inherited_session",
  "user_config",
  "plugins",
  "mcp",
  "apps",
  "image_tools",
  "file_tools",
  "write_tools",
  "shell_tools",
  "browser_tools",
  "network_tools",
  "environment_secrets",
  "process_tree_cancellation",
] as const;

export type RoomSafetySurface = (typeof ROOM_SAFETY_SURFACES)[number];
export type RoomSafetySurfaceResults = Readonly<
  Record<Exclude<RoomSafetySurface, "apps">, boolean> &
  { apps: boolean | "not_applicable" }
>;

export const PASSING_ROOM_SAFETY_SURFACES = Object.freeze(Object.fromEntries(
  ROOM_SAFETY_SURFACES.map((surface) => [surface, true]),
)) as Readonly<Record<RoomSafetySurface, true>>;

const ROOM_SAFETY_EVIDENCE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export const ROOM_SAFE_CANCELLATION = Object.freeze({
  detachedProcessGroup: true,
  gracefulSignal: "SIGTERM",
  forceSignal: "SIGKILL",
  graceMs: 10_000,
} as const);

export interface RoomSafetyEvidence extends RoomSafetyTuple {
  contractVersion: typeof ROOM_SAFETY_CONTRACT_VERSION;
  probedAt: string;
  command: string[];
  surfaces: RoomSafetySurfaceResults;
}

export type RoomSafetySupport =
  | { supported: true; evidence: RoomSafetyEvidence }
  | { supported: false; reason: string };

export const ROOM_SAFETY_EVIDENCE: readonly RoomSafetyEvidence[] = [{
  contractVersion: ROOM_SAFETY_CONTRACT_VERSION,
  agent: "claude",
  cliVersion: "2.1.220",
  platform: "darwin",
  arch: "arm64",
  probedAt: "2026-08-04T03:38:30.000Z",
  command: [
    "AGENTCALL_PROBE_ROOM_SAFETY=1",
    "pnpm", "--filter", "@benree/agentcall", "exec", "vitest", "run",
    "test/room-safety.probe.test.ts",
  ],
  surfaces: { ...PASSING_ROOM_SAFETY_SURFACES, apps: "not_applicable" },
}];

const ROOM_SAFE_ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export interface RoomSafeSpawnContract {
  spawn: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
  cancellation: typeof ROOM_SAFE_CANCELLATION;
  evidence: RoomSafetyEvidence;
}

export interface BuildRoomSafeSpawnContractOptions {
  agent: AgentKind;
  platform?: NodeJS.Platform;
  arch?: string;
  evidenceCatalog?: readonly RoomSafetyEvidence[];
  prompt: string;
  workdir: string;
  resolveBin?: (agent: AgentKind) => string;
  readVersion?: (bin: string) => string;
  env: NodeJS.ProcessEnv;
}

export interface BuildRoomSafetyProbeSpawnOptions {
  agent: AgentKind;
  prompt: string;
  workdir: string;
  resolveBin?: (agent: AgentKind) => string;
  env: NodeJS.ProcessEnv;
}

export interface RunRoomSafeAgentOptions {
  agent: AgentKind;
  prompt: string;
  workdir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

function assertEmptyRoomWorkdir(workdir: string): void {
  const workdirStat = lstatSync(workdir);
  if (workdirStat.isSymbolicLink() || !workdirStat.isDirectory() || readdirSync(workdir).length !== 0) {
    throw new Error("Room safe workdir must be an empty directory");
  }
}

function roomSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ROOM_SAFE_ENV_KEYS.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** Candidate command for the opt-in live probe. Never use this to admit a Room participant. */
export function buildRoomSafetyProbeSpawn(
  options: BuildRoomSafetyProbeSpawnOptions,
): RoomSafeSpawnContract["spawn"] {
  if (options.agent !== "claude") throw new Error(`no Room safety probe adapter for ${options.agent}`);
  if ("resume" in options || "continue" in options || "sessionId" in options) {
    throw new Error("Room safe mode does not accept inherited sessions");
  }
  assertEmptyRoomWorkdir(options.workdir);
  return {
    cmd: (options.resolveBin ?? resolveAgentBin)("claude"),
    args: [
      "-p", options.prompt, "--output-format", "json",
      "--permission-mode", "dontAsk", "--tools", "",
      "--safe-mode", "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-chrome", "--disable-slash-commands",
    ],
    cwd: options.workdir,
    env: roomSafeEnvironment(options.env),
  };
}

export function roomSafetySupport(
  tuple: RoomSafetyTuple,
  evidenceCatalog: readonly RoomSafetyEvidence[] = ROOM_SAFETY_EVIDENCE,
  now: Date = new Date(),
): RoomSafetySupport {
  const evidence = evidenceCatalog.find((candidate) =>
    candidate.agent === tuple.agent &&
    candidate.cliVersion === tuple.cliVersion &&
    candidate.platform === tuple.platform &&
    candidate.arch === tuple.arch
  );
  if (evidence) {
    if (evidence.contractVersion !== ROOM_SAFETY_CONTRACT_VERSION) {
      return {
        supported: false,
        reason: `Room safety evidence uses contract ${evidence.contractVersion}; expected ${ROOM_SAFETY_CONTRACT_VERSION}`,
      };
    }
    if (evidence.command.length === 0 || evidence.command.some((part) => part.length === 0)) {
      return { supported: false, reason: "Room safety evidence has no probe command" };
    }
    const probedAtMs = Date.parse(evidence.probedAt);
    if (!Number.isFinite(probedAtMs) || new Date(probedAtMs).toISOString() !== evidence.probedAt || probedAtMs > now.getTime()) {
      return { supported: false, reason: "Room safety evidence has an invalid probe timestamp" };
    }
    if (now.getTime() - probedAtMs > ROOM_SAFETY_EVIDENCE_MAX_AGE_MS) {
      return { supported: false, reason: "Room safety evidence is stale (older than 90 days)" };
    }
    const rawSurfaces = evidence.surfaces as Readonly<Record<string, unknown>>;
    const invalidNotApplicable = ROOM_SAFETY_SURFACES.find((surface) =>
      surface !== "apps" && rawSurfaces[surface] === "not_applicable");
    if (invalidNotApplicable) {
      return {
        supported: false,
        reason: `Room safety evidence cannot mark ${invalidNotApplicable} as not_applicable`,
      };
    }
    const failedSurface = ROOM_SAFETY_SURFACES.find((surface) =>
      rawSurfaces[surface] !== true && rawSurfaces[surface] !== "not_applicable");
    if (failedSurface) return { supported: false, reason: `Room safety evidence failed: ${failedSurface}` };
    return { supported: true, evidence };
  }
  return {
    supported: false,
    reason: `no Room safety evidence for ${tuple.agent} ${tuple.cliVersion} on ${tuple.platform}/${tuple.arch}`,
  };
}

export function buildRoomSafeSpawnContract(
  options: BuildRoomSafeSpawnContractOptions,
): RoomSafeSpawnContract {
  const resolveBin = options.resolveBin ?? resolveAgentBin;
  const bin = resolveBin(options.agent);
  const readVersion = options.readVersion ?? ((path: string) =>
    execFileSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const cliVersion = readVersion(bin).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (!cliVersion) throw new Error(`could not determine Room safety version for ${options.agent}`);
  const tuple: RoomSafetyTuple = {
    agent: options.agent,
    cliVersion,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
  };
  const support = roomSafetySupport(tuple, options.evidenceCatalog);
  if (!support.supported) throw new Error(support.reason);
  if (tuple.agent !== "claude") {
    throw new Error(`no Room safe spawn adapter for ${tuple.agent}`);
  }
  return {
    spawn: buildRoomSafetyProbeSpawn({
      agent: tuple.agent,
      prompt: options.prompt,
      workdir: options.workdir,
      resolveBin: () => bin,
      env: options.env,
    }),
    cancellation: ROOM_SAFE_CANCELLATION,
    evidence: support.evidence,
  };
}

/** Derive and execute a Room spawn; caller-supplied command specs are never accepted. */
export function runRoomSafeAgent(
  options: RunRoomSafeAgentOptions,
): Promise<AgentOutput> {
  const contract = buildRoomSafeSpawnContract({
    agent: options.agent,
    prompt: options.prompt,
    workdir: options.workdir,
    env: options.env,
  });
  return runAgent(
    "claude", "", contract.spawn.cwd, options.timeoutMs, contract.spawn,
    undefined, "room", options.signal, "room",
  );
}
