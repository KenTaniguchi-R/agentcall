import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { A2AListTasksResponse, A2ATask } from "@benree/agentcall-shared";
import { nextFrame, openWs, registerHandle, wsAuth as baseWsAuth } from "./helpers.js";

const ORIGIN = "https://relay.test";

function wsAuth(handle: string, token: string, org = "acme"): Record<string, string> {
  return {
    ...baseWsAuth(handle, token, org),
    "cf-connecting-ip": `task-${org}-${handle}`,
  };
}

async function setupPair(callee: string, caller: string) {
  const calleeToken = await registerHandle(callee);
  const callerToken = await registerHandle(caller);
  const listener = await openWs("/v1/ws?role=listen", wsAuth(callee, calleeToken));
  return { calleeToken, callerToken, listener };
}

async function startCall(
  callee: string,
  caller: string,
  callerToken: string,
  listener: WebSocket,
  contextId?: string,
) {
  const socket = await openWs(`/v1/ws?role=call&to=${callee}`, wsAuth(caller, callerToken));
  socket.send(JSON.stringify({
    type: "call_request",
    to: callee,
    message: `question from ${caller}`,
    ...(contextId ? { context_id: contextId } : {}),
  }));
  const ringing = await nextFrame(socket);
  const incoming = await nextFrame(listener);
  expect(incoming.call_id).toBe(ringing.call_id);
  return { socket, callId: ringing.call_id as string };
}

function taskUrl(callee: string, suffix = "tasks") {
  return `${ORIGIN}/v1/a2a/${callee}/${suffix}`;
}

describe("A2A task store", () => {
  it("keeps a disconnected caller's task retrievable through completion", async () => {
    const { callerToken, listener } = await setupPair("task-callee", "task-caller");
    const { socket, callId } = await startCall("task-callee", "task-caller", callerToken, listener);
    socket.close(1000, "network dropped");

    const submitted = await SELF.fetch(taskUrl("task-callee", `tasks/${callId}`), {
      headers: wsAuth("task-caller", callerToken),
    });
    expect(submitted.status).toBe(200);
    expect(A2ATask.parse(await submitted.json())).toMatchObject({
      id: callId,
      status: { state: "TASK_STATE_SUBMITTED" },
    });

    listener.send(JSON.stringify({ type: "call_started", call_id: callId }));
    await vi.waitFor(async () => {
      const response = await SELF.fetch(taskUrl("task-callee", `tasks/${callId}`), {
        headers: wsAuth("task-caller", callerToken),
      });
      expect((await response.json<any>()).status.state).toBe("TASK_STATE_WORKING");
    });
    listener.send(JSON.stringify({ type: "call_result", call_id: callId, text: "finished after disconnect" }));

    await vi.waitFor(async () => {
      const response = await SELF.fetch(taskUrl("task-callee", `tasks/${callId}`), {
        headers: wsAuth("task-caller", callerToken),
      });
      expect(response.status).toBe(200);
      expect(await response.json<any>()).toMatchObject({
        id: callId,
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ parts: [{ text: "finished after disconnect" }] }],
      });
    });
  });

  it("makes another caller's task byte-for-byte indistinguishable from a missing task", async () => {
    const { callerToken, listener } = await setupPair("private-callee", "owner-caller");
    const intruderToken = await registerHandle("intruder-caller");
    const { callId } = await startCall("private-callee", "owner-caller", callerToken, listener);

    const foreign = await SELF.fetch(taskUrl("private-callee", `tasks/${callId}`), {
      headers: wsAuth("intruder-caller", intruderToken),
    });
    const missing = await SELF.fetch(taskUrl("private-callee", "tasks/00000000-0000-4000-8000-000000000000"), {
      headers: wsAuth("intruder-caller", intruderToken),
    });

    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toBe("application/a2a+json");
    expect(await foreign.text()).toBe(await missing.text());

    const cancel = (id: string) => SELF.fetch(taskUrl("private-callee", `tasks/${id}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("intruder-caller", intruderToken) },
      body: "{}",
    });
    const foreignCancel = await cancel(callId);
    const missingCancel = await cancel("00000000-0000-4000-8000-000000000000");
    expect(foreignCancel.status).toBe(404);
    expect(await foreignCancel.text()).toBe(await missingCancel.text());
  });

  it("lists only the authenticated originator's tasks with cursor pagination", async () => {
    const calleeToken = await registerHandle("list-callee");
    const firstToken = await registerHandle("list-first");
    const secondToken = await registerHandle("list-second");
    const listener = await openWs("/v1/ws?role=listen", wsAuth("list-callee", calleeToken));
    const contextId = "ctx_AAAAAAAAAAAAAAAAAAAAAA";

    const first = await startCall("list-callee", "list-first", firstToken, listener, contextId);
    const second = await startCall("list-callee", "list-first", firstToken, listener, contextId);
    await startCall("list-callee", "list-second", secondToken, listener);

    const page1 = await SELF.fetch(taskUrl("list-callee", `tasks?contextId=${contextId}&pageSize=1`), {
      headers: wsAuth("list-first", firstToken),
    });
    expect(page1.status).toBe(200);
    const body1 = A2AListTasksResponse.parse(await page1.json());
    expect(body1.tasks).toHaveLength(1);
    expect(body1.totalSize).toBe(2);
    expect(body1.pageSize).toBe(1);
    expect(body1.nextPageToken).toEqual(expect.any(String));
    expect(body1.nextPageToken).not.toBe("");

    const page2 = await SELF.fetch(taskUrl(
      "list-callee",
      `tasks?contextId=${contextId}&pageSize=1&pageToken=${encodeURIComponent(body1.nextPageToken)}`,
    ), { headers: wsAuth("list-first", firstToken) });
    const body2 = A2AListTasksResponse.parse(await page2.json());
    expect(body2.tasks).toHaveLength(1);
    expect(body2.nextPageToken).toBe("");
    expect(new Set([body1.tasks[0].id, body2.tasks[0].id])).toEqual(new Set([first.callId, second.callId]));

    const replayedWithDifferentFilter = await SELF.fetch(taskUrl(
      "list-callee",
      `tasks?pageSize=1&pageToken=${encodeURIComponent(body1.nextPageToken)}`,
    ), { headers: wsAuth("list-first", firstToken) });
    expect(replayedWithDifferentFilter.status).toBe(400);

    const [cursorPayload, cursorSignature] = body1.nextPageToken.split(".") as [string, string];
    const forged = `${cursorPayload}.${cursorSignature.startsWith("A") ? "B" : "A"}${cursorSignature.slice(1)}`;
    const forgedResponse = await SELF.fetch(taskUrl(
      "list-callee",
      `tasks?contextId=${contextId}&pageSize=1&pageToken=${encodeURIComponent(forged)}`,
    ), { headers: wsAuth("list-first", firstToken) });
    expect(forgedResponse.status).toBe(400);

    const crossCallerReplay = await SELF.fetch(taskUrl(
      "list-callee",
      `tasks?contextId=${contextId}&pageSize=1&pageToken=${encodeURIComponent(body1.nextPageToken)}`,
    ), { headers: wsAuth("list-second", secondToken) });
    expect(crossCallerReplay.status).toBe(400);

    const otherCalleeToken = await registerHandle("list-other-callee");
    await openWs("/v1/ws?role=listen", wsAuth("list-other-callee", otherCalleeToken));
    const crossCalleeReplay = await SELF.fetch(taskUrl(
      "list-other-callee",
      `tasks?contextId=${contextId}&pageSize=1&pageToken=${encodeURIComponent(body1.nextPageToken)}`,
    ), { headers: wsAuth("list-first", firstToken) });
    expect(crossCalleeReplay.status).toBe(400);

    const other = await SELF.fetch(taskUrl("list-callee"), {
      headers: wsAuth("list-second", secondToken),
    });
    expect((await other.json<any>()).tasks).toHaveLength(1);
  });

  it("filters by state and timestamp and omits artifacts from lists by default", async () => {
    const { callerToken, listener } = await setupPair("filter-callee", "filter-caller");
    const { callId } = await startCall("filter-callee", "filter-caller", callerToken, listener);
    listener.send(JSON.stringify({ type: "call_result", call_id: callId, text: "list result" }));

    await vi.waitFor(async () => {
      const response = await SELF.fetch(taskUrl(
        "filter-callee", "tasks?status=TASK_STATE_COMPLETED&statusTimestampAfter=2020-01-01T00%3A00%3A00Z",
      ), { headers: wsAuth("filter-caller", callerToken) });
      const body = A2AListTasksResponse.parse(await response.json());
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]).not.toHaveProperty("artifacts");
    });

    const withArtifacts = await SELF.fetch(taskUrl(
      "filter-callee", "tasks?status=TASK_STATE_COMPLETED&includeArtifacts=true",
    ), { headers: wsAuth("filter-caller", callerToken) });
    const completedBody = await withArtifacts.json<any>();
    expect(completedBody.tasks[0].artifacts[0].parts[0].text).toBe("list result");

    const timestamp = completedBody.tasks[0].status.timestamp as string;
    const oneNanosecondAfter = timestamp.replace(/(\.\d{3})Z$/, "$1000001Z");
    const subMillisecondBoundary = await SELF.fetch(taskUrl(
      "filter-callee",
      `tasks?statusTimestampAfter=${encodeURIComponent(oneNanosecondAfter)}`,
    ), { headers: wsAuth("filter-caller", callerToken) });
    expect((await subMillisecondBoundary.json<any>()).tasks).toEqual([]);

    const future = await SELF.fetch(taskUrl(
      "filter-callee", "tasks?statusTimestampAfter=2999-01-01T00%3A00%3A00Z",
    ), { headers: wsAuth("filter-caller", callerToken) });
    expect((await future.json<any>()).tasks).toEqual([]);
  });

  it("projects failures and refuses to overwrite terminal state with a duplicate frame", async () => {
    const { callerToken, listener } = await setupPair("terminal-callee", "terminal-caller");
    const completed = await startCall("terminal-callee", "terminal-caller", callerToken, listener);
    listener.send(JSON.stringify({ type: "call_result", call_id: completed.callId, text: "winner" }));
    listener.send(JSON.stringify({ type: "call_failed", call_id: completed.callId, code: "agent_error" }));

    await vi.waitFor(async () => {
      const response = await SELF.fetch(taskUrl("terminal-callee", `tasks/${completed.callId}`), {
        headers: wsAuth("terminal-caller", callerToken),
      });
      expect(await response.json<any>()).toMatchObject({
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ parts: [{ text: "winner" }] }],
      });
    });

    const failed = await startCall("terminal-callee", "terminal-caller", callerToken, listener);
    listener.send(JSON.stringify({ type: "call_failed", call_id: failed.callId, code: "agent_error" }));
    await vi.waitFor(async () => {
      const response = await SELF.fetch(taskUrl("terminal-callee", `tasks/${failed.callId}`), {
        headers: wsAuth("terminal-caller", callerToken),
      });
      expect((await response.json<any>()).status.state).toBe("TASK_STATE_FAILED");
    });
  });

  it("validates task query parameters, auth, versions, and cancel content type", async () => {
    const { callerToken, listener } = await setupPair("valid-callee", "valid-caller");
    const { callId } = await startCall("valid-callee", "valid-caller", callerToken, listener);
    const headers = wsAuth("valid-caller", callerToken);

    expect((await SELF.fetch(taskUrl("valid-callee"))).status).toBe(401);
    expect((await SELF.fetch(taskUrl("valid-callee", `tasks/${callId}?historyLength=-1`), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?pageSize=101"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?status=NOT_A_STATE"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?statusTimestampAfter=yesterday"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?statusTimestampAfter=2021-02-29T00%3A00%3A00Z"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?statusTimestampAfter=2020-01-01T00%3A00%3A00"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?pageToken=not-valid-%25"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", `tasks?pageToken=${"A".repeat(1025)}`), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?includeArtifacts=yes"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?pageSize=1.5"), { headers })).status).toBe(400);
    expect((await SELF.fetch(taskUrl("valid-callee", `tasks/${callId}:cancel`), { headers })).status).toBe(404);
    expect((await SELF.fetch(taskUrl("valid-callee", `tasks/${callId}:unknown`), {
      method: "POST", headers: { ...headers, "content-type": "application/a2a+json" }, body: "{}",
    })).status).toBe(404);

    const oldVersion = await SELF.fetch(taskUrl("valid-callee"), {
      headers: { ...headers, "A2A-Version": "0.3" },
    });
    expect(oldVersion.status).toBe(400);
    expect((await oldVersion.json<any>()).error.details[0].reason).toBe("VERSION_NOT_SUPPORTED");
    expect((await SELF.fetch(taskUrl("valid-callee", "tasks?A2A-Version=1.0"), { headers })).status).toBe(200);

    const wrongType = await SELF.fetch(taskUrl("valid-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    expect((await wrongType.json<any>()).error.details[0].reason).toBe("CONTENT_TYPE_NOT_SUPPORTED");

    for (const contentType of [undefined, "application/a2a+jsonjunk"]) {
      const response = await SELF.fetch(taskUrl("valid-callee", `tasks/${callId}:cancel`), {
        method: "POST",
        headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
        body: "{}",
      });
      expect(response.status).toBe(415);
    }

    for (const body of [{ metadata: "not-an-object" }, { unexpected: true }]) {
      const response = await SELF.fetch(taskUrl("valid-callee", `tasks/${callId}:cancel`), {
        method: "POST",
        headers: { ...headers, "content-type": "application/a2a+json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it("cancels through the listener and retains the confirmed terminal task", async () => {
    const { callerToken, listener } = await setupPair("cancel-task-callee", "cancel-task-caller");
    const { socket, callId } = await startCall(
      "cancel-task-callee", "cancel-task-caller", callerToken, listener,
    );
    socket.close(1000, "caller will cancel over HTTP");

    const responsePromise = SELF.fetch(taskUrl("cancel-task-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("cancel-task-caller", callerToken) },
      body: "{}",
    });
    expect(await nextFrame(listener)).toEqual({ type: "cancel_call", call_id: callId });
    listener.send(JSON.stringify({ type: "call_cancelled", call_id: callId, phase: "running" }));

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      id: callId,
      status: { state: "TASK_STATE_CANCELED" },
    });

    const again = await SELF.fetch(taskUrl("cancel-task-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("cancel-task-caller", callerToken) },
      body: "{}",
    });
    expect(again.status).toBe(409);
    expect((await again.json<any>()).error.details[0].reason).toBe("TASK_NOT_CANCELABLE");
  });

  it("returns TaskNotCancelable when the listener refuses and leaves the task live", async () => {
    const { callerToken, listener } = await setupPair("refuse-callee", "refuse-caller");
    const { callId } = await startCall("refuse-callee", "refuse-caller", callerToken, listener);

    const responsePromise = SELF.fetch(taskUrl("refuse-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("refuse-caller", callerToken) },
      body: "{}",
    });
    expect(await nextFrame(listener)).toEqual({ type: "cancel_call", call_id: callId });
    listener.send(JSON.stringify({ type: "call_not_cancelled", call_id: callId, reason: "too_late" }));
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect((await response.json<any>()).error.details[0].reason).toBe("TASK_NOT_CANCELABLE");

    listener.send(JSON.stringify({ type: "call_result", call_id: callId, text: "completion won" }));
    await vi.waitFor(async () => {
      const task = await SELF.fetch(taskUrl("refuse-callee", `tasks/${callId}`), {
        headers: wsAuth("refuse-caller", callerToken),
      });
      expect((await task.json<any>()).status.state).toBe("TASK_STATE_COMPLETED");
    });
  });

  it("expires the retained task at the original call deadline", async () => {
    const { callerToken, listener } = await setupPair("expiry-callee", "expiry-caller");
    const socket = await openWs(
      "/v1/ws?role=call&to=expiry-callee&test_timeout_ms=100",
      wsAuth("expiry-caller", callerToken),
    );
    socket.send(JSON.stringify({
      type: "call_request", to: "expiry-callee", message: "expire this task",
    }));
    const ringing = await nextFrame(socket);
    await nextFrame(listener);
    expect(await nextFrame(socket, 10_000)).toMatchObject({ type: "call_error", code: "timeout" });

    await vi.waitFor(async () => {
      const response = await SELF.fetch(taskUrl("expiry-callee", `tasks/${ringing.call_id}`), {
        headers: wsAuth("expiry-caller", callerToken),
      });
      expect(response.status).toBe(404);
    });
  });

  it("keeps accepted tasks submitted and expires a completed short-lived record", async () => {
    const { callerToken, listener } = await setupPair("accepted-callee", "accepted-caller");
    const socket = await openWs(
      "/v1/ws?role=call&to=accepted-callee&test_timeout_ms=500",
      wsAuth("accepted-caller", callerToken),
    );
    socket.send(JSON.stringify({ type: "call_request", to: "accepted-callee", message: "accept me" }));
    const ringing = await nextFrame(socket);
    await nextFrame(listener);
    listener.send(JSON.stringify({ type: "call_accepted", call_id: ringing.call_id }));
    await nextFrame(socket);

    const accepted = await SELF.fetch(taskUrl("accepted-callee", `tasks/${ringing.call_id}`), {
      headers: wsAuth("accepted-caller", callerToken),
    });
    expect((await accepted.json<any>()).status.state).toBe("TASK_STATE_SUBMITTED");

    listener.send(JSON.stringify({ type: "call_result", call_id: ringing.call_id, text: "short result" }));
    await nextFrame(socket);
    await vi.waitFor(async () => {
      const expired = await SELF.fetch(taskUrl("accepted-callee", `tasks/${ringing.call_id}`), {
        headers: wsAuth("accepted-caller", callerToken),
      });
      expect(expired.status).toBe(404);
    });
  });

  it("rejects cancellation when the listener disconnects", async () => {
    const { calleeToken, callerToken, listener } = await setupPair("gone-callee", "gone-caller");
    const { callId } = await startCall("gone-callee", "gone-caller", callerToken, listener);
    listener.close(1000, "gone");
    await vi.waitFor(async () => {
      const status = await SELF.fetch(`${ORIGIN}/v1/status/gone-callee`, {
        headers: wsAuth("gone-callee", calleeToken),
      });
      expect(await status.json<any>()).toMatchObject({ online: false });
    });

    const response = await SELF.fetch(taskUrl("gone-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("gone-caller", callerToken) },
      body: "{}",
    });
    expect(response.status).toBe(409);
  });

  it("bounds an unacknowledged cancellation by the original deadline", async () => {
    const { callerToken, listener } = await setupPair("no-ack-callee", "no-ack-caller");
    const socket = await openWs(
      "/v1/ws?role=call&to=no-ack-callee&test_timeout_ms=250",
      wsAuth("no-ack-caller", callerToken),
    );
    socket.send(JSON.stringify({ type: "call_request", to: "no-ack-callee", message: "cancel without ack" }));
    const ringing = await nextFrame(socket);
    await nextFrame(listener);

    const cancel = SELF.fetch(taskUrl("no-ack-callee", `tasks/${ringing.call_id}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("no-ack-caller", callerToken) },
      body: "{}",
    });
    expect(await nextFrame(listener)).toEqual({ type: "cancel_call", call_id: ringing.call_id });
    expect((await cancel).status).toBe(409);
    expect(await nextFrame(socket, 10_000)).toMatchObject({ type: "call_error", code: "timeout" });
  });

  it("isolates identical caller and callee handles across organizations", async () => {
    const callee = "cross-org-callee";
    const caller = "cross-org-caller";
    const alphaCalleeToken = await registerHandle(callee, "claude", "alpha-org");
    const alphaCallerToken = await registerHandle(caller, "claude", "alpha-org");
    await registerHandle(callee, "claude", "beta-org");
    const betaCallerToken = await registerHandle(caller, "claude", "beta-org");
    const listener = await openWs("/v1/ws?role=listen", wsAuth(callee, alphaCalleeToken, "alpha-org"));
    const socket = await openWs(
      `/v1/ws?role=call&to=${callee}`,
      wsAuth(caller, alphaCallerToken, "alpha-org"),
    );
    socket.send(JSON.stringify({ type: "call_request", to: callee, message: "alpha only" }));
    const ringing = await nextFrame(socket);
    await nextFrame(listener);

    const alpha = await SELF.fetch(taskUrl(callee, `tasks/${ringing.call_id}`), {
      headers: wsAuth(caller, alphaCallerToken, "alpha-org"),
    });
    const beta = await SELF.fetch(taskUrl(callee, `tasks/${ringing.call_id}`), {
      headers: wsAuth(caller, betaCallerToken, "beta-org"),
    });
    expect(alpha.status).toBe(200);
    expect(beta.status).toBe(404);
  });

  it("coalesces concurrent cancellation requests and sends one listener command", async () => {
    const { callerToken, listener } = await setupPair("concurrent-callee", "concurrent-caller");
    const { callId } = await startCall("concurrent-callee", "concurrent-caller", callerToken, listener);
    const cancel = () => SELF.fetch(taskUrl("concurrent-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("concurrent-caller", callerToken) },
      body: "{}",
    });

    const first = cancel();
    const second = cancel();
    expect(await nextFrame(listener)).toEqual({ type: "cancel_call", call_id: callId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener.send(JSON.stringify({ type: "call_cancelled", call_id: callId, phase: "running" }));
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  it("lets completion win a race with an in-flight cancellation", async () => {
    const { callerToken, listener } = await setupPair("race-callee", "race-caller");
    const { callId } = await startCall("race-callee", "race-caller", callerToken, listener);
    const cancel = SELF.fetch(taskUrl("race-callee", `tasks/${callId}:cancel`), {
      method: "POST",
      headers: { "content-type": "application/a2a+json", ...wsAuth("race-caller", callerToken) },
      body: "{}",
    });
    expect(await nextFrame(listener)).toEqual({ type: "cancel_call", call_id: callId });
    listener.send(JSON.stringify({ type: "call_result", call_id: callId, text: "completed first" }));
    expect((await cancel).status).toBe(409);

    const task = await SELF.fetch(taskUrl("race-callee", `tasks/${callId}`), {
      headers: wsAuth("race-caller", callerToken),
    });
    expect(await task.json<any>()).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "completed first" }] }],
    });
  });
});
