import {
  canonicalRoomJoinProofTranscript, exportPublicKey, RoomCapability, toBase64Url, type RoomJoinRequest,
} from "@benree/agentcall-shared";
import type { z } from "zod";

/**
 * A Room's signing/encryption keys are ephemeral: generated in memory per
 * `agentcall room`/`room join` invocation and never written to disk. That is
 * the whole point of the accountless product — losing the process loses the
 * keys, on purpose, and nothing in this module ever touches the filesystem.
 */
export interface RoomKeyMaterial {
  signing: CryptoKeyPair;
  encryption: CryptoKeyPair;
  /** Raw 32-byte Ed25519 public key, base64url — RoomPublicKey-shaped. */
  signingPublicKey: string;
  /** Raw 32-byte X25519 public key, base64url — unused until R2b's call encryption. */
  encryptionPublicKey: string;
}

export async function generateRoomKeys(): Promise<RoomKeyMaterial> {
  const [signing, encryption] = await Promise.all([
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>,
    crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as Promise<CryptoKeyPair>,
  ]);
  const [signingPublicKey, encryptionPublicKey] = await Promise.all([
    exportPublicKey(signing.publicKey),
    exportPublicKey(encryption.publicKey),
  ]);
  return { signing, encryption, signingPublicKey, encryptionPublicKey };
}

export type RoomJoinProofInput = Omit<z.input<typeof RoomJoinRequest>, "signing_proof">;

/** Signs the exact transcript the relay re-derives in `verifyRoomJoinProof`. */
export async function signRoomJoinProof(keys: RoomKeyMaterial, unsigned: RoomJoinProofInput): Promise<string> {
  const transcript = canonicalRoomJoinProofTranscript(unsigned);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.signing.privateKey, transcript as BufferSource);
  return toBase64Url(new Uint8Array(signature));
}

/**
 * `acrp.<room_id>.<participant_id>.<secret>` — mirrors
 * `apps/relay/src/room/capability.ts`'s `parseRoomCapability`, which is
 * relay-internal and not exported from the shared package. `RoomCreateResponse`
 * (unlike `RoomJoinResponse`) does not include the host's own `participant`
 * object, so this is the only way the CLI learns its own `participant_id`
 * after creating a Room — confirmed by exercising the real relay, not assumed.
 */
export function parseRoomCapability(
  value: string,
): { roomId: string; participantId: string; secret: string } | null {
  if (!RoomCapability.safeParse(value).success) return null;
  const [, roomId, participantId, secret] = value.split(".");
  if (!roomId || !participantId || !secret) return null;
  return { roomId, participantId, secret };
}
