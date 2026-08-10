import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import {
  generateIdentityKeys, keysExist, loadKeys, rememberPublishedEncryptionKey,
  loadEncryptionKeysForEpoch, rotateEncryptionKey, type StoredKeys,
} from "../src/keys.js";

let home: string;

// The identity key is line-scoped, so every case here works through a line.
function linePaths(root: string) { return getPaths(root, root); }

function markPublished(paths: ReturnType<typeof linePaths>, keys: StoredKeys, digit: string): StoredKeys {
  return rememberPublishedEncryptionKey(paths, keys, digit.repeat(32));
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agentcall-keys-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("key storage", () => {
  it("reports no keys before generation", () => {
    expect(keysExist(linePaths(home))).toBe(false);
  });

  it("generates, saves, and reloads both key pairs", async () => {
    const paths = linePaths(home);
    const saved = await generateIdentityKeys(paths);
    expect(saved.identity_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.encryption_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.epoch).toBe(1);
    expect(saved.previous_encryption_transcript_hash).toBeNull();
    expect(saved.published_encryption_transcript_hash).toBeUndefined();
    expect(keysExist(paths)).toBe(true);
    expect(loadKeys(paths)).toEqual(saved);
  });

  it("rejects a pre-chain epoch-1 file that cannot safely retry publication", async () => {
    const paths = linePaths(home);
    const saved = await generateIdentityKeys(paths);
    const { previous_encryption_transcript_hash: _omitted, ...legacy } = saved;
    writeFileSync(paths.identityKeyFile, JSON.stringify(legacy));
    expect(() => loadKeys(paths)).toThrow(/pre-chain.*cannot safely retry/i);
  });

  it("writes the identity key file 0600", async () => {
    const paths = linePaths(home);
    await generateIdentityKeys(paths);
    expect(statSync(paths.identityKeyFile).mode & 0o777).toBe(0o600);
  });

  it("writes the containing directory 0700", async () => {
    const paths = linePaths(home);
    await generateIdentityKeys(paths);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
  });

  it("uses distinct identity and encryption keys", async () => {
    const saved = await generateIdentityKeys(linePaths(home));
    expect(saved.identity_pub).not.toBe(saved.encryption_pub);
    expect(saved.identity_pkcs8).not.toBe(saved.encryption_pkcs8);
  });

  it("rotating advances the epoch and replaces only the encryption key", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");
    const rotated = await rotateEncryptionKey(paths);

    expect(rotated.epoch).toBe(2);
    expect(loadKeys(paths).epoch).toBe(2);
    expect(rotated.encryption_pub).not.toBe(first.encryption_pub);
    expect(rotated.encryption_pkcs8).not.toBe(first.encryption_pkcs8);
    expect(rotated.previous_encryption_transcript_hash).toBe("a".repeat(32));
    expect(rotated.published_encryption_transcript_hash).toBeUndefined();

    // The identity key is the trust root contacts pin, and the relay refuses to
    // replace a published one. Regenerating it here would not start over — it
    // would brick the handle, while every assertion above still passed.
    expect(rotated.identity_pub).toBe(first.identity_pub);
    expect(rotated.identity_pkcs8).toBe(first.identity_pkcs8);
    expect(loadKeys(paths).identity_pub).toBe(first.identity_pub);
  });

  it("rotates repeatedly without ever changing the identity key", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");
    const second = await rotateEncryptionKey(paths);
    markPublished(paths, second, "b");
    const third = await rotateEncryptionKey(paths);
    expect(third.epoch).toBe(3);
    expect(third.identity_pub).toBe(first.identity_pub);
    expect(third.previous_encryption_transcript_hash).toBe("b".repeat(32));
  });

  it("converges concurrent rotators on one next-epoch keypair", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");

    const rotations = await Promise.all(Array.from({ length: 8 }, () => rotateEncryptionKey(paths)));
    const stored = loadKeys(paths);
    expect(stored.epoch).toBe(2);
    expect(new Set(rotations.map(({ encryption_pub }) => encryption_pub))).toEqual(
      new Set([stored.encryption_pub]),
    );
    expect(new Set(rotations.map(({ encryption_pkcs8 }) => encryption_pkcs8))).toEqual(
      new Set([stored.encryption_pkcs8]),
    );
    expect(stored.previous_encryption_transcript_hash).toBe("a".repeat(32));
  });

  it("waits for a different process to finish its elected epoch slot", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");
    const target = `${paths.identityKeyFile}.epoch-2.state.json`;
    const lock = `${target}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    const elected = {
      state: "active",
      encryption_pkcs8: "child-private",
      encryption_pub: "child-public",
      epoch: 2,
      previous_encryption_transcript_hash: "a".repeat(32),
    };
    const child = spawn(process.execPath, [
      "-e",
      `const fs=require("node:fs");const [file,lock,json]=process.argv.slice(1);` +
        `setTimeout(()=>{fs.writeFileSync(file,json+"\\n",{flag:"wx",mode:0o600});` +
        `fs.rmdirSync(lock)},250)`,
      target,
      lock,
      JSON.stringify(elected),
    ]);
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    const rotated = await rotateEncryptionKey(paths);
    expect(await exited).toBe(0);
    expect(rotated).toMatchObject({ epoch: 2, encryption_pub: "child-public" });
    expect(existsSync(lock)).toBe(false);
  });

  it("waits before reading a canonical epoch slot that another process is writing", async () => {
    const paths = linePaths(home);
    await generateIdentityKeys(paths);
    const target = `${paths.identityKeyFile}.epoch-2.state.json`;
    const lock = `${target}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(target, '{"state":', { mode: 0o600 });
    const elected = {
      state: "active",
      encryption_pkcs8: "child-private",
      encryption_pub: "child-public",
      epoch: 2,
      previous_encryption_transcript_hash: "a".repeat(32),
    };
    const child = spawn(process.execPath, [
      "-e",
      `const fs=require("node:fs");const [file,lock,json]=process.argv.slice(1);` +
        `setTimeout(()=>{fs.writeFileSync(file,json+"\\n",{flag:"w",mode:0o600});` +
        `fs.rmdirSync(lock)},250)`,
      target,
      lock,
      JSON.stringify(elected),
    ]);
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    expect(loadKeys(paths)).toMatchObject({ epoch: 2, encryption_pub: "child-public" });
    expect(await exited).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("fails closed when an election lock is abandoned", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");
    const target = `${paths.identityKeyFile}.epoch-2.state.json`;
    mkdirSync(`${target}.lock`, { mode: 0o700 });

    await expect(rotateEncryptionKey(paths, { electionWaitMs: 20 })).rejects.toThrow(
      /election lock.*did not clear.*refusing partial state/i,
    );
    expect(loadKeys(paths).epoch).toBe(1);
  });

  it("does not let a paused old rotator roll back a later published epoch", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");
    let reachedElection!: () => void;
    let resumeOld!: () => void;
    const elected = new Promise<void>((resolve) => { reachedElection = resolve; });
    const resume = new Promise<void>((resolve) => { resumeOld = resolve; });
    const oldRotation = rotateEncryptionKey(paths, {
      afterElection: async () => { reachedElection(); await resume; },
    });
    await elected;

    const second = loadKeys(paths);
    expect(second.epoch).toBe(2);
    markPublished(paths, second, "b");
    const third = await rotateEncryptionKey(paths);
    expect(third.epoch).toBe(3);

    resumeOld();
    const resumed = await oldRotation;
    expect(resumed.epoch).toBe(3);
    expect(resumed.encryption_pub).toBe(third.encryption_pub);
    expect(loadKeys(paths).epoch).toBe(3);
  });

  it("retains superseded private keys long enough to decrypt durable mailbox traffic", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    markPublished(paths, first, "a");
    const second = await rotateEncryptionKey(paths);
    markPublished(paths, second, "b");
    const third = await rotateEncryptionKey(paths);

    const names = readdirSync(paths.dir);
    const persisted = names
      .map((name) => readFileSync(join(paths.dir, name), "utf8"))
      .join("\n");
    expect(names.some((name) => name.endsWith(".candidate") || name.endsWith(".tmp"))).toBe(false);
    expect(persisted).toContain(first.encryption_pkcs8);
    expect(persisted).toContain(second.encryption_pkcs8);
    expect(persisted).toContain(third.encryption_pkcs8);
    expect(loadEncryptionKeysForEpoch(paths, 1).encryption_pkcs8).toBe(first.encryption_pkcs8);
    expect(loadEncryptionKeysForEpoch(paths, 2).encryption_pkcs8).toBe(second.encryption_pkcs8);
    expect(JSON.parse(readFileSync(paths.identityKeyFile, "utf8"))).toEqual({
      format: 2, identity_pkcs8: first.identity_pkcs8, identity_pub: first.identity_pub,
    });
  });

  it("refuses a rapid ninth live epoch instead of evicting a decryptable key", async () => {
    const paths = linePaths(home);
    let keys = await generateIdentityKeys(paths);
    for (let epoch = 1; epoch < 8; epoch += 1) {
      keys = markPublished(paths, keys, epoch.toString(16));
      keys = await rotateEncryptionKey(paths);
    }
    keys = markPublished(paths, keys, "8");
    await expect(rotateEncryptionKey(paths)).rejects.toThrow(/eight.*live encryption-key epochs/i);
    expect(loadKeys(paths).epoch).toBe(8);
  });

  it("refuses to rotate an epoch that was never successfully published", async () => {
    const paths = linePaths(home);
    await generateIdentityKeys(paths);
    await expect(rotateEncryptionKey(paths)).rejects.toThrow(/not been published.*refusing to rotate/i);
    expect(loadKeys(paths).epoch).toBe(1);
  });

  it("refuses to regenerate over an existing key file", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    await expect(generateIdentityKeys(paths)).rejects.toThrow(/already exists/i);
    expect(loadKeys(paths).identity_pub).toBe(first.identity_pub);
  });

  it("throws a clear error rather than ENOENT when no key file exists", () => {
    const paths = linePaths(home);
    expect(() => loadKeys(paths)).toThrow(/does not exist/i);
    expect(() => loadKeys(paths)).not.toThrow(/ENOENT/);
  });

  it("refuses to load a key file with loose permissions", async () => {
    const paths = linePaths(home);
    await generateIdentityKeys(paths);
    chmodSync(paths.identityKeyFile, 0o644);
    expect(() => loadKeys(paths)).toThrow(/permission/i);
  });

  it("throws a clear error when the key file is corrupt", () => {
    const paths = linePaths(home);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.identityKeyFile, "{ not json", { mode: 0o600 });
    expect(() => loadKeys(paths)).toThrow(/could not be read/i);
  });

  it("rejects persisted epochs whose previous-link nullability contradicts the epoch", async () => {
    const paths = linePaths(home);
    const first = await generateIdentityKeys(paths);
    writeFileSync(paths.identityKeyFile, JSON.stringify({
      ...first, previous_encryption_transcript_hash: "a".repeat(32),
    }));
    expect(() => loadKeys(paths)).toThrow(/unexpected contents/i);

    writeFileSync(paths.identityKeyFile, JSON.stringify({
      ...first, epoch: 2, previous_encryption_transcript_hash: null,
    }));
    expect(() => loadKeys(paths)).toThrow(/unexpected contents/i);
  });
});
