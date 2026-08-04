import {
  basename, join,
} from "node:path";
import {
  closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { z } from "zod";
import {
  EncryptionKeyRecord, exportPublicKey, generateEncryptionKeyPair, generateIdentityKeyPair,
  toBase64Url,
} from "@benree/agentcall-shared";
import { assertPrivateFile, writeJsonAtomic } from "./json-store.js";
import type { LinePaths } from "./paths.js";

const HASH = /^[0-9a-f]{32}$/;

const InitialKeyFileSchema = z.object({
  identity_pkcs8: z.string().min(1),
  identity_pub: z.string().min(1),
  encryption_pkcs8: z.string().min(1),
  encryption_pub: z.string().min(1),
  epoch: z.literal(1),
  previous_encryption_transcript_hash: z.null(),
}).strict();

const IdentityKeyFileSchema = z.object({
  format: z.literal(2),
  identity_pkcs8: z.string().min(1),
  identity_pub: z.string().min(1),
}).strict();

const ActiveEpochStateSchema = z.object({
  state: z.literal("active"),
  encryption_pkcs8: z.string().min(1),
  encryption_pub: z.string().min(1),
  epoch: z.number().int().min(2),
  previous_encryption_transcript_hash: z.string().regex(HASH),
}).strict();
type ActiveEpochState = z.infer<typeof ActiveEpochStateSchema>;

const RetiredEpochStateSchema = z.object({
  state: z.literal("retired"),
  encryption_pub: z.string().min(1),
  epoch: z.number().int().min(2),
  previous_encryption_transcript_hash: z.string().regex(HASH),
}).strict();
type RetiredEpochState = z.infer<typeof RetiredEpochStateSchema>;

const EpochStateSchema = z.union([ActiveEpochStateSchema, RetiredEpochStateSchema]);

const PublishedEpochSchema = z.object({
  epoch: z.number().int().positive(),
  encryption_pub: z.string().min(1),
  previous_encryption_transcript_hash: z.string().regex(HASH).nullable(),
  transcript_hash: z.string().regex(HASH),
}).strict();
type PublishedEpoch = z.infer<typeof PublishedEpochSchema>;

const StoredKeysSchema = z.object({
  identity_pkcs8: z.string().min(1),
  identity_pub: z.string().min(1),
  encryption_pkcs8: z.string().min(1),
  encryption_pub: z.string().min(1),
  epoch: z.number().int().positive(),
  previous_encryption_transcript_hash: z.string().regex(HASH).nullable(),
  published_encryption_transcript_hash: z.string().regex(HASH).optional(),
}).superRefine((keys, ctx) => {
  if ((keys.epoch === 1) !== (keys.previous_encryption_transcript_hash === null)) {
    ctx.addIssue({
      code: "custom", path: ["previous_encryption_transcript_hash"],
      message: "only epoch 1 may omit the previous transcript",
    });
  }
});
export type StoredKeys = z.infer<typeof StoredKeysSchema>;

const PendingEncryptionPublicationSchema = z.object({
  record: EncryptionKeyRecord,
  signature: z.string().min(1).max(256),
}).strict();
type PendingEncryptionPublication = z.infer<typeof PendingEncryptionPublicationSchema>;

type KeyRotationHooks = {
  /** Test seam for a process paused after election but before predecessor retirement. */
  afterElection?: () => void | Promise<void>;
  /** Test seam for exercising an abandoned cross-process election lock. */
  electionWaitMs?: number;
};

function epochStateFile(paths: LinePaths, epoch: number): string {
  return `${paths.identityKeyFile}.epoch-${epoch}.state.json`;
}

function pendingPublicationFile(paths: LinePaths, epoch: number): string {
  return `${paths.identityKeyFile}.epoch-${epoch}.pending.json`;
}

function publishedEpochFile(paths: LinePaths, epoch: number): string {
  return `${paths.identityKeyFile}.epoch-${epoch}.published.json`;
}

function waitForElectionSlot(file: string, waitMs = 5_000): void {
  const lock = `${file}.lock`;
  if (!existsSync(lock)) return;
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (existsSync(lock) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
  if (existsSync(lock)) {
    throw new Error(`Encryption-key election lock ${lock} did not clear; refusing partial state.`);
  }
  try {
    const serialized = readFileSync(file, "utf8");
    if (!serialized.endsWith("\n")) throw new Error("incomplete write");
    JSON.parse(serialized);
  } catch {
    throw new Error(`Encryption-key election slot ${file} is incomplete; refusing partial state.`);
  }
}

function readJson(file: string): unknown {
  waitForElectionSlot(file);
  assertPrivateFile(file, { checkDir: false });
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} could not be read as JSON.`);
  }
}

function installFirstWriterWins<T>(file: string, candidate: T, waitMs = 5_000): void {
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    waitForElectionSlot(file, waitMs);
    return;
  }

  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    try { rmdirSync(lock); } catch { /* preserve the original open failure */ }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }

  let failure: unknown;
  try {
    // The exclusive destination is itself the election slot. This avoids a
    // private candidate or temp sidecar that process death could strand
    // outside the epoch scanner. A crash during this write leaves the
    // canonical slot corrupt, so all later loads fail closed.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(candidate, null, 2)}\n`);
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    try {
      unlinkSync(file);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], `Could not clean up incomplete election slot ${file}.`);
    }
    try { rmdirSync(lock); } catch { /* the incomplete canonical slot already fails closed */ }
    throw failure;
  }
  rmdirSync(lock);
}

function listEpochStates(paths: LinePaths): Array<ActiveEpochState | RetiredEpochState> {
  const prefix = `${basename(paths.identityKeyFile)}.epoch-`;
  const suffix = ".state.json";
  const states: Array<ActiveEpochState | RetiredEpochState> = [];
  for (const name of readdirSync(paths.dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const epochText = name.slice(prefix.length, -suffix.length);
    if (!/^[1-9]\d*$/.test(epochText)) continue;
    const file = join(paths.dir, name);
    const state = EpochStateSchema.safeParse(readJson(file));
    if (!state.success || state.data.epoch !== Number(epochText)) {
      throw new Error(`${file} could not be read: unexpected contents.`);
    }
    states.push(state.data);
  }
  return states;
}

function loadIdentityRoot(paths: LinePaths): {
  identity_pkcs8: string;
  identity_pub: string;
  initial?: z.infer<typeof InitialKeyFileSchema>;
} {
  if (!existsSync(paths.identityKeyFile)) {
    throw new Error(`${paths.identityKeyFile} does not exist. Run \`agentcall setup\` first.`);
  }
  const raw = readJson(paths.identityKeyFile);
  const stable = IdentityKeyFileSchema.safeParse(raw);
  if (stable.success) return stable.data;
  const initial = InitialKeyFileSchema.safeParse(raw);
  if (initial.success) return {
    identity_pkcs8: initial.data.identity_pkcs8,
    identity_pub: initial.data.identity_pub,
    initial: initial.data,
  };
  if (
    typeof raw === "object" && raw !== null && "epoch" in raw && raw.epoch === 1 &&
    !("previous_encryption_transcript_hash" in raw)
  ) {
    throw new Error(
      `${paths.identityKeyFile} uses the pre-chain key format and cannot safely retry its ` +
        "published epoch. Keep this state for recovery, then enroll a new handle with a new invite; " +
        "the relay will not let `agentcall setup` replace this handle's pinned identity.",
    );
  }
  throw new Error(`${paths.identityKeyFile} could not be read: unexpected contents.`);
}

function loadPublishedEpoch(paths: LinePaths, current: StoredKeys): PublishedEpoch | undefined {
  const file = publishedEpochFile(paths, current.epoch);
  if (!existsSync(file)) return undefined;
  const parsed = PublishedEpochSchema.safeParse(readJson(file));
  if (
    !parsed.success || parsed.data.epoch !== current.epoch ||
    parsed.data.encryption_pub !== current.encryption_pub ||
    parsed.data.previous_encryption_transcript_hash !== current.previous_encryption_transcript_hash
  ) {
    throw new Error(`The published encryption-key marker for epoch ${current.epoch} is inconsistent.`);
  }
  return parsed.data;
}

function retireEpoch(paths: LinePaths, keys: StoredKeys): void {
  if (keys.epoch === 1) {
    const root = loadIdentityRoot(paths);
    if (!root.initial) return;
    if (
      root.initial.identity_pub !== keys.identity_pub ||
      root.initial.identity_pkcs8 !== keys.identity_pkcs8 ||
      root.initial.encryption_pub !== keys.encryption_pub ||
      root.initial.encryption_pkcs8 !== keys.encryption_pkcs8
    ) throw new Error("The initial encryption-key state changed while retirement was in flight.");
    writeJsonAtomic(paths.identityKeyFile, {
      format: 2, identity_pkcs8: keys.identity_pkcs8, identity_pub: keys.identity_pub,
    });
    return;
  }

  const file = epochStateFile(paths, keys.epoch);
  const parsed = EpochStateSchema.safeParse(readJson(file));
  if (!parsed.success) throw new Error(`The encryption-key state for epoch ${keys.epoch} is corrupt.`);
  if (parsed.data.state === "retired") return;
  if (
    parsed.data.encryption_pub !== keys.encryption_pub ||
    parsed.data.encryption_pkcs8 !== keys.encryption_pkcs8 ||
    parsed.data.previous_encryption_transcript_hash !== keys.previous_encryption_transcript_hash
  ) throw new Error(`The encryption-key state for epoch ${keys.epoch} changed before retirement.`);
  const retired: RetiredEpochState = {
    state: "retired",
    encryption_pub: parsed.data.encryption_pub,
    epoch: parsed.data.epoch,
    previous_encryption_transcript_hash: parsed.data.previous_encryption_transcript_hash,
  };
  writeJsonAtomic(file, retired);
}

function parsePendingForCurrent(raw: unknown, current: StoredKeys): PendingEncryptionPublication {
  const pending = PendingEncryptionPublicationSchema.parse(raw);
  if (
    pending.record.epoch !== current.epoch ||
    pending.record.pub !== current.encryption_pub ||
    pending.record.prev !== current.previous_encryption_transcript_hash
  ) throw new Error("The pending publication does not match the current encryption key.");
  return pending;
}

export function loadPendingEncryptionPublication(
  paths: LinePaths, current: StoredKeys = loadKeys(paths),
): PendingEncryptionPublication | undefined {
  const file = pendingPublicationFile(paths, current.epoch);
  if (!existsSync(file)) return undefined;
  return parsePendingForCurrent(readJson(file), current);
}

/** First writer elects the exact signed public record for this immutable epoch. */
export function choosePendingEncryptionPublication(
  paths: LinePaths, candidate: PendingEncryptionPublication,
): { keys: StoredKeys; publication?: PendingEncryptionPublication } {
  const current = loadKeys(paths);
  if (current.published_encryption_transcript_hash) return { keys: current };
  parsePendingForCurrent(candidate, current);
  installFirstWriterWins(pendingPublicationFile(paths, current.epoch), candidate);
  const publication = loadPendingEncryptionPublication(paths, current);
  if (!publication) throw new Error("Could not persist the pending encryption-key publication.");
  return { keys: current, publication };
}

async function exportPrivate(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));
}

/** First-time setup writes one atomic epoch-1 identity/encryption state. */
export async function generateIdentityKeys(paths: LinePaths): Promise<StoredKeys> {
  if (keysExist(paths)) {
    throw new Error(
      `${paths.identityKeyFile} already exists. Refusing to overwrite it: replacing the ` +
        `identity key would orphan every contact who has pinned it, and the relay will not ` +
        `accept a replacement. To rotate the encryption key instead, use rotateEncryptionKey.`,
    );
  }
  const identity = await generateIdentityKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const keys: StoredKeys = {
    identity_pkcs8: await exportPrivate(identity.privateKey),
    identity_pub: await exportPublicKey(identity.publicKey),
    encryption_pkcs8: await exportPrivate(encryption.privateKey),
    encryption_pub: await exportPublicKey(encryption.publicKey),
    epoch: 1,
    previous_encryption_transcript_hash: null,
  };
  writeJsonAtomic(paths.identityKeyFile, keys);
  return keys;
}

/**
 * Elects one immutable next-epoch private state, then retires the predecessor
 * to a public tombstone. No stale process ever rewrites a mutable current file;
 * the highest active epoch is current and lower private states are scrubbed.
 */
export async function rotateEncryptionKey(
  paths: LinePaths, hooks: KeyRotationHooks = {},
): Promise<StoredKeys> {
  const base = loadKeys(paths);
  if (!base.published_encryption_transcript_hash) {
    throw new Error(
      `Encryption-key epoch ${base.epoch} has not been published successfully. ` +
        `Refusing to rotate because the next epoch would have no trustworthy transcript link.`,
    );
  }
  const targetEpoch = base.epoch + 1;
  const encryption = await generateEncryptionKeyPair();
  const candidate: ActiveEpochState = {
    state: "active",
    encryption_pkcs8: await exportPrivate(encryption.privateKey),
    encryption_pub: await exportPublicKey(encryption.publicKey),
    epoch: targetEpoch,
    previous_encryption_transcript_hash: base.published_encryption_transcript_hash,
  };
  const targetFile = epochStateFile(paths, targetEpoch);
  installFirstWriterWins(targetFile, candidate, hooks.electionWaitMs);
  const elected = EpochStateSchema.safeParse(readJson(targetFile));
  if (!elected.success) throw new Error(`The elected encryption-key epoch ${targetEpoch} is corrupt.`);
  if (elected.data.state === "retired") {
    const current = loadKeys(paths);
    if (current.epoch > targetEpoch && current.identity_pub === base.identity_pub) return current;
    throw new Error(`Encryption-key epoch ${targetEpoch} retired without a successor.`);
  }
  if (
    elected.data.epoch !== targetEpoch ||
    elected.data.previous_encryption_transcript_hash !== base.published_encryption_transcript_hash
  ) throw new Error("The elected encryption-key rotation does not extend the current chain.");

  await hooks.afterElection?.();
  retireEpoch(paths, base);
  return loadKeys(paths);
}

/** Persist relay acceptance as an immutable public marker for this exact epoch. */
export function rememberPublishedEncryptionKey(
  paths: LinePaths, expected: StoredKeys, transcriptHash: string,
): StoredKeys {
  if (!HASH.test(transcriptHash)) throw new Error("The published encryption transcript hash is malformed.");
  const root = loadIdentityRoot(paths);
  if (root.identity_pub !== expected.identity_pub || root.identity_pkcs8 !== expected.identity_pkcs8) {
    throw new Error("The identity changed while encryption-key publication was in flight.");
  }
  const marker: PublishedEpoch = {
    epoch: expected.epoch,
    encryption_pub: expected.encryption_pub,
    previous_encryption_transcript_hash: expected.previous_encryption_transcript_hash,
    transcript_hash: transcriptHash,
  };
  const file = publishedEpochFile(paths, expected.epoch);
  installFirstWriterWins(file, marker);
  const persisted = PublishedEpochSchema.safeParse(readJson(file));
  if (
    !persisted.success || persisted.data.epoch !== marker.epoch ||
    persisted.data.encryption_pub !== marker.encryption_pub ||
    persisted.data.previous_encryption_transcript_hash !== marker.previous_encryption_transcript_hash ||
    persisted.data.transcript_hash !== marker.transcript_hash
  ) {
    throw new Error(`Encryption-key epoch ${expected.epoch} was acknowledged with a different transcript.`);
  }
  return loadKeys(paths);
}

export function keysExist(paths: LinePaths): boolean {
  return existsSync(paths.identityKeyFile);
}

/** Loads the highest elected private epoch and scrubs every superseded private state. */
export function loadKeys(paths: LinePaths): StoredKeys {
  const root = loadIdentityRoot(paths);
  const states = listEpochStates(paths);
  const highestState = states.reduce((highest, state) => Math.max(highest, state.epoch), 0);
  const active = states.filter((state): state is ActiveEpochState => state.state === "active")
    .sort((left, right) => right.epoch - left.epoch);
  const highest = active[0];
  let current: StoredKeys;
  if (highest) {
    current = {
      identity_pkcs8: root.identity_pkcs8,
      identity_pub: root.identity_pub,
      encryption_pkcs8: highest.encryption_pkcs8,
      encryption_pub: highest.encryption_pub,
      epoch: highest.epoch,
      previous_encryption_transcript_hash: highest.previous_encryption_transcript_hash,
    };
  } else if (root.initial) {
    current = {
      identity_pkcs8: root.initial.identity_pkcs8,
      identity_pub: root.initial.identity_pub,
      encryption_pkcs8: root.initial.encryption_pkcs8,
      encryption_pub: root.initial.encryption_pub,
      epoch: 1,
      previous_encryption_transcript_hash: null,
    };
  } else {
    throw new Error("The identity has no active encryption-key epoch.");
  }
  if (highestState > current.epoch) {
    throw new Error(`Encryption-key epoch ${highestState} retired without an active successor.`);
  }

  // A crash after installing the successor but before retirement can leave
  // lower private states. The successor is already the immutable winner, so
  // replacing each predecessor with a public tombstone is safe and idempotent.
  if (root.initial && current.epoch > 1) retireEpoch(paths, {
    ...root.initial, previous_encryption_transcript_hash: null,
  });
  for (const stale of active.slice(1)) retireEpoch(paths, {
    identity_pkcs8: root.identity_pkcs8,
    identity_pub: root.identity_pub,
    encryption_pkcs8: stale.encryption_pkcs8,
    encryption_pub: stale.encryption_pub,
    epoch: stale.epoch,
    previous_encryption_transcript_hash: stale.previous_encryption_transcript_hash,
  });

  const published = loadPublishedEpoch(paths, current);
  if (published) current.published_encryption_transcript_hash = published.transcript_hash;
  return StoredKeysSchema.parse(current);
}
