import { z } from "zod";
import { canonicalEncode } from "./canonical.js";
import { ADDRESS_RE } from "./protocol.js";

/** The one HPKE suite this protocol version implements. Exact string, no spaces. */
export const HPKE_SUITE = "DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM" as const;

/** 30 days. A record claiming a longer window is rejected, not clamped. */
export const MAX_ENCRYPTION_KEY_VALIDITY_MS = 2_592_000_000;

export { ADDRESS_RE };

// Which relay a record was published on. The address is a registry key and
// names no host, so this field is the entire cross-relay binding.
export const RELAY_ORIGIN_RE = /^[a-z0-9.-]{1,253}$/;
const KEY_ID_RE = /^[0-9a-f]{32}$/;
// Same width as a key id but a different quantity: the digest of the previous
// epoch's transcript. It gets its own pattern so that widening one can never
// silently widen the other.
const PREV_RE = /^[0-9a-f]{32}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const IdentityRecord = z.object({
  // v2: `relay_origin` became an explicit signed field. It previously rode
  // inside `address` as the host part, which tied the cross-relay binding to
  // addresses being DNS-shaped.
  v: z.literal(2),
  relay_origin: z.string().regex(RELAY_ORIGIN_RE),
  address: z.string().regex(ADDRESS_RE),
  identity_pub: z.string().regex(BASE64URL_RE).max(256),
});
export type IdentityRecordType = z.infer<typeof IdentityRecord>;

export const EncryptionKeyRecord = z.object({
  // v2: see IdentityRecord.
  v: z.literal(2),
  relay_origin: z.string().regex(RELAY_ORIGIN_RE),
  address: z.string().regex(ADDRESS_RE),
  key_id: z.string().regex(KEY_ID_RE),
  suite: z.literal(HPKE_SUITE),
  pub: z.string().regex(BASE64URL_RE).max(256),
  // Epochs start at 1 and advance by one per rotation, so 0 is a value no
  // publisher ever produces. Matches the CLI's stored key file, which is also
  // `positive()`: the two must agree or a record the CLI can hold is a record
  // the protocol rejects.
  epoch: z.number().int().positive(),
  not_before: z.number().int().nonnegative(),
  not_after: z.number().int().nonnegative(),
  // SHA-256 of the previous epoch's TRANSCRIPT — the exact bytes
  // `encryptionKeyTranscript` produces for epoch n-1, not the JSON record —
  // truncated to its first 16 bytes and hex-encoded (32 characters). 128 bits
  // is second-preimage resistance enough for a chain link. Chaining lets a
  // client that sees epochs 5 and 7 know it missed 6 rather than silently
  // accepting a fork. `null` only on the first epoch.
  prev: z.string().regex(PREV_RE).nullable(),
}).refine((r) => r.not_after > r.not_before, {
  message: "not_after must be after not_before",
}).refine((r) => r.not_after - r.not_before <= MAX_ENCRYPTION_KEY_VALIDITY_MS, {
  message: "validity window must not exceed 30 days",
}).refine((r) => (r.epoch === 1) === (r.prev === null), {
  path: ["prev"], message: "prev must be null only on epoch 1",
});
export type EncryptionKeyRecordType = z.infer<typeof EncryptionKeyRecord>;

// Field order is part of the signature. Never reorder these lists; adding a
// field means a new record version.
export function identityTranscript(r: IdentityRecordType): Uint8Array {
  return canonicalEncode([
    "agentcall/identity/v2", r.v, r.relay_origin, r.address, r.identity_pub,
  ]);
}

export function encryptionKeyTranscript(r: EncryptionKeyRecordType): Uint8Array {
  return canonicalEncode([
    "agentcall/encryption-key/v2", r.v, r.relay_origin, r.address, r.key_id, r.suite, r.pub,
    r.epoch, r.not_before, r.not_after, r.prev,
  ]);
}

/** The `prev` chain link: first 128 bits of SHA-256 over the signed transcript. */
export async function encryptionKeyTranscriptHash(r: EncryptionKeyRecordType): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", encryptionKeyTranscript(r) as BufferSource,
  );
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Truncated to 128 bits: short enough to read aloud, long enough to pin. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SHA256:${hex}`;
}
