import { describe, expect, it } from "vitest";
import {
  decodeSignedToken, encodeSignedToken, fromBase64UrlStrict, randomBase64Url, toBase64Url,
} from "../src/index.js";

async function hmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

type Payload = { org: string; position: number };
const payload: Payload = { org: "acme", position: 42 };

describe("fromBase64UrlStrict", () => {
  it("round-trips canonical unpadded base64url", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    expect(fromBase64UrlStrict(toBase64Url(bytes))).toEqual(bytes);
  });

  it("rejects a non-canonical encoding that decodes to the same bytes", () => {
    // "AQ" and "AR" both decode to the single byte 0x01: the four unused low
    // bits of the final sextet are not checked by atob. Only the canonical
    // spelling may decode, or a signed token has textual aliases.
    expect(fromBase64UrlStrict("AQ")).toEqual(new Uint8Array([1]));
    expect(fromBase64UrlStrict("AR")).toBeNull();
  });

  it("rejects padding, standard-base64 alphabet, and empty input", () => {
    expect(fromBase64UrlStrict("AQ==")).toBeNull();
    expect(fromBase64UrlStrict("+/8")).toBeNull();
    expect(fromBase64UrlStrict("")).toBeNull();
  });

  // Four characters carry three bytes, so a base64url string's length is
  // always 0, 2, or 3 mod 4. A length of 1 mod 4 is not a short encoding of
  // anything — it is not an encoding at all.
  it.each([1, 5, 9, 13])("rejects the impossible length %i mod 4", (length) => {
    expect(fromBase64UrlStrict("A".repeat(length))).toBeNull();
  });
});

describe("signed tokens", () => {
  it("round-trips a payload under the key that signed it", async () => {
    const key = await hmacKey("secret");
    const token = await encodeSignedToken(payload, key);
    expect(await decodeSignedToken<Payload>(token, key, 1024)).toEqual(payload);
  });

  it("rejects a token signed by a different key", async () => {
    const token = await encodeSignedToken(payload, await hmacKey("secret"));
    expect(await decodeSignedToken<Payload>(token, await hmacKey("other"), 1024)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const key = await hmacKey("secret");
    const token = await encodeSignedToken(payload, key);
    const [, signature] = token.split(".");
    const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ org: "evil", position: 42 })));
    expect(await decodeSignedToken<Payload>(`${forged}.${signature}`, key, 1024)).toBeNull();
  });

  it("rejects a token whose payload is re-spelled non-canonically", async () => {
    const key = await hmacKey("secret");
    const token = await encodeSignedToken(payload, key);
    const [payloadValue, signature] = token.split(".");
    // Flip the unused low bits of the final base64url character. The bytes are
    // unchanged, so the HMAC still verifies — only the canonicality check
    // separates this from the token the relay actually issued.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = payloadValue!.at(-1)!;
    const aliased = payloadValue!.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]!;
    expect(aliased).not.toBe(payloadValue);
    expect(await decodeSignedToken<Payload>(`${aliased}.${signature}`, key, 1024)).toBeNull();
  });

  it("rejects tokens that are oversized or not exactly two parts", async () => {
    const key = await hmacKey("secret");
    const token = await encodeSignedToken(payload, key);
    expect(await decodeSignedToken<Payload>(token, key, token.length - 1)).toBeNull();
    expect(await decodeSignedToken<Payload>(`${token}.extra`, key, 1024)).toBeNull();
    expect(await decodeSignedToken<Payload>("nodot", key, 1024)).toBeNull();
    expect(await decodeSignedToken<Payload>("", key, 1024)).toBeNull();
    expect(await decodeSignedToken<Payload>(".", key, 1024)).toBeNull();
  });
});

describe("randomBase64Url", () => {
  it("emits canonical unpadded base64url of the requested byte length", () => {
    for (const bytes of [6, 16, 32]) {
      const value = randomBase64Url(bytes);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(fromBase64UrlStrict(value)).toHaveLength(bytes);
    }
  });

  it("does not repeat", () => {
    expect(randomBase64Url(16)).not.toBe(randomBase64Url(16));
  });
});
