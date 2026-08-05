import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encryptionKeyTranscript, exportPublicKey, generateEncryptionKeyPair, generateIdentityKeyPair,
  HPKE_SUITE, keyIdFor, signTranscript, type EncryptionKeyRecordType,
} from "@benree/agentcall-shared";
import { loadKnownPeers, MAX_KNOWN_PEERS, resetPeerTrust, verifyAndPinPeer } from "../src/known-peers.js";
import { writeJsonAtomic } from "../src/json-store.js";
import { getMachinePaths, type MachinePaths } from "../src/paths.js";

let root: string;
let machine: MachinePaths;
const PEER = "peer@relay.example";
const NOW = 500;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcall-peers-"));
  machine = getMachinePaths(root, root);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function bundle(identity?: CryptoKeyPair, epoch = 1, address = PEER) {
  identity ??= await generateIdentityKeyPair();
  const identityPub = await exportPublicKey(identity.publicKey);
  const encryption = await generateEncryptionKeyPair();
  const pub = await exportPublicKey(encryption.publicKey);
  const record: EncryptionKeyRecordType = {
    v: 2, relay_origin: address.slice(address.indexOf("@") + 1), address,
    key_id: await keyIdFor(pub), suite: HPKE_SUITE, pub, epoch,
    not_before: 1, not_after: 1_000, prev: null,
  };
  return {
    identityKey: identity,
    value: {
      identity: {
        v: 2 as const, relay_origin: address.slice(address.indexOf("@") + 1),
        address, identity_pub: identityPub,
      },
      encryption: { record, signature: await signTranscript(identity.privateKey, encryptionKeyTranscript(record)) },
    },
  };
}

describe("known-peer identity pins", () => {
  it("pins a first contact only after verifying its encryption signature", async () => {
    const first = await bundle();
    const peer = await verifyAndPinPeer(machine, PEER, first.value, NOW);
    expect(peer).toMatchObject({ address: "peer@relay.example", first_seen_at: NOW, highest_encryption_epoch: 1, call_count: 1 });
    expect(loadKnownPeers(machine)).toEqual([peer]);
    expect(statSync(machine.dir).mode & 0o777).toBe(0o700);
    expect(statSync(machine.knownPeersFile).mode & 0o777).toBe(0o600);
  });

  it("accepts the pinned identity and advances the highest epoch", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    const rotated = await bundle(first.identityKey, 2);
    const peer = await verifyAndPinPeer(machine, PEER, rotated.value, NOW);
    expect(peer.highest_encryption_epoch).toBe(2);
    expect(peer.first_seen_at).toBe(NOW);
    expect(peer.call_count).toBe(2);
  });

  it("refuses a changed identity without replacing the pin", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    const before = readFileSync(machine.knownPeersFile, "utf8");
    await expect(verifyAndPinPeer(machine, PEER, (await bundle()).value, NOW)).rejects.toThrow(/Identity key changed/);
    expect(readFileSync(machine.knownPeersFile, "utf8")).toBe(before);
  });

  it("refuses a valid bundle bound to a different requested host", async () => {
    const first = await bundle();
    await expect(verifyAndPinPeer(machine, "peer@other.example", first.value, NOW)).rejects.toThrow(/when peer@other\.example was requested/);
    expect(loadKnownPeers(machine)).toEqual([]);
  });

  it("refuses an encryption record signed by another identity", async () => {
    const first = await bundle();
    const attacker = await bundle();
    first.value.encryption.signature = attacker.value.encryption.signature;
    await expect(verifyAndPinPeer(machine, PEER, first.value, NOW)).rejects.toThrow(/not signed/);
    expect(loadKnownPeers(machine)).toEqual([]);
  });

  it("refuses an epoch rollback without mutating the store", async () => {
    const first = await bundle(undefined, 2);
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    const old = await bundle(first.identityKey, 1);
    const before = readFileSync(machine.knownPeersFile, "utf8");
    await expect(verifyAndPinPeer(machine, PEER, old.value, NOW)).rejects.toThrow(/rollback/);
    expect(readFileSync(machine.knownPeersFile, "utf8")).toBe(before);
  });

  it("requires the explicit reset operation before a replacement can pin", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    expect((await resetPeerTrust(machine, PEER)).identity_pub).toBe(first.value.identity.identity_pub);
    const replacement = await bundle();
    await verifyAndPinPeer(machine, PEER, replacement.value, NOW);
    expect(loadKnownPeers(machine)[0]?.identity_pub).toBe(replacement.value.identity.identity_pub);
  });

  it("fails closed on corrupt or loosely permissioned trust state", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    writeFileSync(machine.knownPeersFile, "not json");
    expect(() => loadKnownPeers(machine)).toThrow(/Corrupt known-peer/);
    writeFileSync(machine.knownPeersFile, JSON.stringify({ peers: [] }));
    chmodSync(machine.knownPeersFile, 0o644);
    expect(() => loadKnownPeers(machine)).toThrow(/expected 600/);
  });

  it("does not silently repair a loose trust-store directory before updating", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    chmodSync(machine.dir, 0o755);
    await expect(verifyAndPinPeer(machine, PEER, first.value, NOW)).rejects.toThrow(/expected 700/);
    expect(statSync(machine.dir).mode & 0o777).toBe(0o755);
  });

  it("does not silently repair a loose trust-store directory before reset", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    chmodSync(machine.dir, 0o755);
    await expect(resetPeerTrust(machine, PEER)).rejects.toThrow(/expected 700/);
    expect(statSync(machine.dir).mode & 0o777).toBe(0o755);
  });

  it("refuses to grow beyond the fixed peer cap", async () => {
    writeJsonAtomic(machine.knownPeersFile, { peers: Array.from({ length: MAX_KNOWN_PEERS }, (_, index) => ({
      relay_origin: "r.test", address: `p${index}@r.test`, identity_pub: "abc",
      fingerprint: "SHA256:0123456789abcdef0123456789abcdef",
      first_seen_at: 1, highest_encryption_epoch: 1, call_count: 1,
    })) });
    await expect(verifyAndPinPeer(machine, PEER, (await bundle()).value, NOW)).rejects.toThrow(/store is full/);
    expect(loadKnownPeers(machine)).toHaveLength(MAX_KNOWN_PEERS);
  });

  it("refuses an expired signed encryption record", async () => {
    const expired = await bundle();
    await expect(verifyAndPinPeer(machine, PEER, expired.value, 1_000)).rejects.toThrow(/not valid/);
    expect(loadKnownPeers(machine)).toEqual([]);
  });

  it("serializes concurrent peer additions without losing either pin", async () => {
    const alice = await bundle(undefined, 1, "alice@relay.example");
    const bob = await bundle(undefined, 1, "bob@relay.example");
    await Promise.all([
      verifyAndPinPeer(machine, "alice@relay.example", alice.value, NOW),
      verifyAndPinPeer(machine, "bob@relay.example", bob.value, NOW),
    ]);
    expect(loadKnownPeers(machine).map((peer) => peer.address).sort()).toEqual([
      "alice@relay.example", "bob@relay.example",
    ]);
  });

  it("never lets concurrent verification lower the remembered epoch", async () => {
    const first = await bundle();
    await verifyAndPinPeer(machine, PEER, first.value, NOW);
    const epoch2 = await bundle(first.identityKey, 2);
    const epoch3 = await bundle(first.identityKey, 3);
    const results = await Promise.allSettled([
      verifyAndPinPeer(machine, PEER, epoch2.value, NOW),
      verifyAndPinPeer(machine, PEER, epoch3.value, NOW),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(loadKnownPeers(machine)[0]?.highest_encryption_epoch).toBe(3);
  });

  it("never removes an existing lock after another process replaces its owner", async () => {
    const first = await bundle();
    mkdirSync(machine.dir, { recursive: true, mode: 0o700 });
    const lockFile = `${machine.knownPeersFile}.lock`;
    writeFileSync(lockFile, "2147483647:orphaned", { mode: 0o600 });

    vi.useFakeTimers();
    const verification = verifyAndPinPeer(machine, PEER, first.value, NOW);
    const replacement = "2147483646:new-owner";
    const child = spawnSync(process.execPath, [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
      lockFile,
      replacement,
    ]);
    expect(child.status).toBe(0);

    const rejection = expect(verification).rejects.toThrow(/Timed out waiting/);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
    expect(readFileSync(lockFile, "utf8")).toBe(replacement);
    expect(loadKnownPeers(machine)).toEqual([]);
  });
});
