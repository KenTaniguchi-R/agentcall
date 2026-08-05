import { describe, expect, it } from "vitest";
import { verifyRoomJoinProof, randomBase64Url } from "@benree/agentcall-shared";
import {
  generateRoomKeys, parseRoomCapability, signRoomJoinProof, type RoomJoinProofInput,
} from "../src/room-crypto.js";

function unsignedProof(keys: Pick<RoomJoinProofInput, "signing_public_key" | "encryption_public_key">): RoomJoinProofInput {
  const secret = randomBase64Url(32);
  return {
    invite: `acri.room_${randomBase64Url(16)}.ri_${randomBase64Url(16)}.${secret}`,
    participant_secret: secret,
    display_name: "sota",
    agent_adapter: "claude@2.1.220:darwin/arm64",
    ...keys,
  };
}

describe("generateRoomKeys", () => {
  it("generates distinct signing and encryption keys, 32 raw bytes each", async () => {
    const keys = await generateRoomKeys();
    expect(keys.signingPublicKey).not.toBe(keys.encryptionPublicKey);
    expect(keys.signingPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.encryptionPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats across calls", async () => {
    const a = await generateRoomKeys();
    const b = await generateRoomKeys();
    expect(a.signingPublicKey).not.toBe(b.signingPublicKey);
    expect(a.encryptionPublicKey).not.toBe(b.encryptionPublicKey);
  });
});

describe("signRoomJoinProof", () => {
  it("produces a proof the relay's own verifier accepts", async () => {
    const keys = await generateRoomKeys();
    const unsigned = unsignedProof({
      signing_public_key: keys.signingPublicKey, encryption_public_key: keys.encryptionPublicKey,
    });
    const signing_proof = await signRoomJoinProof(keys, unsigned);
    expect(signing_proof).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifyRoomJoinProof({ ...unsigned, signing_proof })).toBe(true);
  });

  it("rejects a proof after any signed field is tampered with", async () => {
    const keys = await generateRoomKeys();
    const unsigned = unsignedProof({
      signing_public_key: keys.signingPublicKey, encryption_public_key: keys.encryptionPublicKey,
    });
    const signing_proof = await signRoomJoinProof(keys, unsigned);
    for (const field of ["display_name", "invite", "participant_secret", "agent_adapter"] as const) {
      const tampered = { ...unsigned, [field]: `${unsigned[field]}x`, signing_proof };
      expect(await verifyRoomJoinProof(tampered), field).toBe(false);
    }
  });

  it("rejects a proof signed by a different key", async () => {
    const keys = await generateRoomKeys();
    const impostor = await generateRoomKeys();
    const unsigned = unsignedProof({
      signing_public_key: keys.signingPublicKey, encryption_public_key: keys.encryptionPublicKey,
    });
    const signing_proof = await signRoomJoinProof(impostor, unsigned);
    expect(await verifyRoomJoinProof({ ...unsigned, signing_proof })).toBe(false);
  });
});

describe("parseRoomCapability", () => {
  it("round-trips a well-formed host capability", () => {
    const roomId = `room_${randomBase64Url(16)}`;
    const participantId = `rp_${randomBase64Url(16)}`;
    const secret = randomBase64Url(32);
    const parsed = parseRoomCapability(`acrp.${roomId}.${participantId}.${secret}`);
    expect(parsed).toEqual({ roomId, participantId, secret });
  });

  it("rejects malformed capabilities", () => {
    expect(parseRoomCapability("not-a-capability")).toBeNull();
    expect(parseRoomCapability("acri.room_x.ri_x.secret")).toBeNull(); // invite prefix, not participant
    expect(parseRoomCapability("")).toBeNull();
  });
});
