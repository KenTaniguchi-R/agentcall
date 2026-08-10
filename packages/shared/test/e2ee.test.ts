import { describe, expect, it } from "vitest";
import {
  E2EECallerFrame, E2EEListenerToRelayFrame, E2EERelayToCallerFrame, E2EERelayToListenerFrame,
  E2EERequestPayload, E2EEResponsePayload, HpkeEnvelope, MAX_E2EE_CIPHERTEXT_BYTES,
  hpkeEnvelopeAad, requestTranscript, responseTranscript, transcriptHash, type E2EERequestPayloadType,
  type E2EEResponsePayloadType,
} from "../src/e2ee.js";
import { MAILBOX_TTL_MS } from "../src/protocol.js";

const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const request: E2EERequestPayloadType = {
  v: 1, direction: "request", relay_origin: "acme.agentcall.test",
  from: "@acme/alice", to: "@acme/bob",
  message_id: "9".repeat(32),
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
    expect(E2EECallerFrame.safeParse({
      type: "call_request", envelope: requestEnvelope, message_id: request.message_id,
      correlation_id: "4".repeat(32),
    }).success).toBe(true);
    for (const field of ["message", "task", "context_id"] as const) {
      expect(E2EECallerFrame.safeParse({
        type: "call_request", envelope: requestEnvelope, message_id: request.message_id,
        correlation_id: "4".repeat(32), [field]: "plaintext",
      }).success).toBe(false);
    }
    const responseEnvelope = { ...requestEnvelope, direction: "response" as const };
    expect(E2EEListenerToRelayFrame.safeParse({
      type: "call_outcome", call_id: "c1", terminal: "completed", envelope: responseEnvelope,
      terminal_reason: "completed",
    }).success).toBe(true);
    for (const field of ["text", "detail", "offered"] as const) {
      expect(E2EEListenerToRelayFrame.safeParse({
        type: "call_outcome", call_id: "c1", terminal: "failed", envelope: responseEnvelope,
        [field]: field === "offered" ? ["ask"] : "plaintext",
      }).success).toBe(false);
    }
  });

  it("requires one idempotency id in both the signed request and relay-visible frame", () => {
    const requestEnvelope = {
      v: 1 as const, direction: "request" as const, relay_origin: request.relay_origin,
      from: request.from, to: request.to, key_id: request.recipient_encryption_key_id,
      epoch: request.recipient_epoch, enc: "A", ct: "B",
    };
    expect(E2EERequestPayload.safeParse({ ...request, message_id: undefined }).success).toBe(false);
    expect(E2EECallerFrame.safeParse({
      type: "call_request", envelope: requestEnvelope, correlation_id: "4".repeat(32),
    }).success).toBe(false);
    expect(E2EECallerFrame.parse({
      type: "call_request", envelope: requestEnvelope, message_id: request.message_id,
      correlation_id: "4".repeat(32),
    }).message_id).toBe(request.message_id);
  });

  it("requires correlation metadata on both sides of call admission", () => {
    const requestEnvelope = {
      v: 1 as const, direction: "request" as const, relay_origin: request.relay_origin,
      from: request.from, to: request.to, key_id: request.recipient_encryption_key_id,
      epoch: request.recipient_epoch, enc: "A", ct: "B",
    };
    expect(E2EECallerFrame.safeParse({ type: "call_request", envelope: requestEnvelope }).success).toBe(false);
    expect(E2EERelayToListenerFrame.safeParse({
      type: "incoming_call", call_id: "c1", from: "alice", envelope: requestEnvelope,
    }).success).toBe(false);
  });

  it("round-trips durable queue receipts and lease-bound listener frames", () => {
    const leaseId = "11111111-1111-4111-8111-111111111111";
    const requestEnvelope = {
      v: 1 as const, direction: "request" as const, relay_origin: request.relay_origin,
      from: request.from, to: request.to, key_id: request.recipient_encryption_key_id,
      epoch: request.recipient_epoch, enc: "A", ct: "B",
    };
    expect(E2EERelayToCallerFrame.parse({
      type: "call_queued", call_id: "call-1", message_id: request.message_id,
      correlation_id: "4".repeat(32), submitted_at: 1_000, expires_at: 2_000,
    }).type).toBe("call_queued");
    expect(E2EERelayToListenerFrame.parse({
      type: "incoming_call", call_id: "call-1", from: "alice", envelope: requestEnvelope,
      message_id: request.message_id, delivery_mode: "durable", lease_id: leaseId,
      execute_by: 2_000, correlation_id: "4".repeat(32),
    }).type).toBe("incoming_call");
    expect(E2EEListenerToRelayFrame.parse({
      type: "call_started", call_id: "call-1", lease_id: leaseId,
    }).lease_id).toBe(leaseId);
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
      { ...base, from: "@acme/mallory" },
      { ...base, to: "@acme/carol" },
      { ...base, key_id: "4".repeat(32) },
      { ...base, epoch: 3 },
    ]) expect(hpkeEnvelopeAad(changed)).not.toEqual(aad);
  });

  it("binds optional request fields without ambiguous concatenation", () => {
    const transcript = requestTranscript(request);
    expect(toHex(transcript)).toBe(
      "01000000146167656e7463616c6c2f726571756573742f7631020000000000000001010000000772657175657374010000001361636d652e6167656e7463616c6c2e74657374010000000b4061636d652f616c69636501000000094061636d652f626f62010000002039393939393939393939393939393939393939393939393939393939393939390100000020313131313131313131313131313131313131313131313131313131313131313101000000203232323232323232323232323232323232323232323232323232323232323232010000002033333333333333333333333333333333333333333333333333333333333333330200000000000000020200000000000000640200000000000000c8010000000361736b03010000000568656c6c6f",
    );
    expect(requestTranscript({ ...request, task: undefined, context_id: undefined })).not.toEqual(transcript);
    expect(requestTranscript({ ...request, message: "hello!" })).not.toEqual(transcript);
    expect(requestTranscript({ ...request, message_id: "8".repeat(32) })).not.toEqual(transcript);
    expect(requestTranscript({ ...request, delivery_mode: "durable" })).not.toEqual(transcript);
    expect(requestTranscript({ ...request, request_id: "4".repeat(32) })).not.toEqual(transcript);
  });

  it("binds response outcomes and the originating request hash", async () => {
    const response: E2EEResponsePayloadType = {
      v: 1, direction: "response", relay_origin: request.relay_origin,
      from: request.to, to: request.from, request_id: request.request_id,
      message_id: request.message_id,
      sender_identity_key_id: "5".repeat(32), recipient_encryption_key_id: "6".repeat(32),
      recipient_epoch: request.recipient_epoch, issued_at: request.issued_at, expires_at: request.expires_at,
      request_transcript_hash: await transcriptHash(requestTranscript(request)),
      outcome: { kind: "failure", code: "task_unknown", offered: ["ask", "review"] },
    };
    expect(toHex(responseTranscript(response))).toBe(
      "01000000156167656e7463616c6c2f726573706f6e73652f76310200000000000000010100000008726573706f6e7365010000001361636d652e6167656e7463616c6c2e7465737401000000094061636d652f626f62010000000b4061636d652f616c696365010000002039393939393939393939393939393939393939393939393939393939393939390100000020313131313131313131313131313131313131313131313131313131313131313101000000203535353535353535353535353535353535353535353535353535353535353535010000002036363636363636363636363636363636363636363636363636363636363636360200000000000000020200000000000000640200000000000000c801000000406533303931333439646130373231373936393564623639373866316263383263303132366562623865303763613334663235643364336261353065313139376501000000076661696c757265010000000c7461736b5f756e6b6e6f776e03020000000000000002010000000361736b0100000006726576696577",
    );
    expect(responseTranscript({ ...response, request_transcript_hash: "7".repeat(64) })).not.toEqual(responseTranscript(response));
    expect(responseTranscript({ ...response, message_id: "8".repeat(32) })).not.toEqual(responseTranscript(response));
    expect(responseTranscript({ ...response, delivery_mode: "durable" })).not.toEqual(responseTranscript(response));
    expect(responseTranscript({
      ...response,
      outcome: { kind: "failure", code: "task_unknown", offered: ["review", "ask"] },
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

  it("accepts the 72-hour mailbox validity boundary and rejects anything longer", () => {
    expect(E2EERequestPayload.parse({
      ...request, delivery_mode: "durable", issued_at: 1_000, expires_at: 1_000 + MAILBOX_TTL_MS,
    }).expires_at).toBe(1_000 + MAILBOX_TTL_MS);
    expect(() => E2EERequestPayload.parse({
      ...request, delivery_mode: "durable", issued_at: 1_000, expires_at: 1_001 + MAILBOX_TTL_MS,
    })).toThrow(/validity/);
    expect(() => E2EERequestPayload.parse({
      ...request, issued_at: 1_000, expires_at: 1_000 + 360_001,
    })).toThrow(/validity/);
  });

  it("rejects unpaired surrogates before TextEncoder can collapse distinct signed values", async () => {
    expect(() => E2EERequestPayload.parse({ ...request, message: "\ud800" })).toThrow(/well-formed Unicode/);
    expect(E2EERequestPayload.parse({ ...request, message: "😀" }).message).toBe("😀");

    const responseBase = {
      v: 1 as const, direction: "response" as const, relay_origin: request.relay_origin,
      from: request.to, to: request.from, request_id: request.request_id,
      message_id: request.message_id,
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
