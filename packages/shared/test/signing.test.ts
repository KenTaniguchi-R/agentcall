import { describe, expect, it } from "vitest";
import {
  exportPublicKey, generateEncryptionKeyPair, generateIdentityKeyPair,
  importIdentityPublicKey, keyIdFor, signTranscript, verifyTranscript,
} from "../src/signing.js";

const transcript = new TextEncoder().encode("hello");

describe("signing", () => {
  it("verifies a signature it produced", async () => {
    const kp = await generateIdentityKeyPair();
    const sig = await signTranscript(kp.privateKey, transcript);
    expect(await verifyTranscript(kp.publicKey, transcript, sig)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    const sig = await signTranscript(a.privateKey, transcript);
    expect(await verifyTranscript(b.publicKey, transcript, sig)).toBe(false);
  });

  it("rejects a signature over different bytes", async () => {
    const kp = await generateIdentityKeyPair();
    const sig = await signTranscript(kp.privateKey, transcript);
    const tampered = new TextEncoder().encode("hellp");
    expect(await verifyTranscript(kp.publicKey, tampered, sig)).toBe(false);
  });

  it("returns false rather than throwing on a malformed signature", async () => {
    const kp = await generateIdentityKeyPair();
    expect(await verifyTranscript(kp.publicKey, transcript, "!!!not-base64url!!!")).toBe(false);
  });

  it("round-trips a public key through export and import", async () => {
    const kp = await generateIdentityKeyPair();
    const exported = await exportPublicKey(kp.publicKey);
    const imported = await importIdentityPublicKey(exported);
    const sig = await signTranscript(kp.privateKey, transcript);
    expect(await verifyTranscript(imported, transcript, sig)).toBe(true);
  });

  it("exports an encryption public key as base64url", async () => {
    const kp = await generateEncryptionKeyPair();
    expect(await exportPublicKey(kp.publicKey)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives a stable 32-hex key id", async () => {
    const kp = await generateEncryptionKeyPair();
    const pub = await exportPublicKey(kp.publicKey);
    const a = await keyIdFor(pub);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyIdFor(pub)).toBe(a);
  });
});
