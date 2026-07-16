import { describe, expect, it } from "vitest";
import { closed, nextFrame, openWs, registerHandle, wsAuth } from "./helpers.js";

async function setupPair() {
  const kenToken = await registerHandle("ken");
  const bobToken = await registerHandle("bob");
  const listener = await openWs("/v1/ws?role=listen", wsAuth("ken", kenToken));
  const caller = await openWs("/v1/ws?role=call&to=ken", wsAuth("bob", bobToken));
  return { listener, caller };
}

describe("task/offered passthrough", () => {
  it("forwards call_request.task to the listener and echoes call_result.task in call_reply", async () => {
    const { listener, caller } = await setupPair();
    caller.send(JSON.stringify({ type: "call_request", to: "ken", message: "next tue?", task: "schedule-meeting" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({ type: "incoming_call", task: "schedule-meeting" });
    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "booked", task: "schedule-meeting" }));
    const reply = await nextFrame(caller);
    expect(reply).toMatchObject({ type: "call_reply", text: "booked", task: "schedule-meeting" });
  });

  it("forwards call_failed.offered to the caller as call_error.offered", async () => {
    const { listener, caller } = await setupPair();
    caller.send(JSON.stringify({ type: "call_request", to: "ken", message: "hi", task: "deploy-prod" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({
      type: "call_failed", call_id: incoming.call_id, code: "task_not_offered", offered: ["ask", "owner-introduction"],
    }));
    const err = await nextFrame(caller);
    expect(err).toMatchObject({ type: "call_error", code: "task_not_offered", offered: ["ask", "owner-introduction"] });
    await closed(caller);
  });
});
