import { describe, expect, it } from "vitest";
import { MAX_DETAIL_LENGTH, RELAY_CALL_TIMEOUT_MS, RATE_LIMIT_PER_HOUR } from "@benree/agentcall-shared";
import { registerHandle, wsAuth, openWs, nextFrame, closed } from "./helpers.js";
import { clampTimeoutMs, truncateUtf8Bytes } from "../src/do.js";

async function setupPair(callee: string, caller: string) {
  const calleeToken = await registerHandle(callee);
  const callerToken = await registerHandle(caller);
  const listener = await openWs("/v1/ws?role=listen", wsAuth(callee, calleeToken));
  return { calleeToken, callerToken, listener };
}

describe("call flow", () => {
  it("relays a full happy-path call", async () => {
    const { callerToken, listener } = await setupPair("h-callee", "h-caller");
    const caller = await openWs("/v1/ws?role=call&to=h-callee", wsAuth("h-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "h-callee", message: "what is 2+2?" }));

    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "ringing" });
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({ type: "incoming_call", from: "h-caller", message: "what is 2+2?" });

    listener.send(JSON.stringify({ type: "call_accepted", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "answered" });
    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "working" });

    const ctxId = "ctx_AAAAAAAAAAAAAAAAAAAAAA";
    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "4", context_id: ctxId }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "4", context_id: ctxId });
    expect((await closed(caller)).code).toBe(1000);
  });

  it("keeps accepting the legacy call_answer frame during listener upgrades", async () => {
    const { callerToken, listener } = await setupPair("legacy-callee", "legacy-caller");
    const caller = await openWs("/v1/ws?role=call&to=legacy-callee", wsAuth("legacy-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "legacy-callee", message: "hello" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_answer", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "working" });
  });

  it("does not regress or repeat caller status for out-of-order acknowledgements", async () => {
    const { callerToken, listener } = await setupPair("order-callee", "order-caller");
    const caller = await openWs("/v1/ws?role=call&to=order-callee", wsAuth("order-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "order-callee", message: "hello" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "working" });
    listener.send(JSON.stringify({ type: "call_accepted", call_id: incoming.call_id }));
    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "done" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "done" });
  });

  it("terminates the caller with canceled after the listener confirms cancellation", async () => {
    const { callerToken, listener } = await setupPair("cancel-callee", "cancel-caller");
    const caller = await openWs("/v1/ws?role=call&to=cancel-callee", wsAuth("cancel-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "cancel-callee", message: "stop me" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_cancelled", call_id: incoming.call_id, phase: "running" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "canceled" });
    expect((await closed(caller)).code).toBe(1000);
  });

  it("keeps the call live when the listener cannot confirm cancellation", async () => {
    const { callerToken, listener } = await setupPair("late-callee", "late-caller");
    const caller = await openWs("/v1/ws?role=call&to=late-callee", wsAuth("late-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "late-callee", message: "still running" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_not_cancelled", call_id: incoming.call_id, reason: "too_late" }));
    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "finished" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "finished" });
  });

  it("returns offline immediately when no listener", async () => {
    await registerHandle("off-callee");
    const t = await registerHandle("off-caller");
    const caller = await openWs("/v1/ws?role=call&to=off-callee", wsAuth("off-caller", t));
    caller.send(JSON.stringify({ type: "call_request", to: "off-callee", message: "hi" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "offline" });
  });

  it("relays call_failed as call_error", async () => {
    const { callerToken, listener } = await setupPair("f-callee", "f-caller");
    const caller = await openWs("/v1/ws?role=call&to=f-callee", wsAuth("f-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "f-callee", message: "hi" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({ type: "call_failed", call_id: incoming.call_id, code: "busy" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "busy" });
  });

  // `detail` is the one free-form string a callee puts in front of a caller's
  // eyes, and the CLI prints it straight to the terminal. The relay must not
  // pass raw control bytes or an unbounded string through, the same way it
  // already truncates call_result text.
  it("sanitizes and bounds call_failed detail before relaying it", async () => {
    const { callerToken, listener } = await setupPair("d-callee", "d-caller");
    const caller = await openWs("/v1/ws?role=call&to=d-callee", wsAuth("d-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "d-callee", message: "hi" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({
      type: "call_failed", call_id: incoming.call_id, code: "agent_error",
      detail: "\u001b[2Jwiped\u001b]0;retitled\u0007" + "z".repeat(MAX_DETAIL_LENGTH * 2),
    }));
    const err = await nextFrame(caller);
    expect(err).toMatchObject({ type: "call_error", code: "agent_error" });
    expect(err.detail).not.toContain("\u001b");
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(err.detail)).toBe(false);
    expect(err.detail.length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH);
    expect(err.detail).toContain("wiped");
  });

  it("rejects oversized messages", async () => {
    const { callerToken } = await setupPair("big-callee", "big-caller");
    const caller = await openWs("/v1/ws?role=call&to=big-callee", wsAuth("big-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "big-callee", message: "x".repeat(65_000) }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "message_too_large" });
  });

  it("charges the per-hour rate limit for oversized frames too, not just accepted ones", async () => {
    const { callerToken } = await setupPair("ovr-rl-callee", "ovr-rl-caller");
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      const c = await openWs("/v1/ws?role=call&to=ovr-rl-callee", wsAuth("ovr-rl-caller", callerToken));
      c.send(JSON.stringify({ type: "call_request", to: "ovr-rl-callee", message: "x".repeat(65_000) }));
      expect(await nextFrame(c)).toMatchObject({ type: "call_error", code: "message_too_large" });
    }
    const overLimit = await openWs("/v1/ws?role=call&to=ovr-rl-callee", wsAuth("ovr-rl-caller", callerToken));
    overLimit.send(JSON.stringify({ type: "call_request", to: "ovr-rl-callee", message: "one too many" }));
    expect(await nextFrame(overLimit)).toMatchObject({ type: "call_error", code: "rate_limited" });
  });

  it("rate limits one call past the hourly limit", async () => {
    const { callerToken, listener } = await setupPair("rl-callee", "rl-caller");
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      const c = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
      c.send(JSON.stringify({ type: "call_request", to: "rl-callee", message: `call ${i}` }));
      await nextFrame(c); // ringing
      const inc = await nextFrame(listener);
      listener.send(JSON.stringify({ type: "call_result", call_id: inc.call_id, text: "ok" }));
      await nextFrame(c); // reply
    }
    const overLimit = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
    overLimit.send(JSON.stringify({ type: "call_request", to: "rl-callee", message: "one too many" }));
    expect(await nextFrame(overLimit)).toMatchObject({ type: "call_error", code: "rate_limited" });
  });

  it("times out a call whose listener never replies", async () => {
    const { callerToken } = await setupPair("to-callee", "to-caller");
    const caller = await openWs("/v1/ws?role=call&to=to-callee&test_timeout_ms=100", wsAuth("to-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "to-callee", message: "hello?" }));
    await nextFrame(caller); // ringing
    expect(await nextFrame(caller, 10_000)).toMatchObject({ type: "call_error", code: "timeout" });
  });

  it("rejects a second call_request on the same socket", async () => {
    const { callerToken } = await setupPair("p-callee", "p-caller");
    const caller = await openWs("/v1/ws?role=call&to=p-callee", wsAuth("p-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "p-callee", message: "one" }));
    await nextFrame(caller); // ringing
    caller.send(JSON.stringify({ type: "call_request", to: "p-callee", message: "two" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "protocol_error" });
  });

  it("survives listener reconnect mid-call", async () => {
    const { calleeToken, callerToken, listener } = await setupPair("rc-callee", "rc-caller");
    const caller = await openWs("/v1/ws?role=call&to=rc-callee", wsAuth("rc-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "rc-callee", message: "slow one" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.close(1000, "network blip");
    const listener2 = await openWs("/v1/ws?role=listen", wsAuth("rc-callee", calleeToken));
    listener2.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "late but here" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "late but here" });
  });

  it("uses the authenticated handle for from, not a forged header", async () => {
    const { callerToken, listener } = await setupPair("id-callee", "id-caller");
    const caller = await openWs("/v1/ws?role=call&to=id-callee", {
      ...wsAuth("id-caller", callerToken),
      "X-Verified-From": "forged-identity",
    });
    caller.send(JSON.stringify({ type: "call_request", to: "id-callee", message: "hi" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    expect(incoming.from).toBe("id-caller");
  });

  it("truncates an oversized CJK call_result to MAX_REPLY_BYTES on a code-point boundary", async () => {
    const { callerToken, listener } = await setupPair("cjk-callee", "cjk-caller");
    const caller = await openWs("/v1/ws?role=call&to=cjk-callee", wsAuth("cjk-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "cjk-callee", message: "hi" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    const bigReply = "あ".repeat(200_000); // ~600KB UTF-8 (3 bytes/char)
    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: bigReply }));
    const reply = await nextFrame(caller);
    expect(reply.type).toBe("call_reply");
    expect(new TextEncoder().encode(reply.text).byteLength).toBeLessThanOrEqual(256_000);
    expect(reply.text.includes("�")).toBe(false);
  });
});

describe("clampTimeoutMs", () => {
  it("passes through a requested timeout shorter than the cap", () => {
    expect(clampTimeoutMs(100)).toBe(100);
  });

  it("clamps a requested timeout longer than the cap down to RELAY_CALL_TIMEOUT_MS", () => {
    expect(clampTimeoutMs(RELAY_CALL_TIMEOUT_MS * 10)).toBe(RELAY_CALL_TIMEOUT_MS);
  });

  it("defaults to RELAY_CALL_TIMEOUT_MS when no timeout is requested", () => {
    expect(clampTimeoutMs(undefined)).toBe(RELAY_CALL_TIMEOUT_MS);
  });
});

describe("truncateUtf8Bytes", () => {
  it("returns text unchanged when already within the byte cap", () => {
    expect(truncateUtf8Bytes("hello", 100)).toBe("hello");
  });

  it("truncates on a UTF-8 byte boundary without corrupting the string", () => {
    const text = "あ".repeat(10); // 30 bytes (3 bytes/char)
    const truncated = truncateUtf8Bytes(text, 20);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(20);
    expect(truncated.includes("�")).toBe(false);
    expect(truncated).toBe("あ".repeat(6)); // 18 bytes fits, 7th char (21 bytes) doesn't
  });
});
