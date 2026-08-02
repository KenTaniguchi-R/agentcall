import { z } from "zod";
import { canonicalEncode } from "./canonical.js";

/** The one HPKE suite this protocol version implements. Exact string, no spaces. */
export const HPKE_SUITE = "DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM" as const;

/** 30 days. A record claiming a longer window is rejected, not clamped. */
export const MAX_ENCRYPTION_KEY_VALIDITY_MS = 2_592_000_000;

// handle@host. The relay origin is part of the signed identity so a record
// published on one relay cannot be presented as valid on another.
const ADDRESS_RE = /^[a-z0-9][a-z0-9-]{1,30}@[a-z0-9.-]{1,253}$/;
const KEY_ID_RE = /^[0-9a-f]{32}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const IdentityRecord = z.object({
  v: z.literal(1),
  address: z.string().regex(ADDRESS_RE),
  identity_pub: z.string().regex(BASE64URL_RE).max(256),
});
export type IdentityRecordType = z.infer<typeof IdentityRecord>;

export const EncryptionKeyRecord = z.object({
  v: z.literal(1),
  address: z.string().regex(ADDRESS_RE),
  key_id: z.string().regex(KEY_ID_RE),
  suite: z.literal(HPKE_SUITE),
  pub: z.string().regex(BASE64URL_RE).max(256),
  epoch: z.number().int().nonnegative(),
  not_before: z.number().int().nonnegative(),
  not_after: z.number().int().nonnegative(),
  // SHA-256 of the previous epoch's transcript, so a client that sees epochs 5
  // and 7 knows it missed 6 rather than silently accepting a fork.
  prev: z.string().regex(KEY_ID_RE).nullable(),
}).refine((r) => r.not_after > r.not_before, {
  message: "not_after must be after not_before",
}).refine((r) => r.not_after - r.not_before <= MAX_ENCRYPTION_KEY_VALIDITY_MS, {
  message: "validity window must not exceed 30 days",
});
export type EncryptionKeyRecordType = z.infer<typeof EncryptionKeyRecord>;

// Field order is part of the signature. Never reorder these lists; adding a
// field means a new record version.
export function identityTranscript(r: IdentityRecordType): Uint8Array {
  return canonicalEncode(["agentcall/identity/v1", r.v, r.address, r.identity_pub]);
}

export function encryptionKeyTranscript(r: EncryptionKeyRecordType): Uint8Array {
  return canonicalEncode([
    "agentcall/encryption-key/v1", r.v, r.address, r.key_id, r.suite, r.pub,
    r.epoch, r.not_before, r.not_after, r.prev,
  ]);
}

/** Truncated to 128 bits: short enough to read aloud, long enough to pin. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SHA256:${hex}`;
}
