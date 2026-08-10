import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keyIdFor, requestTranscript, transcriptHash, type A2ATaskType, type E2EERequestPayloadType, type E2EEResponsePayloadType } from "@benree/agentcall-shared";
import { getPaths } from "../src/paths.js";
import { generateIdentityKeys } from "../src/keys.js";
import { sealE2EERequest, sealE2EEResponse } from "../src/e2ee.js";
import { rememberOutboundJob, acknowledgeOutboundJob } from "../src/outbound-jobs.js";
import { decryptJobOutcome } from "../src/job-result.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable job result", () => {
  it("authenticates and decrypts the raw HPKE artifact using the saved outbox binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentcall-job-result-"));
    roots.push(root);
    const paths = getPaths(join(root, "caller"), root);
    const caller = await generateIdentityKeys(paths);
    const callee = await generateIdentityKeys(getPaths(join(root, "callee"), root));
    const now = Date.now();
    const request: E2EERequestPayloadType = {
      v: 1, direction: "request", delivery_mode: "durable", relay_origin: "relay.test",
      from: "@acme/alice", to: "@acme/bob", message_id: "1".repeat(32), request_id: "2".repeat(32),
      sender_identity_key_id: await keyIdFor(caller.identity_pub),
      recipient_encryption_key_id: await keyIdFor(callee.encryption_pub), recipient_epoch: callee.epoch,
      issued_at: now, expires_at: now + 72 * 60 * 60 * 1_000, message: "hello",
    };
    const frame = {
      type: "call_request" as const, delivery_mode: "durable" as const, message_id: request.message_id,
      correlation_id: "3".repeat(32),
      envelope: await sealE2EERequest(request, caller, {
        pub: callee.encryption_pub, key_id: request.recipient_encryption_key_id, epoch: callee.epoch,
      }),
    };
    const hash = await transcriptHash(requestTranscript(request));
    await rememberOutboundJob(paths, {
      message_id: request.message_id, relay: "https://relay.test", address: "@acme/bob", frame,
      request_id: request.request_id, request_transcript_hash: hash,
      recipient_identity_pub: callee.identity_pub, sender_epoch: caller.epoch,
      created_at: now, expires_at: request.expires_at,
    });
    await acknowledgeOutboundJob(paths, request.message_id, {
      task_id: "task-1", submitted_at: now, expires_at: request.expires_at,
    });
    const response: E2EEResponsePayloadType = {
      v: 1, direction: "response", delivery_mode: "durable", relay_origin: request.relay_origin,
      from: request.to, to: request.from, message_id: request.message_id, request_id: request.request_id,
      sender_identity_key_id: await keyIdFor(callee.identity_pub),
      recipient_encryption_key_id: await keyIdFor(caller.encryption_pub), recipient_epoch: caller.epoch,
      issued_at: now + 1, expires_at: request.expires_at, request_transcript_hash: hash,
      outcome: { kind: "reply", text: "secret result" },
    };
    const envelope = await sealE2EEResponse(response, callee, {
      pub: caller.encryption_pub, key_id: response.recipient_encryption_key_id, epoch: caller.epoch,
    });
    const task: A2ATaskType = {
      id: "task-1", status: { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() },
      metadata: { "agentcall.dev/terminalReason": "completed" },
      artifacts: [{ artifactId: "result", parts: [{
        raw: Buffer.from(JSON.stringify(envelope)).toString("base64"),
        mediaType: "application/vnd.agentcall.hpke+json",
      }] }],
    };
    await expect(decryptJobOutcome(paths, "@acme/bob", task)).resolves.toEqual(response.outcome);
  });
});
