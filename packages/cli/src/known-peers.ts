import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { ADDRESS_RE, BASE64URL_RE, FINGERPRINT_RE, RELAY_ORIGIN_RE,
  encryptionKeyTranscript, fingerprint, identityTranscript, importIdentityPublicKey,
  verifyTranscript, type EncryptionKeyRecordType, type IdentityRecordType,
} from "@benree/agentcall-shared";
import { assertPrivateFile, readJsonStore, writeJsonAtomic } from "./json-store.js";
import { withFileLock } from "./file-lock.js";
import type { Paths } from "./paths.js";

export const MAX_KNOWN_PEERS = 10_000;

const KnownPeerSchema = z.object({
  // Which relay this key was trusted on. Lines may sit on different relays and
  // the trust store is per-machine, so the pin is only meaningful together with
  // its origin — and the identity transcript covers it, so a stored peer
  // without it cannot have its fingerprint recomputed.
  relay_origin: z.string().regex(RELAY_ORIGIN_RE),
  address: z.string().regex(ADDRESS_RE),
  identity_pub: z.string().regex(BASE64URL_RE).max(256),
  fingerprint: z.string().regex(FINGERPRINT_RE),
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
export type PeerIdentityInspection =
  | { state: "unseen"; served_fingerprint: string }
  | { state: "matched"; pinned_fingerprint: string; served_fingerprint: string }
  | { state: "changed"; pinned_fingerprint: string; served_fingerprint: string }
  | { state: "invalid"; detail: string; pinned_fingerprint?: string; served_fingerprint?: string };

export function loadKnownPeers(machine: Paths): KnownPeer[] {
  return readJsonStore(machine.knownPeersFile, KnownPeersSchema, {
    missing: () => ({ peers: [] }),
    requirePrivate: { dir: machine.dir },
    corrupt: (detail) => {
      throw new Error(`Corrupt known-peer trust store at ${machine.knownPeersFile}: ${detail}`);
    },
  }).peers;
}

/** Validate relay-served keys and compare them with local trust without writing the trust store. */
export async function inspectPeerIdentity(
  paths: Paths,
  expectedAddress: string,
  bundle: { identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } },
  now = Date.now(),
): Promise<PeerIdentityInspection> {
  let servedFingerprint: string | undefined;
  let existing: KnownPeer | undefined;
  try {
    existing = loadKnownPeers(paths).find((peer) => peer.address === expectedAddress);
    if (bundle.identity.address !== expectedAddress || bundle.encryption.record.address !== expectedAddress) {
      throw new Error(`The relay returned keys for a different address than ${expectedAddress}.`);
    }
    servedFingerprint = await fingerprint(identityTranscript(bundle.identity));
    if (now < bundle.encryption.record.not_before || now >= bundle.encryption.record.not_after) {
      throw new Error(`Encryption key for ${expectedAddress} is not valid at the current time.`);
    }
    const servedIdentityKey = await importIdentityPublicKey(bundle.identity.identity_pub);
    if (!await verifyTranscript(
      servedIdentityKey, encryptionKeyTranscript(bundle.encryption.record), bundle.encryption.signature,
    )) {
      throw new Error(`Encryption key for ${expectedAddress} is not signed by the served identity key.`);
    }
    if (!existing) return { state: "unseen", served_fingerprint: servedFingerprint };

    const storedIdentity = {
      v: 1 as const, relay_origin: existing.relay_origin,
      address: existing.address, identity_pub: existing.identity_pub,
    };
    const recomputed = await fingerprint(identityTranscript(storedIdentity));
    if (recomputed !== existing.fingerprint) throw new Error(`Stored fingerprint for ${expectedAddress} is corrupt.`);
    if (existing.identity_pub !== bundle.identity.identity_pub) {
      return { state: "changed", pinned_fingerprint: existing.fingerprint, served_fingerprint: servedFingerprint };
    }
    if (bundle.encryption.record.epoch < existing.highest_encryption_epoch) {
      throw new Error(`Encryption-key rollback for ${expectedAddress}.`);
    }
    return { state: "matched", pinned_fingerprint: existing.fingerprint, served_fingerprint: servedFingerprint };
  } catch (error) {
    return {
      state: "invalid",
      detail: error instanceof Error ? error.message : String(error),
      ...(existing ? { pinned_fingerprint: existing.fingerprint } : {}),
      ...(servedFingerprint ? { served_fingerprint: servedFingerprint } : {}),
    };
  }
}

function saveKnownPeers(machine: Paths, peers: KnownPeer[]): void {
  writeJsonAtomic(machine.knownPeersFile, KnownPeersSchema.parse({ peers }));
  chmodSync(machine.dir, 0o700);
}

async function withStoreLock<T>(machine: Paths, operation: () => Promise<T>): Promise<T> {
  // Never silently repair permissions around an existing trust root. If it
  // may have been exposed, fail closed and make the owner inspect it first.
  if (existsSync(machine.knownPeersFile)) {
    assertPrivateFile(machine.knownPeersFile, { dir: machine.dir });
  } else {
    mkdirSync(machine.dir, { recursive: true, mode: 0o700 });
    chmodSync(machine.dir, 0o700);
  }
  return withFileLock(machine.knownPeersFile, "known-peer trust-store", operation);
}

export async function verifyAndPinPeer(
  machine: Paths,
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
    const storedIdentity = existing && {
      v: 1 as const, relay_origin: existing.relay_origin,
      address: existing.address, identity_pub: existing.identity_pub,
    };
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
      relay_origin: bundle.identity.relay_origin,
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

export async function resetPeerTrust(machine: Paths, address: string): Promise<KnownPeer> {
  return withStoreLock(machine, async () => {
    const peers = loadKnownPeers(machine);
    const peer = peers.find((entry) => entry.address === address);
    if (!peer) throw new Error(`No pinned identity key for ${address}.`);
    saveKnownPeers(machine, peers.filter((entry) => entry.address !== address));
    return peer;
  });
}

export function checkKnownPeersStore(machine: Paths): { ok: boolean; detail: string } {
  try {
    const peers = loadKnownPeers(machine);
    return { ok: true, detail: existsSync(machine.knownPeersFile) ? `${peers.length} pinned peer${peers.length === 1 ? "" : "s"}` : "not created yet" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
