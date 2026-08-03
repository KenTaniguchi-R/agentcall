import { describe, expect, it } from "vitest";
import {
  encryptedCallOutcome, encryptedCallRequest, nextFrame, openWs, registerHandle, wsAuth,
} from "./helpers.js";

async function setupPair(callee: string, callerHandle: string) {
  const calleeToken = await registerHandle(callee);
  const callerToken = await registerHandle(callerHandle);
  const listener = await openWs("/v1/ws?role=listen", wsAuth(callee, calleeToken));
  const caller = await openWs(`/v1/ws?role=call&to=${callee}`, wsAuth(callerHandle, callerToken));
  return { listener, caller, callee, callerHandle };
}

describe("encrypted content routing", () => {
  it("forwards only a request envelope, never task/message/context fields", async () => {
    const { listener, caller, callee, callerHandle } = await setupPair("task-echo-callee", "task-echo-caller");
    caller.send(JSON.stringify(encryptedCallRequest(callerHandle, callee)));
    await nextFrame(caller);
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({ type: "incoming_call", from: callerHandle, envelope: { direction: "request" } });
    expect(incoming).not.toHaveProperty("message");
    expect(incoming).not.toHaveProperty("task");
    expect(incoming).not.toHaveProperty("context_id");

    const outcome = encryptedCallOutcome(incoming.call_id, callee, callerHandle);
    listener.send(JSON.stringify(outcome));
    expect(await nextFrame(caller)).toEqual(outcome);
  });

  it("forwards peer failures as opaque outcomes, never detail/offered fields", async () => {
    const { listener, caller, callee, callerHandle } = await setupPair("task-fail-callee", "task-fail-caller");
    caller.send(JSON.stringify(encryptedCallRequest(callerHandle, callee)));
    await nextFrame(caller);
    const incoming = await nextFrame(listener);
    const outcome = encryptedCallOutcome(incoming.call_id, callee, callerHandle, "failed");
    listener.send(JSON.stringify(outcome));
    const relayed = await nextFrame(caller);
    expect(relayed).toEqual(outcome);
    expect(relayed).not.toHaveProperty("detail");
    expect(relayed).not.toHaveProperty("offered");
  });
});
