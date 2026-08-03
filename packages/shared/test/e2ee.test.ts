import { describe, expect, it } from "vitest";
import {
  E2EECallerFrame, E2EEListenerToRelayFrame, E2EERelayToCallerFrame,
  E2EERequestPayload, E2EEResponsePayload, HpkeEnvelope, MAX_E2EE_CIPHERTEXT_BYTES,
  hpkeEnvelopeAad, requestTranscript, responseTranscript, transcriptHash, type E2EERequestPayloadType,
  type E2EEResponsePayloadType,
} from "../src/e2ee.js";

const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const request: E2EERequestPayloadType = {
  v: 1, direction: "request", relay_origin: "acme.agentcall.test",
  from: "alice@acme.agentcall.test", to: "bob@acme.agentcall.test",
  request_id: "1".repeat(32), sender_identity_key_id: "2".repeat(32),
  recipient_encryption_key_id: "3".repeat(32), recipient_epoch: 2,
  issued_at: 100, expires_at: 200, task: "ask", message: "hello",
};

describe("E2EE envelope schemas and transcripts", () => {
  it("makes plaintext request and outcome fields impossible on the live wire", () => {
    const requestEnvelope = {
      v: 1 as const, direction: "request" as const, relay_origin: request.relay_origin,
      from: request.from, to: request.to, key_id: request.recipient_encryption_key_id,
      epoch: request.recipient_epoch, enc: "A", ct: "B",
    };
    expect(E2EECallerFrame.safeParse({ type: "call_request", envelope: requestEnvelope }).success).toBe(true);
    for (const field of ["message", "task", "context_id"] as const) {
      expect(E2EECallerFrame.safeParse({
        type: "call_request", envelope: requestEnvelope, [field]: "plaintext",
      }).success).toBe(false);
    }
    const responseEnvelope = { ...requestEnvelope, direction: "response" as const };
    expect(E2EEListenerToRelayFrame.safeParse({
      type: "call_outcome", call_id: "c1", terminal: "completed", envelope: responseEnvelope,
    }).success).toBe(true);
    for (const field of ["text", "detail", "offered"] as const) {
      expect(E2EEListenerToRelayFrame.safeParse({
        type: "call_outcome", call_id: "c1", terminal: "failed", envelope: responseEnvelope,
        [field]: field === "offered" ? ["ask"] : "plaintext",
      }).success).toBe(false);
    }
  });

  it("separates unauthenticated relay errors from encrypted peer outcomes", () => {
    expect(E2EERelayToCallerFrame.safeParse({
      type: "call_error", origin: "relay", code: "offline",
    }).success).toBe(true);
    expect(E2EERelayToCallerFrame.safeParse({
      type: "call_error", origin: "relay", code: "blocked",
    }).success).toBe(false);
    expect(E2EERelayToCallerFrame.safeParse({
      type: "call_error", origin: "relay", code: "offline", detail: "peer said no",
    }).success).toBe(false);
  });

  it("binds every relay-visible routing field into AAD", () => {
    const base = {
      v: 1 as const, direction: "request" as const, relay_origin: request.relay_origin,
      from: request.from, to: request.to,
      key_id: request.recipient_encryption_key_id, epoch: request.recipient_epoch,
    };
    const aad = hpkeEnvelopeAad(base);
    for (const changed of [
      { ...base, relay_origin: "other.agentcall.test" },
      { ...base, from: "mallory@acme.agentcall.test" },
      { ...base, to: "carol@acme.agentcall.test" },
      { ...base, key_id: "4".repeat(32) },
      { ...base, epoch: 3 },
    ]) expect(hpkeEnvelopeAad(changed)).not.toEqual(aad);
  });

  it("binds optional request fields without ambiguous concatenation", () => {
    const transcript = requestTranscript(request);
    expect(toHex(transcript)).toBe(
      "01000000146167656e7463616c6c2f726571756573742f7631020000000000000001010000000772657175657374" +
      "010000001361636d652e6167656e7463616c6c2e746573740100000019616c6963654061636d652e6167656e7463616c6c2e74657374" +
      "0100000017626f624061636d652e6167656e7463616c6c2e7465737401000000203131313131313131313131313131313131313131313131313131313131313131" +
      "0100000020323232323232323232323232323232323232323232323232323232323232323201000000203333333333333333333333333333333333333333333333333333333333333333" +
      "0200000000000000020200000000000000640200000000000000c8010000000361736b03010000000568656c6c6f",
    );
    expect(requestTranscript({ ...request, task: undefined, context_id: undefined })).not.toEqual(transcript);
    expect(requestTranscript({ ...request, message: "hello!" })).not.toEqual(transcript);
    expect(requestTranscript({ ...request, request_id: "4".repeat(32) })).not.toEqual(transcript);
  });

  it("binds response outcomes and the originating request hash", async () => {
    const response: E2EEResponsePayloadType = {
      v: 1, direction: "response", relay_origin: request.relay_origin,
      from: request.to, to: request.from, request_id: request.request_id,
      sender_identity_key_id: "5".repeat(32), recipient_encryption_key_id: "6".repeat(32),
      recipient_epoch: request.recipient_epoch, issued_at: request.issued_at, expires_at: request.expires_at,
      request_transcript_hash: await transcriptHash(requestTranscript(request)),
      outcome: { kind: "failure", code: "task_not_offered", offered: ["ask", "review"] },
    };
    expect(toHex(responseTranscript(response))).toBe(
      "01000000156167656e7463616c6c2f726573706f6e73652f76310200000000000000010100000008726573706f6e7365" +
      "010000001361636d652e6167656e7463616c6c2e746573740100000017626f624061636d652e6167656e7463616c6c2e74657374" +
      "0100000019616c6963654061636d652e6167656e7463616c6c2e7465737401000000203131313131313131313131313131313131313131313131313131313131313131" +
      "0100000020353535353535353535353535353535353535353535353535353535353535353501000000203636363636363636363636363636363636363636363636363636363636363636" +
      "0200000000000000020200000000000000640200000000000000c8010000004063643064643336646238313238313438666232656330643263353233313032356238653961636338333138623432383830353865616533336332616538363239" +
      "01000000076661696c75726501000000107461736b5f6e6f745f6f66666572656403020000000000000002010000000361736b0100000006726576696577",
    );
    expect(responseTranscript({ ...response, request_transcript_hash: "7".repeat(64) })).not.toEqual(responseTranscript(response));
    expect(responseTranscript({
      ...response,
      outcome: { kind: "failure", code: "task_not_offered", offered: ["review", "ask"] },
    })).not.toEqual(responseTranscript(response));
  });

  it("rejects oversized UTF-8 content and overlong ciphertext before decoding", () => {
    expect(() => E2EERequestPayload.parse({ ...request, message: "😀".repeat(16_001) })).toThrow(/64000 UTF-8 bytes/);
    expect(() => HpkeEnvelope.parse({
      v: 1, direction: "request", relay_origin: request.relay_origin,
      from: request.from, to: request.to, key_id: "3".repeat(32), epoch: 1,
      enc: "A".repeat(87), ct: "A".repeat(Math.ceil((MAX_E2EE_CIPHERTEXT_BYTES + 1) * 4 / 3)),
    })).toThrow(/ciphertext/);
  });

  it("rejects validity windows longer than the relay deadline", () => {
    expect(() => E2EERequestPayload.parse({ ...request, expires_at: 400_000 })).toThrow(/validity/);
  });

  it("rejects unpaired surrogates before TextEncoder can collapse distinct signed values", async () => {
    expect(() => E2EERequestPayload.parse({ ...request, message: "\ud800" })).toThrow(/well-formed Unicode/);
    expect(E2EERequestPayload.parse({ ...request, message: "😀" }).message).toBe("😀");

    const responseBase = {
      v: 1 as const, direction: "response" as const, relay_origin: request.relay_origin,
      from: request.to, to: request.from, request_id: request.request_id,
      sender_identity_key_id: "5".repeat(32), recipient_encryption_key_id: "6".repeat(32),
      recipient_epoch: request.recipient_epoch, issued_at: request.issued_at, expires_at: request.expires_at,
      request_transcript_hash: await transcriptHash(requestTranscript(request)),
    };
    expect(() => E2EEResponsePayload.parse({
      ...responseBase, outcome: { kind: "reply", text: "\ud801" },
    })).toThrow(/well-formed Unicode/);
    expect(() => E2EEResponsePayload.parse({
      ...responseBase, outcome: { kind: "failure", code: "agent_error", detail: "\udfff" },
    })).toThrow(/well-formed Unicode/);
  });
});
