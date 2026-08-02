import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { generateIdentityKeys, keysExist, loadKeys, rotateEncryptionKey } from "../src/keys.js";

let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agentcall-keys-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("key storage", () => {
  it("reports no keys before generation", () => {
    expect(keysExist(getPaths(home))).toBe(false);
  });

  it("generates, saves, and reloads both key pairs", async () => {
    const paths = getPaths(home);
    const saved = await generateIdentityKeys(paths);
    expect(saved.identity_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.encryption_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.epoch).toBe(1);
    expect(keysExist(paths)).toBe(true);
    expect(loadKeys(paths)).toEqual(saved);
  });

  it("writes the identity key file 0600", async () => {
    const paths = getPaths(home);
    await generateIdentityKeys(paths);
    expect(statSync(paths.identityKeyFile).mode & 0o777).toBe(0o600);
  });

  it("writes the containing directory 0700", async () => {
    const paths = getPaths(home);
    await generateIdentityKeys(paths);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
  });

  it("uses distinct identity and encryption keys", async () => {
    const saved = await generateIdentityKeys(getPaths(home));
    expect(saved.identity_pub).not.toBe(saved.encryption_pub);
    expect(saved.identity_pkcs8).not.toBe(saved.encryption_pkcs8);
  });

  it("rotating advances the epoch and replaces only the encryption key", async () => {
    const paths = getPaths(home);
    const first = await generateIdentityKeys(paths);
    const rotated = await rotateEncryptionKey(paths);

    expect(rotated.epoch).toBe(2);
    expect(loadKeys(paths).epoch).toBe(2);
    expect(rotated.encryption_pub).not.toBe(first.encryption_pub);
    expect(rotated.encryption_pkcs8).not.toBe(first.encryption_pkcs8);

    // The identity key is the trust root contacts pin, and the relay refuses to
    // replace a published one. Regenerating it here would not start over — it
    // would brick the handle, while every assertion above still passed.
    expect(rotated.identity_pub).toBe(first.identity_pub);
    expect(rotated.identity_pkcs8).toBe(first.identity_pkcs8);
    expect(loadKeys(paths).identity_pub).toBe(first.identity_pub);
  });

  it("rotates repeatedly without ever changing the identity key", async () => {
    const paths = getPaths(home);
    const first = await generateIdentityKeys(paths);
    await rotateEncryptionKey(paths);
    const third = await rotateEncryptionKey(paths);
    expect(third.epoch).toBe(3);
    expect(third.identity_pub).toBe(first.identity_pub);
  });

  it("refuses to regenerate over an existing key file", async () => {
    const paths = getPaths(home);
    const first = await generateIdentityKeys(paths);
    await expect(generateIdentityKeys(paths)).rejects.toThrow(/already exists/i);
    expect(loadKeys(paths).identity_pub).toBe(first.identity_pub);
  });

  it("throws a clear error rather than ENOENT when no key file exists", () => {
    const paths = getPaths(home);
    expect(() => loadKeys(paths)).toThrow(/does not exist/i);
    expect(() => loadKeys(paths)).not.toThrow(/ENOENT/);
  });

  it("refuses to load a key file with loose permissions", async () => {
    const paths = getPaths(home);
    await generateIdentityKeys(paths);
    chmodSync(paths.identityKeyFile, 0o644);
    expect(() => loadKeys(paths)).toThrow(/permission/i);
  });

  it("throws a clear error when the key file is corrupt", () => {
    const paths = getPaths(home);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.identityKeyFile, "{ not json", { mode: 0o600 });
    expect(() => loadKeys(paths)).toThrow(/could not be read/i);
  });
});
