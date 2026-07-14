import { describe, expect, it } from "vitest";
import { RELAY_CALL_TIMEOUT_MS } from "@agentcall/shared";
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

    listener.send(JSON.stringify({ type: "call_answer", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "answered" });

    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "4", session_id: "s1" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "4", session_id: "s1" });
    expect((await closed(caller)).code).toBe(1000);
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

  it("rejects oversized messages", async () => {
    const { callerToken } = await setupPair("big-callee", "big-caller");
    const caller = await openWs("/v1/ws?role=call&to=big-callee", wsAuth("big-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "big-callee", message: "x".repeat(65_000) }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "message_too_large" });
  });

  it("rate limits the 11th call in an hour", async () => {
    const { callerToken, listener } = await setupPair("rl-callee", "rl-caller");
    for (let i = 0; i < 10; i++) {
      const c = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
      c.send(JSON.stringify({ type: "call_request", to: "rl-callee", message: `call ${i}` }));
      await nextFrame(c); // ringing
      const inc = await nextFrame(listener);
      listener.send(JSON.stringify({ type: "call_result", call_id: inc.call_id, text: "ok" }));
      await nextFrame(c); // reply
    }
    const eleventh = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
    eleventh.send(JSON.stringify({ type: "call_request", to: "rl-callee", message: "one too many" }));
    expect(await nextFrame(eleventh)).toMatchObject({ type: "call_error", code: "rate_limited" });
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
