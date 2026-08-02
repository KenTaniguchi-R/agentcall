import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { generateAndSaveKeys, keysExist, loadKeys } from "../src/keys.js";

let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agentcall-keys-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("key storage", () => {
  it("reports no keys before generation", () => {
    expect(keysExist(getPaths(home))).toBe(false);
  });

  it("generates, saves, and reloads both key pairs", async () => {
    const paths = getPaths(home);
    const saved = await generateAndSaveKeys(paths);
    expect(saved.identity_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.encryption_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.epoch).toBe(1);
    expect(keysExist(paths)).toBe(true);
    expect(loadKeys(paths)).toEqual(saved);
  });

  it("writes the identity key file 0600", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    expect(statSync(paths.identityKeyFile).mode & 0o777).toBe(0o600);
  });

  it("writes the containing directory 0700", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
  });

  it("uses distinct identity and encryption keys", async () => {
    const saved = await generateAndSaveKeys(getPaths(home));
    expect(saved.identity_pub).not.toBe(saved.encryption_pub);
    expect(saved.identity_pkcs8).not.toBe(saved.encryption_pkcs8);
  });

  it("advances the epoch when asked", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    const rotated = await generateAndSaveKeys(paths, 2);
    expect(rotated.epoch).toBe(2);
    expect(loadKeys(paths).epoch).toBe(2);
  });

  it("refuses to load a key file with loose permissions", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
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
