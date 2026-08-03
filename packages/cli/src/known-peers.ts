import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  encryptionKeyTranscript, fingerprint, identityTranscript, importIdentityPublicKey,
  verifyTranscript, type EncryptionKeyRecordType, type IdentityRecordType,
} from "@benree/agentcall-shared";
import { writeJsonAtomic } from "./json-store.js";
import type { MachinePaths } from "./paths.js";

export const MAX_KNOWN_PEERS = 10_000;

const KnownPeerSchema = z.object({
  address: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}@[a-z0-9.-]{1,253}$/),
  identity_pub: z.string().regex(/^[A-Za-z0-9_-]+$/).max(256),
  fingerprint: z.string().regex(/^SHA256:[0-9a-f]{32}$/),
  first_seen_at: z.number().int().nonnegative(),
  highest_encryption_epoch: z.number().int().positive(),
  call_count: z.number().int().nonnegative(),
});
const KnownPeersSchema = z.object({ peers: z.array(KnownPeerSchema).max(MAX_KNOWN_PEERS) }).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const peer of value.peers) {
    if (seen.has(peer.address)) ctx.addIssue({ code: "custom", message: `duplicate peer address ${peer.address}` });
    seen.add(peer.address);
  }
});
export type KnownPeer = z.infer<typeof KnownPeerSchema>;

function assertStorePermissions(machine: MachinePaths): void {
  if (!existsSync(machine.knownPeersFile)) return;
  const dirMode = statSync(machine.dir).mode & 0o777;
  if (dirMode !== 0o700) {
    throw new Error(`${machine.dir} has permission ${dirMode.toString(8)}; expected 700. Run: chmod 700 ${machine.dir}`);
  }
  const mode = statSync(machine.knownPeersFile).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${machine.knownPeersFile} has permission ${mode.toString(8)}; expected 600. Run: chmod 600 ${machine.knownPeersFile}`);
  }
}

export function loadKnownPeers(machine: MachinePaths): KnownPeer[] {
  if (!existsSync(machine.knownPeersFile)) return [];
  assertStorePermissions(machine);
  try {
    return KnownPeersSchema.parse(JSON.parse(readFileSync(machine.knownPeersFile, "utf8"))).peers;
  } catch (error) {
    throw new Error(`Corrupt known-peer trust store at ${machine.knownPeersFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveKnownPeers(machine: MachinePaths, peers: KnownPeer[]): void {
  writeJsonAtomic(machine.knownPeersFile, KnownPeersSchema.parse({ peers }));
  chmodSync(machine.dir, 0o700);
}

const LOCK_WAIT_MS = 10_000;

async function withStoreLock<T>(machine: MachinePaths, operation: () => Promise<T>): Promise<T> {
  // Never silently repair permissions around an existing trust root. If it
  // may have been exposed, fail closed and make the owner inspect it first.
  if (existsSync(machine.knownPeersFile)) {
    assertStorePermissions(machine);
  } else {
    mkdirSync(machine.dir, { recursive: true, mode: 0o700 });
    chmodSync(machine.dir, 0o700);
  }
  const lockFile = `${machine.knownPeersFile}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockOwner = readFileSync(lockFile, "utf8");
        const ownerPid = Number(lockOwner.split(":", 1)[0]);
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
          try {
            process.kill(ownerPid, 0);
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") rmSync(lockFile, { force: true });
            else if ((probeError as NodeJS.ErrnoException).code !== "EPERM") throw probeError;
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the known-peer trust-store lock at ${lockFile}.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  closeSync(fd);
  try {
    return await operation();
  } finally {
    // Only remove a lock we still own. A stale-lock recovery must never let an
    // older process unlink a newer process's lock.
    try {
      if (readFileSync(lockFile, "utf8") === owner) rmSync(lockFile, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function verifyAndPinPeer(
  machine: MachinePaths,
  expectedAddress: string,
  bundle: { identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } },
  now = Date.now(),
): Promise<KnownPeer> {
  const address = bundle.identity.address;
  if (address !== expectedAddress) {
    throw new Error(`The relay returned keys for ${address} when ${expectedAddress} was requested.`);
  }
  if (bundle.encryption.record.address !== address) throw new Error("The relay returned key records for different addresses.");
  if (now < bundle.encryption.record.not_before || now >= bundle.encryption.record.not_after) {
    throw new Error(
      `Encryption key for ${address} is not valid at the current time ` +
      `(valid ${bundle.encryption.record.not_before}..<${bundle.encryption.record.not_after}, now ${now}).`,
    );
  }
  return withStoreLock(machine, async () => {
    const peers = loadKnownPeers(machine);
    const existing = peers.find((peer) => peer.address === address);
    const servedFingerprint = await fingerprint(identityTranscript(bundle.identity));
    const storedIdentity = existing && { v: 1 as const, address: existing.address, identity_pub: existing.identity_pub };
    const storedFingerprint = storedIdentity && await fingerprint(identityTranscript(storedIdentity));
    if (existing && existing.fingerprint !== storedFingerprint) {
      throw new Error(`Corrupt known-peer trust store at ${machine.knownPeersFile}: fingerprint does not match ${address}.`);
    }
    if (existing && existing.identity_pub !== bundle.identity.identity_pub) {
      throw new Error(
        `Identity key changed for ${address}. Pinned ${existing.fingerprint}; relay served ${servedFingerprint}. ` +
        `Refusing to continue. Verify the change out of band, then run \`agentcall trust --reset ${address}\`.`,
      );
    }
    const identityKey = await importIdentityPublicKey(existing?.identity_pub ?? bundle.identity.identity_pub);
    const signatureValid = await verifyTranscript(
      identityKey, encryptionKeyTranscript(bundle.encryption.record), bundle.encryption.signature,
    );
    if (!signatureValid) throw new Error(`Encryption key for ${address} is not signed by its pinned identity key.`);
    if (existing && bundle.encryption.record.epoch < existing.highest_encryption_epoch) {
      throw new Error(
        `Encryption-key rollback for ${address}: pinned epoch ${existing.highest_encryption_epoch}, relay served ${bundle.encryption.record.epoch}.`,
      );
    }
    if (!existing && peers.length >= MAX_KNOWN_PEERS) {
      throw new Error(`Known-peer trust store is full (${MAX_KNOWN_PEERS} entries). Remove an unused pin before contacting a new peer.`);
    }
    const verified: KnownPeer = existing ? {
      ...existing,
      highest_encryption_epoch: Math.max(existing.highest_encryption_epoch, bundle.encryption.record.epoch),
      call_count: existing.call_count + 1,
    } : {
      address,
      identity_pub: bundle.identity.identity_pub,
      fingerprint: servedFingerprint,
      first_seen_at: now,
      highest_encryption_epoch: bundle.encryption.record.epoch,
      call_count: 1,
    };
    saveKnownPeers(machine, existing ? peers.map((peer) => peer.address === address ? verified : peer) : [...peers, verified]);
    return verified;
  });
}

export async function resetPeerTrust(machine: MachinePaths, address: string): Promise<KnownPeer> {
  return withStoreLock(machine, async () => {
    const peers = loadKnownPeers(machine);
    const peer = peers.find((entry) => entry.address === address);
    if (!peer) throw new Error(`No pinned identity key for ${address}.`);
    saveKnownPeers(machine, peers.filter((entry) => entry.address !== address));
    return peer;
  });
}

export function checkKnownPeersStore(machine: MachinePaths): { ok: boolean; detail: string } {
  try {
    const peers = loadKnownPeers(machine);
    return { ok: true, detail: existsSync(machine.knownPeersFile) ? `${peers.length} pinned peer${peers.length === 1 ? "" : "s"}` : "not created yet" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
