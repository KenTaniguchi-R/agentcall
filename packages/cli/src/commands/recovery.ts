import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { ReadStream, WriteStream } from "node:tty";
import { z } from "zod";
import {
  ORG_RE, HANDLE_RE, CLIENT_PUBLIC_ID_RE, RECOVERY_PUBLIC_ID_RE, SHA256_HEX_RE,
  RecoveryReceipt, type RecoveryIssueRequestType,
  type RecoveryIssueResponseType, type RecoveryRedeemRequestType, type RecoveryReceiptType,
} from "@benree/agentcall-shared";
import { authOf, getRecoveryStatus, issueRecovery, redeemRecovery } from "../api.js";
import { normalizeRelay, type LineConfig } from "../config.js";
import { removeFileDurable, writeJsonDurable } from "../json-store.js";
import { loadLineConfig } from "../lines.js";
import type { LinePaths } from "../paths.js";
import { ask as ttyAsk, createPrompter } from "../tty.js";
import { withFileLock } from "../file-lock.js";

const PendingRecovery = z.object({
  org: z.string().regex(ORG_RE), handle: z.string().regex(HANDLE_RE), relay: z.string().url(),
  generation: z.number().int().positive(), operation_id: z.string().min(22).max(64),
  candidate_token: z.string().min(32), candidate_token_digest: z.string().regex(SHA256_HEX_RE),
  client_public_id: z.string().regex(CLIENT_PUBLIC_ID_RE),
  successor_recovery_digest: z.string().regex(SHA256_HEX_RE),
  successor_recovery_public_id: z.string().regex(RECOVERY_PUBLIC_ID_RE),
}).strict();
type PendingRecoveryType = z.infer<typeof PendingRecovery>;

type RecoveryTarget = {
  name: string; paths: LinePaths; config?: LineConfig;
  org?: string; handle?: string; relay?: string; generation?: number; resume?: boolean;
};

type CommonDeps = {
  randomSecret?: () => string;
  displaySecret?: (proof: string) => void;
  ask?: (question: string) => Promise<string>;
  log?: (line: string) => void;
};

type RecoveryIssueDeps = CommonDeps & {
  issue?: typeof issueRecovery;
  status?: typeof getRecoveryStatus;
};
type RecoveryRedeemDeps = CommonDeps & { redeem?: typeof redeemRecovery };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const generatedSecret = () => randomBytes(32).toString("base64url");
const publicId = (kind: "act" | "agr", valueDigest: string) => `${kind}_${valueDigest.slice(0, 16)}`;

function displayOnControllingTty(proof: string): void {
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", "w");
    writeSync(fd, `\nRecovery proof (save out of band; it is not stored by AgentCall):\n\n  ${proof}\n\n`);
  } catch {
    throw new Error("A controlling terminal is required to display a recovery proof safely.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type RecoveryPromptStreams = {
  input: NodeJS.ReadableStream & { ref?(): void; unref?(): void };
  output: NodeJS.WritableStream;
};

function openRecoveryTty(): RecoveryPromptStreams {
  try {
    const fd = openSync("/dev/tty", "r+");
    return { input: new ReadStream(fd), output: new WriteStream(fd) };
  } catch {
    throw new Error("A controlling terminal is required to enter recovery proofs safely.");
  }
}

export function createRecoveryPrompter(
  open: () => RecoveryPromptStreams = openRecoveryTty,
): (question: string) => Promise<string> {
  return createPrompter(open);
}

const recoveryAsk = createRecoveryPrompter();

function identity(target: RecoveryTarget): { org: string; handle: string; relay: string } {
  if (target.config && (
    (target.org !== undefined && target.org !== target.config.org) ||
    (target.handle !== undefined && target.handle !== target.config.handle) ||
    (target.relay !== undefined && normalizeRelay(target.relay) !== normalizeRelay(target.config.relay))
  )) {
    throw new Error(`Line "${target.name}" belongs to ${target.config.handle} in ${target.config.org}; refusing a different recovery target.`);
  }
  const org = target.org ?? target.config?.org;
  const handle = target.handle ?? target.config?.handle;
  const relay = target.relay ?? target.config?.relay;
  if (!org || !handle || !relay) throw new Error("Recovery requires --org, --handle, and --relay when the line config is missing.");
  return { org, handle, relay: normalizeRelay(relay) };
}

function readPending(paths: LinePaths): PendingRecoveryType {
  if (!existsSync(paths.recoveryPendingFile)) throw new Error("No pending recovery operation exists for this line.");
  const stat = lstatSync(paths.recoveryPendingFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The pending recovery file must be a regular file, not a symlink.");
  try {
    return PendingRecovery.parse(JSON.parse(readFileSync(paths.recoveryPendingFile, "utf8")));
  } catch (error) {
    throw new Error(`Pending recovery state is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runRecoveryIssue(
  target: RecoveryTarget, deps: RecoveryIssueDeps = {},
): Promise<{ generation: number }> {
  if (!target.config) throw new Error("Recovery proof issue/reissue requires a working line credential.");
  const relay = normalizeRelay(target.config.relay);
  const auth = authOf(target.config);
  const current = await (deps.status ?? getRecoveryStatus)(relay, auth);
  const randomSecret = deps.randomSecret ?? generatedSecret;
  const proof = randomSecret();
  (deps.displaySecret ?? displayOnControllingTty)(proof);
  const answer = await (deps.ask ?? ttyAsk)("Type SAVED after storing the proof somewhere separate from AgentCall: ");
  if (answer.trim() !== "SAVED") throw new Error("Recovery proof was not acknowledged; type SAVED to issue it.");
  const proofDigest = digest(proof);
  const request: RecoveryIssueRequestType = {
    expected_generation: current.generation,
    successor_recovery_digest: proofDigest,
    successor_recovery_public_id: publicId("agr", proofDigest),
  };
  const result: RecoveryIssueResponseType = await (deps.issue ?? issueRecovery)(
    relay, auth, request,
  );
  (deps.log ?? console.log)(
    `Recovery generation ${result.generation} issued for line "${target.name}". ` +
      `Record generation ${result.generation} with proof ID ${result.recovery_public_id}.`,
  );
  return { generation: result.generation };
}

function makePending(target: RecoveryTarget, randomSecret: () => string): { pending: PendingRecoveryType; successor: string } {
  const id = identity(target);
  if (!target.generation) throw new Error("A positive recovery generation is required for a new recovery operation.");
  const candidate = randomSecret();
  const successor = randomSecret();
  const operationId = randomSecret();
  const candidateDigest = digest(candidate);
  const successorDigest = digest(successor);
  return {
    successor,
    pending: {
      ...id, generation: target.generation, operation_id: operationId,
      candidate_token: candidate, candidate_token_digest: candidateDigest,
      client_public_id: publicId("act", candidateDigest),
      successor_recovery_digest: successorDigest,
      successor_recovery_public_id: publicId("agr", successorDigest),
    },
  };
}

function exactReceipt(receipt: RecoveryReceiptType, pending: PendingRecoveryType): boolean {
  return receipt.org === pending.org && receipt.handle === pending.handle &&
    receipt.operation_id === pending.operation_id && receipt.consumed_generation === pending.generation &&
    receipt.recovery_generation === pending.generation + 1 &&
    receipt.client_public_id === pending.client_public_id &&
    receipt.recovery_public_id === pending.successor_recovery_public_id;
}

async function runRecoveryRedeemLocked(target: RecoveryTarget, deps: RecoveryRedeemDeps): Promise<void> {
  const randomSecret = deps.randomSecret ?? generatedSecret;
  const ask = deps.ask ?? recoveryAsk;
  let pending: PendingRecoveryType;
  let currentProof: string;

  if (target.resume) {
    pending = readPending(target.paths);
    if (target.config && (
      target.config.org !== pending.org || target.config.handle !== pending.handle ||
      normalizeRelay(target.config.relay) !== normalizeRelay(pending.relay)
    )) {
      throw new Error(`Line "${target.name}" belongs to ${target.config.handle} in ${target.config.org}; refusing to resume a different recovery target.`);
    }
    currentProof = (await ask("Current (predecessor) recovery proof: ")).trim();
    const successorProof = (await ask("Successor recovery proof retained from the interrupted operation: ")).trim();
    if (digest(successorProof) !== pending.successor_recovery_digest) {
      throw new Error("The successor proof does not match the acknowledged pending recovery operation.");
    }
  } else {
    if (existsSync(target.paths.recoveryPendingFile)) {
      throw new Error(`A pending recovery already exists for line "${target.name}"; rerun with --resume.`);
    }
    const created = makePending(target, randomSecret);
    (deps.displaySecret ?? displayOnControllingTty)(created.successor);
    const answer = await ask("Type SAVED after storing the successor proof beside the current proof: ");
    if (answer.trim() !== "SAVED") throw new Error("Successor recovery proof was not acknowledged; no relay change was made.");
    pending = created.pending;
    // Persist the candidate before asking for the predecessor or contacting the relay.
    writeJsonDurable(target.paths.recoveryPendingFile, pending);
    currentProof = (await ask("Current (predecessor) recovery proof: ")).trim();
  }
  if (currentProof.length < 32) throw new Error("The current recovery proof is invalid.");

  const request: RecoveryRedeemRequestType = {
    org: pending.org, handle: pending.handle, generation: pending.generation,
    current_recovery_proof: currentProof, operation_id: pending.operation_id,
    client_token_digest: pending.candidate_token_digest, client_public_id: pending.client_public_id,
    successor_recovery_digest: pending.successor_recovery_digest,
    successor_recovery_public_id: pending.successor_recovery_public_id,
  };
  const receipt = RecoveryReceipt.parse(await (deps.redeem ?? redeemRecovery)(pending.relay, request));
  if (!exactReceipt(receipt, pending)) throw new Error("Relay returned a receipt for a different recovery operation.");

  const existing = target.config;
  if (existing && (
    existing.org !== pending.org || existing.handle !== pending.handle ||
    normalizeRelay(existing.relay) !== normalizeRelay(pending.relay)
  )) {
    throw new Error(`Line "${target.name}" belongs to ${existing.handle} in ${existing.org}; refusing to overwrite it.`);
  }
  const next: LineConfig = existing
    ? { ...existing, org: pending.org, handle: pending.handle, relay: pending.relay, token: pending.candidate_token }
    : { org: pending.org, handle: pending.handle, relay: pending.relay, token: pending.candidate_token };
  writeJsonDurable(target.paths.configFile, next);
  removeFileDurable(target.paths.recoveryPendingFile);
  (deps.log ?? console.log)(
    `Recovery committed for ${pending.handle} (client ${receipt.client_public_id}, recovery generation ` +
      `${receipt.recovery_generation}). ${receipt.eviction_confirmed ? "The recovered identity's current Durable Object applied its session-eviction tombstone." : "Current identity session eviction is pending; reconnect is already blocked."} ` +
      "The predecessor proof may now be removed from the out-of-band backup.",
  );
}

export async function runRecoveryRedeem(target: RecoveryTarget, deps: RecoveryRedeemDeps = {}): Promise<void> {
  // Creating the directory reserves a missing line against `line add`, whose
  // exclusive mkdir is its own cross-process claim. Existing credential
  // writers use this same config sidecar lock.
  mkdirSync(target.paths.dir, { recursive: true, mode: 0o700 });
  const dir = lstatSync(target.paths.dir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error(`Line "${target.name}" directory must be a real directory, not a symlink.`);
  }
  return withFileLock(target.paths.configFile, "line credential", async () => {
    const config = existsSync(target.paths.configFile) ? loadLineConfig(target.paths) : undefined;
    return runRecoveryRedeemLocked({ ...target, config }, deps);
  });
}
