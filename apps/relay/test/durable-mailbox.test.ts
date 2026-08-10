import { SELF } from "cloudflare:test";
import { A2AListTasksResponse, A2ATask, E2EERelayToCallerFrame } from "@benree/agentcall-shared";
import { describe, expect, it } from "vitest";
import {
  encryptedCallOutcome, encryptedCallRequest, nextFrame, openWs, registerHandle, wsAuth,
} from "./helpers.js";

const ORIGIN = "https://relay.test";

async function enableMailbox(handle: string, token: string): Promise<void> {
  const response = await SELF.fetch(`${ORIGIN}/v1/card`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...wsAuth(handle, token) },
    body: JSON.stringify({
      description: "durable callee", agent_kind: "claude", tasks: [], blocked: [],
      offline_delivery: { enabled: true },
    }),
  });
  expect(response.status).toBe(200);
}

describe("durable mailbox", () => {
  it("accepts encrypted work while offline and exposes the submitted task", async () => {
    const calleeToken = await registerHandle("mailbox-callee");
    const callerToken = await registerHandle("mailbox-caller");
    await enableMailbox("mailbox-callee", calleeToken);

    const socket = await openWs(
      "/v1/ws?role=call&to=mailbox-callee",
      wsAuth("mailbox-caller", callerToken),
    );
    const messageId = "9".repeat(32);
    socket.send(JSON.stringify(encryptedCallRequest("mailbox-caller", "mailbox-callee", {
      message_id: messageId,
      delivery_mode: "durable",
    })));

    const receipt = E2EERelayToCallerFrame.parse(await nextFrame(socket));
    expect(receipt).toMatchObject({
      type: "call_queued", message_id: messageId, correlation_id: "f".repeat(32),
    });
    if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");

    const taskResponse = await SELF.fetch(
      `${ORIGIN}/v1/a2a/mailbox-callee/tasks/${receipt.call_id}`,
      { headers: wsAuth("mailbox-caller", callerToken) },
    );
    expect(taskResponse.status).toBe(200);
    expect(A2ATask.parse(await taskResponse.json())).toMatchObject({
      id: receipt.call_id,
      status: { state: "TASK_STATE_SUBMITTED" },
    });
  });

  it("returns the original receipt for an identical client retry", async () => {
    const calleeToken = await registerHandle("dedupe-callee");
    const callerToken = await registerHandle("dedupe-caller");
    await enableMailbox("dedupe-callee", calleeToken);
    const messageId = "8".repeat(32);

    const submit = async () => {
      const socket = await openWs(
        "/v1/ws?role=call&to=dedupe-callee",
        wsAuth("dedupe-caller", callerToken),
      );
      socket.send(JSON.stringify(encryptedCallRequest("dedupe-caller", "dedupe-callee", {
        message_id: messageId, delivery_mode: "durable",
      })));
      const receipt = E2EERelayToCallerFrame.parse(await nextFrame(socket));
      if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");
      return receipt;
    };

    const first = await submit();
    const retry = await submit();
    expect(retry.call_id).toBe(first.call_id);
    expect(retry.submitted_at).toBe(first.submitted_at);

    const listResponse = await SELF.fetch(
      `${ORIGIN}/v1/a2a/dedupe-callee/tasks`,
      { headers: wsAuth("dedupe-caller", callerToken) },
    );
    expect(A2AListTasksResponse.parse(await listResponse.json()).totalSize).toBe(1);
  });

  it("cancels queued work without requiring a listener", async () => {
    const calleeToken = await registerHandle("cancel-callee");
    const callerToken = await registerHandle("cancel-caller");
    await enableMailbox("cancel-callee", calleeToken);
    const caller = await openWs(
      "/v1/ws?role=call&to=cancel-callee", wsAuth("cancel-caller", callerToken),
    );
    caller.send(JSON.stringify(encryptedCallRequest("cancel-caller", "cancel-callee", {
      message_id: "5".repeat(32), delivery_mode: "durable",
    })));
    const receipt = E2EERelayToCallerFrame.parse(await nextFrame(caller));
    if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");

    const response = await SELF.fetch(
      `${ORIGIN}/v1/a2a/cancel-callee/tasks/${receipt.call_id}:cancel`,
      { method: "POST", headers: { ...wsAuth("cancel-caller", callerToken), "content-type": "application/a2a+json" }, body: "{}" },
    );
    expect(response.status).toBe(200);
    expect(A2ATask.parse(await response.json())).toMatchObject({
      status: { state: "TASK_STATE_CANCELED" },
      metadata: { "agentcall.dev/terminalReason": "canceled" },
    });
  });

  it("expires queued ciphertext into a visible tombstone", async () => {
    const calleeToken = await registerHandle("expire-callee");
    const callerToken = await registerHandle("expire-caller");
    await enableMailbox("expire-callee", calleeToken);
    const caller = await openWs(
      "/v1/ws?role=call&to=expire-callee&test_timeout_ms=20", wsAuth("expire-caller", callerToken),
    );
    caller.send(JSON.stringify(encryptedCallRequest("expire-caller", "expire-callee", {
      message_id: "4".repeat(32), delivery_mode: "durable",
    })));
    const receipt = E2EERelayToCallerFrame.parse(await nextFrame(caller));
    if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");

    await expect.poll(async () => {
      const response = await SELF.fetch(`${ORIGIN}/v1/a2a/expire-callee/tasks/${receipt.call_id}`, {
        headers: wsAuth("expire-caller", callerToken),
      });
      return response.status === 200 ? await response.json() : { status: response.status };
    }).toMatchObject({
      status: { state: "TASK_STATE_FAILED" },
      metadata: { "agentcall.dev/terminalReason": "expired" },
    });
  });

  it("rejects reuse of one message id with different ciphertext", async () => {
    const calleeToken = await registerHandle("conflict-callee");
    const callerToken = await registerHandle("conflict-caller");
    await enableMailbox("conflict-callee", calleeToken);
    const messageId = "7".repeat(32);
    const submit = async (ciphertext: string) => {
      const socket = await openWs(
        "/v1/ws?role=call&to=conflict-callee",
        wsAuth("conflict-caller", callerToken),
      );
      const frame = encryptedCallRequest("conflict-caller", "conflict-callee", {
        message_id: messageId, delivery_mode: "durable",
      });
      frame.envelope.ct = ciphertext;
      socket.send(JSON.stringify(frame));
      return E2EERelayToCallerFrame.parse(await nextFrame(socket));
    };

    expect((await submit("QQ")).type).toBe("call_queued");
    expect(await submit("Qg")).toMatchObject({
      type: "call_error", origin: "relay", code: "protocol_error",
    });
  });

  it("enforces the caller-to-target outstanding boundary atomically", async () => {
    const calleeToken = await registerHandle("quota-callee");
    const callerToken = await registerHandle("quota-caller");
    await enableMailbox("quota-callee", calleeToken);
    const taskIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const socket = await openWs(
        "/v1/ws?role=call&to=quota-callee", wsAuth("quota-caller", callerToken),
      );
      socket.send(JSON.stringify(encryptedCallRequest("quota-caller", "quota-callee", {
        message_id: (index + 1).toString(16).padStart(32, "0"), delivery_mode: "durable",
      })));
      const queued = E2EERelayToCallerFrame.parse(await nextFrame(socket));
      expect(queued.type).toBe("call_queued");
      if (queued.type === "call_queued") taskIds.push(queued.call_id);
    }
    const overflow = await openWs(
      "/v1/ws?role=call&to=quota-callee", wsAuth("quota-caller", callerToken),
    );
    overflow.send(JSON.stringify(encryptedCallRequest("quota-caller", "quota-callee", {
      message_id: "a".repeat(32), delivery_mode: "durable",
    })));
    expect(E2EERelayToCallerFrame.parse(await nextFrame(overflow))).toMatchObject({
      type: "call_error", code: "busy",
    });

    await SELF.fetch(`${ORIGIN}/v1/a2a/quota-callee/tasks/${taskIds[0]}:cancel`, {
      method: "POST",
      headers: { ...wsAuth("quota-caller", callerToken), "content-type": "application/a2a+json" },
      body: "{}",
    });
    const admitted = await openWs(
      "/v1/ws?role=call&to=quota-callee", wsAuth("quota-caller", callerToken),
    );
    admitted.send(JSON.stringify(encryptedCallRequest("quota-caller", "quota-callee", {
      message_id: "b".repeat(32), delivery_mode: "durable",
    })));
    expect(E2EERelayToCallerFrame.parse(await nextFrame(admitted)).type).toBe("call_queued");
  });

  it("leases the oldest queued request to a compatible reconnecting listener", async () => {
    const calleeToken = await registerHandle("drain-callee");
    const callerToken = await registerHandle("drain-caller");
    await enableMailbox("drain-callee", calleeToken);
    const caller = await openWs(
      "/v1/ws?role=call&to=drain-callee",
      wsAuth("drain-caller", callerToken),
    );
    caller.send(JSON.stringify(encryptedCallRequest("drain-caller", "drain-callee", {
      message_id: "6".repeat(32), delivery_mode: "durable",
    })));
    const receipt = E2EERelayToCallerFrame.parse(await nextFrame(caller));
    if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");

    const sessionId = "22222222-2222-4222-8222-222222222222";
    const connectedAt = Date.now();
    const listener = await openWs(
      `/v1/ws?role=listen&capability=durable-mailbox-v1&listener_session_id=${sessionId}`,
      wsAuth("drain-callee", calleeToken),
    );
    const incoming = await nextFrame(listener);
    expect(Date.now() - connectedAt).toBeLessThan(5_000);
    expect(incoming).toMatchObject({
      type: "incoming_call", call_id: receipt.call_id, message_id: "6".repeat(32),
      delivery_mode: "durable", from: "drain-caller",
    });
    expect(incoming.lease_id).toEqual(expect.any(String));

    listener.send(JSON.stringify({
      type: "call_started", call_id: receipt.call_id, lease_id: incoming.lease_id,
    }));
    listener.send(JSON.stringify({
      ...encryptedCallOutcome(receipt.call_id, "drain-callee", "drain-caller"),
      lease_id: incoming.lease_id,
    }));

    await expect.poll(async () => {
      const response = await SELF.fetch(
        `${ORIGIN}/v1/a2a/drain-callee/tasks/${receipt.call_id}`,
        { headers: wsAuth("drain-caller", callerToken) },
      );
      return (await response.json<any>()).status.state;
    }).toBe("TASK_STATE_COMPLETED");

    const resultResponse = await SELF.fetch(
      `${ORIGIN}/v1/a2a/drain-callee/tasks/${receipt.call_id}?includeArtifacts=true`,
      { headers: wsAuth("drain-caller", callerToken) },
    );
    const result = A2ATask.parse(await resultResponse.json());
    expect(result.artifacts?.[0]?.parts[0]).toMatchObject({
      mediaType: "application/vnd.agentcall.hpke+json",
      raw: expect.any(String),
    });
  });

  it("redelivers an unstarted lease and poison-terminates after three attempts", async () => {
    const calleeToken = await registerHandle("retry-callee");
    const callerToken = await registerHandle("retry-caller");
    await enableMailbox("retry-callee", calleeToken);
    const caller = await openWs(
      "/v1/ws?role=call&to=retry-callee", wsAuth("retry-caller", callerToken),
    );
    caller.send(JSON.stringify(encryptedCallRequest("retry-caller", "retry-callee", {
      message_id: "3".repeat(32), delivery_mode: "durable",
    })));
    const receipt = E2EERelayToCallerFrame.parse(await nextFrame(caller));
    if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");

    const leaseIds: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const sessionId = `33333333-3333-4333-8333-${String(attempt).padStart(12, "0")}`;
      const listener = await openWs(
        `/v1/ws?role=listen&capability=durable-mailbox-v1&listener_session_id=${sessionId}&test_timeout_ms=20`,
        wsAuth("retry-callee", calleeToken),
      );
      const incoming = await nextFrame(listener);
      leaseIds.push(incoming.lease_id);
      listener.close();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(new Set(leaseIds).size).toBe(3);
    await expect.poll(async () => {
      const response = await SELF.fetch(`${ORIGIN}/v1/a2a/retry-callee/tasks/${receipt.call_id}`, {
        headers: wsAuth("retry-caller", callerToken),
      });
      return response.json();
    }).toMatchObject({
      status: { state: "TASK_STATE_FAILED" },
      metadata: { "agentcall.dev/terminalReason": "delivery_failed" },
    });
  });

  it("revokes queued work when the owner disables delivery before leasing", async () => {
    const calleeToken = await registerHandle("revoke-callee");
    const callerToken = await registerHandle("revoke-caller");
    await enableMailbox("revoke-callee", calleeToken);
    const caller = await openWs(
      "/v1/ws?role=call&to=revoke-callee", wsAuth("revoke-caller", callerToken),
    );
    caller.send(JSON.stringify(encryptedCallRequest("revoke-caller", "revoke-callee", {
      message_id: "2".repeat(32), delivery_mode: "durable",
    })));
    const receipt = E2EERelayToCallerFrame.parse(await nextFrame(caller));
    if (receipt.type !== "call_queued") throw new Error("expected durable queue receipt");
    const disable = await SELF.fetch(`${ORIGIN}/v1/card`, {
      method: "PUT", headers: { "content-type": "application/json", ...wsAuth("revoke-callee", calleeToken) },
      body: JSON.stringify({
        description: "disabled", agent_kind: "claude", tasks: [], blocked: [],
        offline_delivery: { enabled: false },
      }),
    });
    expect(disable.status).toBe(200);
    await openWs(
      "/v1/ws?role=listen&capability=durable-mailbox-v1&listener_session_id=44444444-4444-4444-8444-444444444444",
      wsAuth("revoke-callee", calleeToken),
    );
    await expect.poll(async () => {
      const response = await SELF.fetch(`${ORIGIN}/v1/a2a/revoke-callee/tasks/${receipt.call_id}`, {
        headers: wsAuth("revoke-caller", callerToken),
      });
      return response.json();
    }).toMatchObject({
      status: { state: "TASK_STATE_REJECTED" },
      metadata: { "agentcall.dev/terminalReason": "revoked" },
    });
  });
});
