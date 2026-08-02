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
 * First-time setup. Both key pairs live in one file so a partial write cannot
 * leave an identity without its encryption key. `writeJsonAtomic` already
 * creates the directory 0700 and the file 0600.
 *
 * Refuses to overwrite. The identity key is the trust root contacts pin, and
 * the relay will not replace a published one — regenerating it does not start
 * over, it bricks the handle. Rotation is `rotateEncryptionKey`.
 */
export async function generateIdentityKeys(paths: Paths): Promise<StoredKeys> {
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
  };
  writeJsonAtomic(paths.identityKeyFile, keys);
  return keys;
}

/**
 * Rotates the encryption key pair only, advancing the epoch by one. The
 * identity key pair is carried through untouched: it is what signs the new
 * encryption record, so replacing it here would make the record unverifiable
 * against the identity key contacts already pinned.
 */
export async function rotateEncryptionKey(paths: Paths): Promise<StoredKeys> {
  const current = loadKeys(paths);
  const encryption = await generateEncryptionKeyPair();
  const keys: StoredKeys = {
    identity_pkcs8: current.identity_pkcs8,
    identity_pub: current.identity_pub,
    encryption_pkcs8: await exportPrivate(encryption.privateKey),
    encryption_pub: await exportPublicKey(encryption.publicKey),
    epoch: current.epoch + 1,
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
  // Checked before statSync so a missing file gets this module's prose rather
  // than a raw ENOENT stack from node:fs.
  if (!keysExist(paths)) {
    throw new Error(`${paths.identityKeyFile} does not exist. Run \`agentcall setup\` first.`);
  }
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
