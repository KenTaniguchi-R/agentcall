// Opaque tokens the relay hands to a client and must later trust back: audit
// export cursors, audit completion receipts, and A2A task page tokens. All
// three carry relay state through the client, so all three need the same
// property — the client may hold it but may not author or edit it.
//
// The wire form is `base64url(payload).base64url(hmac)`. Only the codec lives
// here. Key derivation stays with each caller because the derivations differ
// and must stay byte-stable (changing one invalidates every token already
// issued under it), and claim validation stays there too because what a
// payload must assert is genuinely per-token.
import { fromBase64UrlStrict, toBase64Url } from "./signing.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export async function encodeSignedToken(payload: unknown, key: CryptoKey): Promise<string> {
  const encoded = ENCODER.encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoded as BufferSource));
  return `${toBase64Url(encoded)}.${toBase64Url(signature)}`;
}

/**
 * Returns the parsed payload, or null for anything the relay did not issue
 * under `key`: oversized, malformed, non-canonically re-spelled, or unsigned.
 *
 * A null return means "do not trust", nothing more specific — callers must not
 * try to distinguish a bad signature from bad base64, since both mean the same
 * thing to a client that should have echoed back exactly what it was given.
 *
 * The payload is NOT validated beyond being JSON. The signature proves the
 * relay authored these bytes; it does not prove they still describe a valid
 * request, so callers must still check their own claims (scope, filters,
 * ranges) against the current one.
 */
export async function decodeSignedToken<T>(
  token: string, key: CryptoKey, maxLength: number,
): Promise<T | null> {
  if (token.length > maxLength) return null;
  const [payloadValue, signatureValue, extra] = token.split(".");
  if (!payloadValue || !signatureValue || extra !== undefined) return null;
  const payload = fromBase64UrlStrict(payloadValue);
  const signature = fromBase64UrlStrict(signatureValue);
  if (!payload || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", key, signature as BufferSource, payload as BufferSource,
    );
    return valid ? JSON.parse(DECODER.decode(payload)) as T : null;
  } catch {
    return null;
  }
}
