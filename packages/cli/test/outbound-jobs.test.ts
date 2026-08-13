import { describe, expect, it } from "vitest";
import {
  acknowledgeOutboundJob, findOutboundJob, forgetOutboundJob, loadOutboundJobs, rememberOutboundJob,
} from "../src/outbound-jobs.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

const frame = {
  type: "call_request" as const,
  message_id: "9".repeat(32),
  delivery_mode: "durable" as const,
  correlation_id: "8".repeat(32),
  envelope: {
    v: 1 as const, direction: "request" as const, relay_origin: "relay.test",
    from: "@acme/alice", to: "@acme/bob", key_id: "7".repeat(32), epoch: 2,
    enc: "A", ct: "B",
  },
};

describe("outbound durable jobs", () => {
  it("persists the exact sealed frame before send and binds the later task receipt", async () => {
    const root = tempDir("agentcall-outbound-jobs-");
    const paths = getPaths(root, root);
    await rememberOutboundJob(paths, {
      message_id: frame.message_id,
      relay: "https://relay.test",
      address: "@acme/bob",
      frame,
      request_id: "6".repeat(32),
      request_transcript_hash: "5".repeat(64),
      recipient_identity_pub: "identity-public-key",
      sender_epoch: 2,
      created_at: 1_000,
      expires_at: 2_000,
    });
    expect(loadOutboundJobs(paths)[0]?.frame).toEqual(frame);

    await acknowledgeOutboundJob(paths, frame.message_id, {
      task_id: "task-1", submitted_at: 1_000, expires_at: 2_000,
    });
    expect(findOutboundJob(paths, "@acme/bob", "task-1")).toMatchObject({
      message_id: frame.message_id, task_id: "task-1", state: "queued",
    });
  });

  it("removes a durable-capable submission that completed synchronously", async () => {
    const root = tempDir("agentcall-outbound-jobs-complete-");
    const paths = getPaths(root, root);
    await rememberOutboundJob(paths, {
      message_id: frame.message_id, relay: "https://relay.test", address: "@acme/bob", frame,
      request_id: "6".repeat(32), request_transcript_hash: "5".repeat(64),
      recipient_identity_pub: "identity-public-key", sender_epoch: 2,
      created_at: 1_000, expires_at: 2_000,
    });
    await forgetOutboundJob(paths, frame.message_id);
    expect(loadOutboundJobs(paths)).toEqual([]);
  });
});
