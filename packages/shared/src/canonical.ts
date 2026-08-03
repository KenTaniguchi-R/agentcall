/**
 * Deterministic encoding for bytes that get signed.
 *
 * `JSON.stringify` is not signable: object key order and Unicode escaping are
 * not stable across implementations, and that instability is a well-known
 * source of signature-bypass bugs. This is a tagged, length-prefixed format,
 * so no two distinct value lists can produce the same bytes.
 */
export type CanonicalValue = string | number | null;

const TAG_STRING = 1;
const TAG_INT = 2;
const TAG_NULL = 3;

export function canonicalEncode(values: readonly CanonicalValue[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const value of values) {
    if (value === null) {
      parts.push(Uint8Array.of(TAG_NULL));
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`canonicalEncode: ${value} is not a safe integer`);
      }
      const buf = new Uint8Array(9);
      buf[0] = TAG_INT;
      new DataView(buf.buffer).setBigInt64(1, BigInt(value), false);
      parts.push(buf);
      continue;
    }
    const bytes = encoder.encode(value);
    const buf = new Uint8Array(5 + bytes.byteLength);
    buf[0] = TAG_STRING;
    new DataView(buf.buffer).setUint32(1, bytes.byteLength, false);
    buf.set(bytes, 5);
    parts.push(buf);
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
