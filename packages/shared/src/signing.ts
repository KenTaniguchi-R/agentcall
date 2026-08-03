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
