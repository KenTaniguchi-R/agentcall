import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import {
  exportPublicKey, generateEncryptionKeyPair, generateIdentityKeyPair,
  toBase64Url,
} from "@benree/agentcall-shared";
import { writeJsonAtomic } from "./json-store.js";
import type { Paths } from "./paths.js";

const StoredKeysSchema = z.object({
  identity_pkcs8: z.string().min(1),
  identity_pub: z.string().min(1),
  encryption_pkcs8: z.string().min(1),
  encryption_pub: z.string().min(1),
  epoch: z.number().int().positive(),
});
export type StoredKeys = z.infer<typeof StoredKeysSchema>;

async function exportPrivate(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));
}

/**
 * Both key pairs live in one file so a partial write cannot leave an identity
 * without its encryption key. `writeJsonAtomic` already creates the directory
 * 0700 and the file 0600.
 */
export async function generateAndSaveKeys(paths: Paths, epoch = 1): Promise<StoredKeys> {
  const identity = await generateIdentityKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const keys: StoredKeys = {
    identity_pkcs8: await exportPrivate(identity.privateKey),
    identity_pub: await exportPublicKey(identity.publicKey),
    encryption_pkcs8: await exportPrivate(encryption.privateKey),
    encryption_pub: await exportPublicKey(encryption.publicKey),
    epoch,
  };
  writeJsonAtomic(paths.identityKeyFile, keys);
  return keys;
}

export function keysExist(paths: Paths): boolean {
  return existsSync(paths.identityKeyFile);
}

/**
 * Permissions are re-checked on every load, not only at write time: a key file
 * that became group- or world-readable after the fact is exactly as exposed as
 * one written that way.
 */
export function loadKeys(paths: Paths): StoredKeys {
  const mode = statSync(paths.identityKeyFile).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${paths.identityKeyFile} has permission ${mode.toString(8)}; expected 600. ` +
        `Run: chmod 600 ${paths.identityKeyFile}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.identityKeyFile, "utf8"));
  } catch {
    throw new Error(`${paths.identityKeyFile} could not be read as JSON.`);
  }
  const parsed = StoredKeysSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${paths.identityKeyFile} could not be read: unexpected contents.`);
  return parsed.data;
}
