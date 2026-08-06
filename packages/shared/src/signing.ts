// Web Crypto only: this module must run unchanged in Node and in workerd.
const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The unpadded base64url alphabet. The single source for "looks like base64url". */
export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Canonical unpadded base64url, or null. `atob` ignores the unused low bits of
 * a final sextet, so several spellings decode to the same bytes; requiring the
 * round trip means a signed token has exactly one textual form. Use this, not
 * `fromBase64Url`, whenever the input is attacker-supplied — that one throws on
 * malformed input and accepts non-canonical spellings.
 *
 * The round trip also rejects lengths of 1 mod 4. Four characters carry three
 * bytes, so a base64url string's length is always 0, 2, or 3 mod 4; a length of
 * 1 is not a short encoding of anything, it is not an encoding at all.
 */
export function fromBase64UrlStrict(value: string): Uint8Array | null {
  if (!BASE64URL_RE.test(value)) return null;
  try {
    const bytes = fromBase64Url(value);
    return toBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/** `byteLength` CSPRNG bytes as canonical unpadded base64url. */
export function randomBase64Url(byteLength: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

// P-256 ECDH is the key material HPKE's DHKEM(P-256, HKDF-SHA256) uses. Stage 2
// hands these to @hpke/core; stage 1 only publishes the public half.
export function generateEncryptionKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export function importIdentityPublicKey(b64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(b64url) as BufferSource, ECDSA_PARAMS, true, ["verify"]);
}

export async function signTranscript(privateKey: CryptoKey, transcript: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN_PARAMS, privateKey, transcript as BufferSource);
  return toBase64Url(new Uint8Array(sig));
}

/**
 * Returns false rather than throwing on malformed input. A caller checking a
 * remote record must not have to distinguish "bad signature" from "bad
 * base64" — both mean do not trust this record.
 */
export async function verifyTranscript(
  publicKey: CryptoKey, transcript: Uint8Array, signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      SIGN_PARAMS, publicKey, fromBase64Url(signature) as BufferSource, transcript as BufferSource,
    );
  } catch {
    return false;
  }
}

export async function keyIdFor(publicKeyB64url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKeyB64url) as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { fromBase64Url, toBase64Url };
