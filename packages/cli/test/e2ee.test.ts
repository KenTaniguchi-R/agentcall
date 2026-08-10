import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
  keyIdFor, MAX_MESSAGE_BYTES, MAX_REPLY_BYTES, requestTranscript, transcriptHash, type E2EERequestPayloadType,
  type E2EEResponsePayloadType,
} from "@benree/agentcall-shared";
import { generateIdentityKeys, type StoredKeys } from "../src/keys.js";
import { getPaths } from "../src/paths.js";
import { openE2EERequest, openE2EEResponse, sealE2EERequest, sealE2EEResponse } from "../src/e2ee.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function keys(name: string): Promise<StoredKeys> {
  const root = mkdtempSync(join(tmpdir(), `agentcall-e2ee-${name}-`));
  roots.push(root);
  return generateIdentityKeys(getPaths(root, root));
}

const NOW = 1_000_000;
async function request(sender: StoredKeys, recipient: StoredKeys): Promise<E2EERequestPayloadType> {
  return {
    v: 1, direction: "request", relay_origin: "acme.agentcall.test",
    from: "@acme/alice", to: "@acme/bob",
    request_id: "1".repeat(32), sender_identity_key_id: await keyIdFor(sender.identity_pub),
    recipient_encryption_key_id: await keyIdFor(recipient.encryption_pub),
    recipient_epoch: recipient.epoch, issued_at: NOW - 1, expires_at: NOW + 1_000,
    task: "ask", message: "private hello",
  };
}
const expected = (payload: E2EERequestPayloadType | E2EEResponsePayloadType) => ({
  relay_origin: payload.relay_origin, from: payload.from, to: payload.to,
  key_id: payload.recipient_encryption_key_id, epoch: payload.recipient_epoch,
});

describe("E2EE HPKE envelopes", () => {
  it("round-trips a signed request against the pinned sender identity", async () => {
    const alice = await keys("alice");
    const bob = await keys("bob");
    const payload = await request(alice, bob);
    const envelope = await sealE2EERequest(payload, alice, {
      pub: bob.encryption_pub, key_id: payload.recipient_encryption_key_id, epoch: bob.epoch,
    });
    expect(JSON.stringify(envelope)).not.toContain(payload.message);
    await expect(openE2EERequest(envelope, bob.encryption_pkcs8, alice.identity_pub, expected(payload), NOW)).resolves.toEqual(payload);
  });

  it("round-trips a signed response bound to the request transcript", async () => {
    const alice = await keys("alice");
    const bob = await keys("bob");
    const original = await request(alice, bob);
    const payload: E2EEResponsePayloadType = {
      v: 1, direction: "response", relay_origin: original.relay_origin,
      from: original.to, to: original.from, request_id: original.request_id,
      sender_identity_key_id: await keyIdFor(bob.identity_pub),
      recipient_encryption_key_id: await keyIdFor(alice.encryption_pub),
      recipient_epoch: alice.epoch, issued_at: NOW, expires_at: NOW + 1_000,
      request_transcript_hash: await transcriptHash(requestTranscript(original)),
      outcome: { kind: "reply", text: "private reply", task: "ask" },
    };
    const envelope = await sealE2EEResponse(payload, bob, {
      pub: alice.encryption_pub, key_id: payload.recipient_encryption_key_id, epoch: alice.epoch,
    });
    expect(JSON.stringify(envelope)).not.toContain("private reply");
    const binding = {
      request_id: original.request_id,
      request_transcript_hash: payload.request_transcript_hash,
    };
    await expect(openE2EEResponse(
      envelope, alice.encryption_pkcs8, bob.identity_pub, expected(payload), binding, NOW,
    )).resolves.toEqual(payload);
    await expect(openE2EEResponse(
      envelope, alice.encryption_pkcs8, bob.identity_pub, expected(payload),
      { ...binding, request_transcript_hash: "f".repeat(64) }, NOW,
    )).rejects.toThrow(/expected request transcript/);
  });

  it("round-trips maximum-size request and reply strings under worst-case JSON escaping", async () => {
    const alice = await keys("alice");
    const bob = await keys("bob");
    const maximumRequest = { ...await request(alice, bob), message: "\u0000".repeat(MAX_MESSAGE_BYTES) };
    const requestEnvelope = await sealE2EERequest(maximumRequest, alice, {
      pub: bob.encryption_pub, key_id: maximumRequest.recipient_encryption_key_id, epoch: bob.epoch,
    });
    await expect(openE2EERequest(
      requestEnvelope, bob.encryption_pkcs8, alice.identity_pub, expected(maximumRequest), NOW,
    )).resolves.toEqual(maximumRequest);

    const maximumResponse: E2EEResponsePayloadType = {
      v: 1, direction: "response", relay_origin: maximumRequest.relay_origin,
      from: maximumRequest.to, to: maximumRequest.from, request_id: maximumRequest.request_id,
      sender_identity_key_id: await keyIdFor(bob.identity_pub),
      recipient_encryption_key_id: await keyIdFor(alice.encryption_pub),
      recipient_epoch: alice.epoch, issued_at: NOW, expires_at: NOW + 1_000,
      request_transcript_hash: await transcriptHash(requestTranscript(maximumRequest)),
      outcome: { kind: "reply", text: "\u0000".repeat(MAX_REPLY_BYTES) },
    };
    const responseEnvelope = await sealE2EEResponse(maximumResponse, bob, {
      pub: alice.encryption_pub, key_id: maximumResponse.recipient_encryption_key_id, epoch: alice.epoch,
    });
    await expect(openE2EEResponse(
      responseEnvelope, alice.encryption_pkcs8, bob.identity_pub, expected(maximumResponse),
      { request_id: maximumResponse.request_id, request_transcript_hash: maximumResponse.request_transcript_hash }, NOW,
    )).resolves.toEqual(maximumResponse);
  });

  it("fails closed for wrong keys, pinned identities, ciphertext, and AAD", async () => {
    const alice = await keys("alice");
    const bob = await keys("bob");
    const mallory = await keys("mallory");
    const payload = await request(alice, bob);
    const envelope = await sealE2EERequest(payload, alice, {
      pub: bob.encryption_pub, key_id: payload.recipient_encryption_key_id, epoch: bob.epoch,
    });
    await expect(openE2EERequest(envelope, mallory.encryption_pkcs8, alice.identity_pub, expected(payload), NOW)).rejects.toThrow();
    await expect(openE2EERequest(envelope, bob.encryption_pkcs8, mallory.identity_pub, expected(payload), NOW)).rejects.toThrow(/pinned|signature/);
    const tamperedCt = `${envelope.ct[0] === "A" ? "B" : "A"}${envelope.ct.slice(1)}`;
    await expect(openE2EERequest({ ...envelope, ct: tamperedCt }, bob.encryption_pkcs8, alice.identity_pub, expected(payload), NOW)).rejects.toThrow();
    const tamperedAad = { ...envelope, epoch: envelope.epoch + 1 };
    await expect(openE2EERequest(
      tamperedAad, bob.encryption_pkcs8, alice.identity_pub,
      { ...expected(payload), epoch: tamperedAad.epoch }, NOW,
    )).rejects.toThrow();
  });

  it("rejects expired and future-dated signed payloads after decryption", async () => {
    const alice = await keys("alice");
    const bob = await keys("bob");
    const base = await request(alice, bob);
    for (const payload of [
      { ...base, issued_at: NOW - 2_000, expires_at: NOW - 1_000 },
      { ...base, issued_at: NOW + 120_001, expires_at: NOW + 121_000 },
    ]) {
      const envelope = await sealE2EERequest(payload, alice, {
        pub: bob.encryption_pub, key_id: payload.recipient_encryption_key_id, epoch: bob.epoch,
      });
      await expect(openE2EERequest(envelope, bob.encryption_pkcs8, alice.identity_pub, expected(payload), NOW)).rejects.toThrow(/expired|future/);
    }
  });
});

const hex = (value: string) => Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
const toHex = (value: ArrayBuffer) => Array.from(new Uint8Array(value)).map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("RFC 9180 known-answer vector", () => {
  it("matches the official P-256/HKDF-SHA256/AES-128-GCM base-mode vector", async () => {
    const hpke = new CipherSuite({
      kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm(),
    });
    const recipient = await hpke.kem.deriveKeyPair(hex("668b37171f1072f3cf12ea8a236a45df23fc13b82af3609ad1e354f6ef817550"));
    const ephemeral = await hpke.kem.deriveKeyPair(hex("4270e54ffd08d79d5928020af4686d8f6b7d35dbe470265f1f5aa22816ce860e"));
    expect(toHex(await hpke.kem.serializePublicKey(recipient.publicKey))).toBe("04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0");
    const sender = await hpke.createSenderContext({
      recipientPublicKey: recipient.publicKey,
      info: hex("4f6465206f6e2061204772656369616e2055726e"), ekm: ephemeral,
    });
    expect(toHex(sender.enc)).toBe("04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4");
    const ct = await sender.seal(
      hex("4265617574792069732074727574682c20747275746820626561757479"),
      hex("436f756e742d30"),
    );
    expect(toHex(ct)).toBe("5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434");
  });
});
