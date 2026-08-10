import {
  Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256,
} from "@hpke/core";
import {
  E2EE_REQUEST_INFO, E2EE_RESPONSE_INFO, E2EERequestPayload, E2EEResponsePayload,
  HpkeEnvelope, SignedE2EERequest, SignedE2EEResponse,
  fromBase64Url, hpkeEnvelopeAad, importIdentityPublicKey, keyIdFor,
  requestTranscript, responseTranscript, signTranscript, toBase64Url, verifyTranscript,
  type E2EERequestPayloadType, type E2EEResponsePayloadType,
  type HpkeEnvelopeHeaderType, type HpkeEnvelopeType,
} from "@benree/agentcall-shared";

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

interface SealIdentity {
  identity_pub: string;
  identity_pkcs8: string;
}

interface RecipientEncryptionKey {
  pub: string;
  key_id: string;
  epoch: number;
}

type ExpectedEnvelope = Pick<
  HpkeEnvelopeHeaderType, "relay_origin" | "from" | "to" | "key_id" | "epoch"
>;
interface ExpectedResponseBinding {
  message_id: string;
  request_id: string;
  request_transcript_hash: string;
  delivery_mode?: "sync" | "durable";
}

async function importIdentityPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", fromBase64Url(pkcs8) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

async function importEncryptionPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", fromBase64Url(pkcs8) as BufferSource,
    // @hpke/core derives the corresponding public point during decapsulation.
    // Node/WebCrypto needs an extractable imported private key so that step can
    // preserve the original point's Y parity rather than reconstructing only X.
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
}

async function hpkeSeal(
  recipientPublic: string, info: Uint8Array, plaintext: Uint8Array, aad: Uint8Array,
): Promise<{ enc: string; ct: string }> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64Url(recipientPublic));
  const sealed = await suite.seal({ recipientPublicKey, info }, plaintext, aad);
  return { enc: toBase64Url(new Uint8Array(sealed.enc)), ct: toBase64Url(new Uint8Array(sealed.ct)) };
}

async function hpkeOpen(
  recipientPkcs8: string, info: Uint8Array, envelope: HpkeEnvelopeType, aad: Uint8Array,
): Promise<unknown> {
  const recipientKey = await importEncryptionPrivateKey(recipientPkcs8);
  const opened = await suite.open(
    { recipientKey, enc: fromBase64Url(envelope.enc), info },
    fromBase64Url(envelope.ct), aad,
  );
  const json = new TextDecoder("utf-8", { fatal: true }).decode(opened);
  return JSON.parse(json) as unknown;
}

function envelopeHeader(envelope: HpkeEnvelopeType): HpkeEnvelopeHeaderType {
  return {
    v: envelope.v, direction: envelope.direction, relay_origin: envelope.relay_origin,
    from: envelope.from, to: envelope.to, key_id: envelope.key_id, epoch: envelope.epoch,
  };
}

function assertHeaderMatchesPayload(
  header: HpkeEnvelopeHeaderType,
  payload: E2EERequestPayloadType | E2EEResponsePayloadType,
): void {
  if (
    payload.direction !== header.direction || payload.relay_origin !== header.relay_origin ||
    payload.from !== header.from || payload.to !== header.to ||
    payload.recipient_encryption_key_id !== header.key_id || payload.recipient_epoch !== header.epoch
  ) throw new Error("Encrypted payload does not match its authenticated envelope header.");
}

function assertCurrent(payload: { issued_at: number; expires_at: number }, now: number): void {
  if (now >= payload.expires_at) throw new Error("Encrypted payload has expired.");
  if (payload.issued_at > now + 120_000) throw new Error("Encrypted payload was issued too far in the future.");
}

async function sealSigned(
  direction: "request" | "response",
  payload: E2EERequestPayloadType | E2EEResponsePayloadType,
  sender: SealIdentity,
  recipient: RecipientEncryptionKey,
): Promise<HpkeEnvelopeType> {
  if (recipient.key_id !== await keyIdFor(recipient.pub)) throw new Error("Recipient encryption key_id does not match its public key.");
  if (payload.sender_identity_key_id !== await keyIdFor(sender.identity_pub)) throw new Error("Sender identity key_id does not match its public key.");
  if (payload.recipient_encryption_key_id !== recipient.key_id || payload.recipient_epoch !== recipient.epoch) {
    throw new Error("Payload recipient key does not match the HPKE recipient.");
  }
  const transcript = direction === "request"
    ? requestTranscript(payload as E2EERequestPayloadType)
    : responseTranscript(payload as E2EEResponsePayloadType);
  const signature = await signTranscript(await importIdentityPrivateKey(sender.identity_pkcs8), transcript);
  const signed = { payload, signature };
  const plaintext = new TextEncoder().encode(JSON.stringify(signed));
  const header: HpkeEnvelopeHeaderType = {
    v: 1, direction, relay_origin: payload.relay_origin, from: payload.from, to: payload.to,
    key_id: recipient.key_id, epoch: recipient.epoch,
  };
  const info = direction === "request" ? E2EE_REQUEST_INFO : E2EE_RESPONSE_INFO;
  return HpkeEnvelope.parse({ ...header, ...await hpkeSeal(recipient.pub, info, plaintext, hpkeEnvelopeAad(header)) });
}

export async function sealE2EERequest(
  payload: E2EERequestPayloadType, sender: SealIdentity, recipient: RecipientEncryptionKey,
): Promise<HpkeEnvelopeType> {
  const parsed = E2EERequestPayload.parse(payload);
  return sealSigned("request", parsed, sender, recipient);
}

export async function sealE2EEResponse(
  payload: E2EEResponsePayloadType, sender: SealIdentity, recipient: RecipientEncryptionKey,
): Promise<HpkeEnvelopeType> {
  const parsed = E2EEResponsePayload.parse(payload);
  return sealSigned("response", parsed, sender, recipient);
}

async function openSigned<T extends E2EERequestPayloadType | E2EEResponsePayloadType>(
  direction: "request" | "response",
  rawEnvelope: unknown,
  recipientEncryptionPkcs8: string,
  pinnedSenderIdentityPub: string,
  expected: ExpectedEnvelope,
  now: number,
): Promise<T> {
  const envelope = HpkeEnvelope.parse(rawEnvelope);
  if (envelope.direction !== direction) throw new Error(`Expected an encrypted ${direction} envelope.`);
  for (const field of ["relay_origin", "from", "to", "key_id", "epoch"] as const) {
    if (envelope[field] !== expected[field]) throw new Error(`Encrypted ${direction} ${field} does not match the expected route.`);
  }
  const info = direction === "request" ? E2EE_REQUEST_INFO : E2EE_RESPONSE_INFO;
  const header = envelopeHeader(envelope);
  const raw = await hpkeOpen(recipientEncryptionPkcs8, info, envelope, hpkeEnvelopeAad(header));
  const signed = direction === "request" ? SignedE2EERequest.parse(raw) : SignedE2EEResponse.parse(raw);
  const payload = signed.payload as T;
  assertHeaderMatchesPayload(header, payload);
  if (payload.sender_identity_key_id !== await keyIdFor(pinnedSenderIdentityPub)) {
    throw new Error("Encrypted payload names a sender identity other than the pinned key.");
  }
  const transcript = direction === "request"
    ? requestTranscript(payload as E2EERequestPayloadType)
    : responseTranscript(payload as E2EEResponsePayloadType);
  if (!await verifyTranscript(await importIdentityPublicKey(pinnedSenderIdentityPub), transcript, signed.signature)) {
    throw new Error("Encrypted payload signature does not match the pinned sender identity.");
  }
  assertCurrent(payload, now);
  return payload;
}

export function openE2EERequest(
  envelope: unknown, recipientEncryptionPkcs8: string, pinnedSenderIdentityPub: string,
  expected: ExpectedEnvelope, now = Date.now(),
): Promise<E2EERequestPayloadType> {
  return openSigned("request", envelope, recipientEncryptionPkcs8, pinnedSenderIdentityPub, expected, now);
}

export async function openE2EEResponse(
  envelope: unknown, recipientEncryptionPkcs8: string, pinnedSenderIdentityPub: string,
  expected: ExpectedEnvelope, request: ExpectedResponseBinding, now = Date.now(),
): Promise<E2EEResponsePayloadType> {
  const payload = await openSigned<E2EEResponsePayloadType>(
    "response", envelope, recipientEncryptionPkcs8, pinnedSenderIdentityPub, expected, now,
  );
  if (
    payload.message_id !== request.message_id ||
    payload.request_id !== request.request_id ||
    payload.request_transcript_hash !== request.request_transcript_hash ||
    payload.delivery_mode !== request.delivery_mode
  ) {
    throw new Error("Encrypted response does not bind to the expected request transcript.");
  }
  return payload;
}
