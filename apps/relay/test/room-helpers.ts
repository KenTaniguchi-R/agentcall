import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import {
  canonicalRoomJoinProofTranscript, toBase64Url,
  type RoomCreateResponseType, type RoomJoinResponseType,
  type RoomMutationResponseType, type RoomPublicParticipantType,
} from "@benree/agentcall-shared";

export const roomTestKey = (letter: string) => letter.repeat(42) + "A";
const adapter = "claude@2.1.220:darwin/arm64";
const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const signingKeys = new Map<string, Promise<CryptoKeyPair>>();

function signingKeyPair(label: string): Promise<CryptoKeyPair> {
  let pair = signingKeys.get(label);
  if (!pair) {
    pair = crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
    signingKeys.set(label, pair);
  }
  return pair;
}

export async function roomJoinBody(
  invite: string,
  name: string,
  letter = "C",
  encryptionKey = roomTestKey(
    base64urlAlphabet[(base64urlAlphabet.indexOf(letter) + 17) % base64urlAlphabet.length]!,
  ),
  participantSecret = roomTestKey(letter),
) {
  const pair = await signingKeyPair(letter);
  const signingPublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const unsigned = {
    invite,
    participant_secret: participantSecret,
    display_name: name,
    signing_public_key: signingPublicKey,
    encryption_public_key: encryptionKey,
    agent_adapter: adapter,
  };
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" }, pair.privateKey, canonicalRoomJoinProofTranscript(unsigned) as BufferSource,
  );
  return { ...unsigned, signing_proof: toBase64Url(new Uint8Array(signature)) };
}

export type RoomTestErrorBody = { error?: string };
export type RoomTestJoinBody = Omit<RoomJoinResponseType, "credential"> & {
  credential: string;
} & RoomTestErrorBody;
export type RoomTestMutationBody = Omit<RoomMutationResponseType, "participant"> & {
  participant: RoomPublicParticipantType;
} & RoomTestErrorBody;

export async function roomJson<T>(res: Response) {
  return { status: res.status, body: await res.json<T>() };
}

export async function createTestRoom(seats = 2, name = "Host"): Promise<RoomCreateResponseType> {
  const res = await SELF.fetch("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expected_participants: seats,
      display_name: name,
      signing_public_key: roomTestKey("A"),
      encryption_public_key: roomTestKey("B"),
      agent_adapter: adapter,
    }),
  });
  expect(res.status).toBe(201);
  return res.json<RoomCreateResponseType>();
}

export async function joinTestRoom(invite: string, name: string, letter = "C") {
  const res = await SELF.fetch("https://relay.test/v1/rooms/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await roomJoinBody(invite, name, letter)),
  });
  return roomJson<RoomTestJoinBody>(res);
}

export function roomAuth(credential: string) {
  return { Authorization: `Bearer ${credential}`, "content-type": "application/json" };
}

export async function mutateTestRoom(credential: string, action: string, body: object = {}) {
  return roomJson<RoomTestMutationBody>(await SELF.fetch(`https://relay.test/v1/room/${action}`, {
    method: "POST", headers: roomAuth(credential), body: JSON.stringify(body),
  }));
}
