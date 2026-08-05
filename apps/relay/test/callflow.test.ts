import { describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { MAX_E2EE_WIRE_BYTES, RELAY_CALL_TIMEOUT_MS, RATE_LIMIT_PER_HOUR } from "@benree/agentcall-shared";
import {
  closed, encryptedCallOutcome, encryptedCallRequest, nextFrame, openWs, registerHandle, wsAuth,
} from "./helpers.js";
import { clampTimeoutMs } from "../src/do.js";

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
    const correlationId = "1".repeat(32);
    const traceparent = `00-${correlationId}-${"2".repeat(16)}-01`;
    caller.send(JSON.stringify(encryptedCallRequest("h-caller", "h-callee", {
      correlation_id: correlationId, traceparent,
    })));

    const ringing = await nextFrame(caller);
    expect(ringing).toMatchObject({
      type: "call_status", state: "ringing", correlation_id: correlationId,
    });
    expect(ringing.call_id).toEqual(expect.any(String));
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({
      type: "incoming_call", call_id: ringing.call_id, from: "h-caller",
      correlation_id: correlationId, traceparent, envelope: { direction: "request" },
    });

    listener.send(JSON.stringify({ type: "call_accepted", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({
      type: "call_status", state: "answered", call_id: incoming.call_id, correlation_id: correlationId,
    });
    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({
      type: "call_status", state: "working", call_id: incoming.call_id, correlation_id: correlationId,
    });

    const outcome = encryptedCallOutcome(incoming.call_id, "h-callee", "h-caller");
    listener.send(JSON.stringify(outcome));
    expect(await nextFrame(caller)).toEqual(outcome);
    expect((await closed(caller)).code).toBe(1000);
  });

  it("exports tenant-scoped call lifecycle evidence without call content", async () => {
    const org = "call-audit-org";
    const calleeToken = await registerHandle("audit-callee", "claude", org);
    const callerToken = await registerHandle("audit-caller", "claude", org);
    const listener = await openWs("/v1/ws?role=listen", {
      ...wsAuth("audit-callee", calleeToken, org),
      "cf-connecting-ip": "203.0.113.20",
    });
    const caller = await openWs("/v1/ws?role=call&to=audit-callee", {
      ...wsAuth("audit-caller", callerToken, org),
      "cf-connecting-ip": "203.0.113.10",
    });
    caller.send(JSON.stringify(encryptedCallRequest("audit-caller", "audit-callee", { org })));
    const ringing = await nextFrame(caller);
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({ type: "call_accepted", call_id: incoming.call_id }));
    await nextFrame(caller);
    listener.send(JSON.stringify(encryptedCallOutcome(incoming.call_id, "audit-callee", "audit-caller", "completed", org)));
    await nextFrame(caller);

    const { results } = await env.DB.prepare(
      "SELECT event, actor, actor_type, target_type, target_id, actor_ip, actor_country, description " +
        "FROM org_events WHERE org = ? AND target_id = ? ORDER BY id",
    ).bind(org, ringing.call_id).all();
    expect(results).toEqual([
      expect.objectContaining({
        event: "call.submit", actor: "audit-caller", actor_type: "handle",
        target_type: "call", target_id: ringing.call_id, actor_ip: "203.0.113.10",
      }),
      expect.objectContaining({
        event: "call.accept", actor: "audit-callee", actor_type: "handle",
        target_type: "call", target_id: ringing.call_id, actor_ip: "203.0.113.20",
      }),
      expect.objectContaining({
        event: "call.complete", actor: "audit-callee", actor_type: "handle",
        target_type: "call", target_id: ringing.call_id, actor_ip: "203.0.113.20",
      }),
    ]);
    expect(JSON.stringify(results)).not.toContain("TOP-SECRET-PROMPT");
    expect(JSON.stringify(results)).not.toContain("TOP-SECRET-RESPONSE");

    const otherOrg = "call-audit-other";
    const otherToken = await registerHandle("other-admin", "claude", otherOrg);
    const exported = await SELF.fetch("https://relay.test/v1/audit/events?event=call.submit", {
      headers: wsAuth("other-admin", otherToken, otherOrg),
    });
    expect(exported.status).toBe(200);
    expect((await exported.json<{ events: unknown[] }>()).events).toEqual([]);
  });

  it("keeps call truth live and retries its durable outbox after D1 recovers", async () => {
    const org = "call-audit-retry";
    const calleeToken = await registerHandle("retry-callee", "claude", org);
    const callerToken = await registerHandle("retry-caller", "claude", org);
    const listener = await openWs("/v1/ws?role=listen", wsAuth("retry-callee", calleeToken, org));
    await env.DB.exec(
      "CREATE TRIGGER fail_retry_call_audit BEFORE INSERT ON org_events " +
        "WHEN NEW.org = 'call-audit-retry' BEGIN SELECT RAISE(FAIL, 'forced audit outage'); END",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const caller = await openWs(
        "/v1/ws?role=call&to=retry-callee",
        wsAuth("retry-caller", callerToken, org),
      );
      caller.send(JSON.stringify(encryptedCallRequest("retry-caller", "retry-callee", { org })));
      const ringing = await nextFrame(caller);
      const incoming = await nextFrame(listener);
      expect(ringing).toMatchObject({ type: "call_status", state: "ringing" });
      expect(error).toHaveBeenCalledWith("call audit delivery failure", expect.any(Object));

      await env.DB.exec("DROP TRIGGER fail_retry_call_audit");
      let delivered: { event: string } | null = null;
      for (let attempt = 0; attempt < 40 && !delivered; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        delivered = await env.DB.prepare(
          "SELECT event FROM org_events WHERE target_id = ? AND event = 'call.submit'",
        ).bind(ringing.call_id).first<{ event: string }>();
      }
      expect(delivered).toEqual({ event: "call.submit" });

      const outcome = encryptedCallOutcome(incoming.call_id, "retry-callee", "retry-caller", "completed", org);
      listener.send(JSON.stringify(outcome));
      expect(await nextFrame(caller)).toEqual(outcome);
    } finally {
      error.mockRestore();
      await env.DB.exec("DROP TRIGGER IF EXISTS fail_retry_call_audit");
    }
  }, 10_000);

  it("drains an audit backlog across D1-budget-safe alarm batches", async () => {
    const org = "call-audit-backlog";
    const callee = "backlog-callee";
    const callerHandle = "backlog-caller";
    const calleeToken = await registerHandle(callee, "claude", org);
    const callerToken = await registerHandle(callerHandle, "claude", org);
    const listener = await openWs("/v1/ws?role=listen", wsAuth(callee, calleeToken, org));
    await env.DB.exec(
      "CREATE TRIGGER fail_backlog_call_audit BEFORE INSERT ON org_events " +
        "WHEN NEW.org = 'call-audit-backlog' BEGIN SELECT RAISE(FAIL, 'forced audit backlog'); END",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 13; index++) {
        const caller = await openWs(
          `/v1/ws?role=call&to=${callee}`,
          wsAuth(callerHandle, callerToken, org),
        );
        caller.send(JSON.stringify(encryptedCallRequest(callerHandle, callee, { org })));
        await nextFrame(caller);
        const incoming = await nextFrame(listener);
        listener.send(JSON.stringify(encryptedCallOutcome(incoming.call_id, callee, callerHandle, "completed", org)));
        await nextFrame(caller);
      }
      await env.DB.exec("DROP TRIGGER fail_backlog_call_audit");

      let count = 0;
      for (let attempt = 0; attempt < 80 && count < 26; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        count = Number((await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM org_events WHERE org = ? AND event LIKE 'call.%'",
        ).bind(org).first<{ n: number }>())?.n ?? 0);
      }
      expect(count).toBe(26);
      expect(await env.DB.prepare(
        "SELECT COUNT(DISTINCT event_key) AS n FROM org_events WHERE org = ? AND event LIKE 'call.%'",
      ).bind(org).first()).toEqual({ n: 26 });
    } finally {
      error.mockRestore();
      await env.DB.exec("DROP TRIGGER IF EXISTS fail_backlog_call_audit");
    }
  }, 10_000);

  it("ignores invalid optional trace context and still delivers the call", async () => {
    const { callerToken, listener } = await setupPair("trace-callee", "trace-caller");
    const caller = await openWs("/v1/ws?role=call&to=trace-callee", wsAuth("trace-caller", callerToken));
    const correlationId = "3".repeat(32);
    caller.send(JSON.stringify(encryptedCallRequest("trace-caller", "trace-callee", {
      correlation_id: correlationId,
      traceparent: `00-${"4".repeat(32)}-${"5".repeat(16)}-01`,
    })));

    const ringing = await nextFrame(caller);
    expect(ringing).toMatchObject({ type: "call_status", state: "ringing", correlation_id: correlationId });
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({ type: "incoming_call", correlation_id: correlationId });
    expect(incoming).not.toHaveProperty("traceparent");
  });

  it("does not accept the legacy plaintext-era call_answer frame", async () => {
    const { callerToken, listener } = await setupPair("legacy-callee", "legacy-caller");
    const caller = await openWs("/v1/ws?role=call&to=legacy-callee", wsAuth("legacy-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("legacy-caller", "legacy-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_answer", call_id: incoming.call_id }));
    await expect(nextFrame(caller, 50)).rejects.toThrow(/timeout/);
    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "working" });
  });

  it("does not regress or repeat caller status for out-of-order acknowledgements", async () => {
    const { callerToken, listener } = await setupPair("order-callee", "order-caller");
    const caller = await openWs("/v1/ws?role=call&to=order-callee", wsAuth("order-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("order-caller", "order-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "working" });
    listener.send(JSON.stringify({ type: "call_accepted", call_id: incoming.call_id }));
    listener.send(JSON.stringify({ type: "call_started", call_id: incoming.call_id }));
    const outcome = encryptedCallOutcome(incoming.call_id, "order-callee", "order-caller");
    listener.send(JSON.stringify(outcome));
    expect(await nextFrame(caller)).toEqual(outcome);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE target_id = ? AND event = 'call.accept'",
    ).bind(incoming.call_id).first()).toEqual({ n: 1 });
  });

  it("terminates the caller with canceled after the listener confirms cancellation", async () => {
    const { callerToken, listener } = await setupPair("cancel-callee", "cancel-caller");
    const caller = await openWs("/v1/ws?role=call&to=cancel-callee", wsAuth("cancel-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("cancel-caller", "cancel-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_cancelled", call_id: incoming.call_id, phase: "running" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "canceled" });
    expect((await closed(caller)).code).toBe(1000);
    expect(await env.DB.prepare(
      "SELECT event, actor FROM org_events WHERE target_id = ? AND event = 'call.cancel'",
    ).bind(incoming.call_id).first()).toEqual({ event: "call.cancel", actor: "cancel-callee" });
  });

  it("keeps the call live when the listener cannot confirm cancellation", async () => {
    const { callerToken, listener } = await setupPair("late-callee", "late-caller");
    const caller = await openWs("/v1/ws?role=call&to=late-callee", wsAuth("late-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("late-caller", "late-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    listener.send(JSON.stringify({ type: "call_not_cancelled", call_id: incoming.call_id, reason: "too_late" }));
    const outcome = encryptedCallOutcome(incoming.call_id, "late-callee", "late-caller");
    listener.send(JSON.stringify(outcome));
    expect(await nextFrame(caller)).toEqual(outcome);
  });

  it("returns offline immediately when no listener", async () => {
    await registerHandle("off-callee");
    const t = await registerHandle("off-caller");
    const caller = await openWs("/v1/ws?role=call&to=off-callee", wsAuth("off-caller", t));
    caller.send(JSON.stringify(encryptedCallRequest("off-caller", "off-callee")));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "offline" });
  });

  it("relays an opaque authenticated failure outcome", async () => {
    const { callerToken, listener } = await setupPair("f-callee", "f-caller");
    const caller = await openWs("/v1/ws?role=call&to=f-callee", wsAuth("f-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("f-caller", "f-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    const outcome = encryptedCallOutcome(incoming.call_id, "f-callee", "f-caller", "failed");
    listener.send(JSON.stringify(outcome));
    expect(await nextFrame(caller)).toEqual(outcome);
    expect(await env.DB.prepare(
      "SELECT event, actor, target_id FROM org_events WHERE org = ? AND target_id = ? AND event = ?",
    ).bind("acme", incoming.call_id, "call.fail").first()).toEqual({
      event: "call.fail", actor: "f-callee", target_id: incoming.call_id,
    });
  });

  it("never accepts plaintext peer detail or offered fields", async () => {
    const { callerToken, listener } = await setupPair("d-callee", "d-caller");
    const caller = await openWs("/v1/ws?role=call&to=d-callee", wsAuth("d-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("d-caller", "d-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({
      ...encryptedCallOutcome(incoming.call_id, "d-callee", "d-caller", "failed"),
      detail: "plaintext", offered: ["ask"],
    }));
    await expect(nextFrame(caller, 50)).rejects.toThrow(/timeout/);
  });

  it("rejects oversized ciphertext frames", async () => {
    const { callerToken } = await setupPair("big-callee", "big-caller");
    const caller = await openWs("/v1/ws?role=call&to=big-callee", wsAuth("big-caller", callerToken));
    const frame = encryptedCallRequest("big-caller", "big-callee");
    frame.envelope.ct = "A".repeat(MAX_E2EE_WIRE_BYTES);
    caller.send(JSON.stringify(frame));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "message_too_large" });
  });

  it("charges the per-hour rate limit for oversized frames too, not just accepted ones", async () => {
    const { callerToken } = await setupPair("ovr-rl-callee", "ovr-rl-caller");
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      const c = await openWs("/v1/ws?role=call&to=ovr-rl-callee", wsAuth("ovr-rl-caller", callerToken));
      const frame = encryptedCallRequest("ovr-rl-caller", "ovr-rl-callee");
      frame.envelope.ct = "A".repeat(MAX_E2EE_WIRE_BYTES);
      c.send(JSON.stringify(frame));
      expect(await nextFrame(c)).toMatchObject({ type: "call_error", code: "message_too_large" });
    }
    const overLimit = await openWs("/v1/ws?role=call&to=ovr-rl-callee", wsAuth("ovr-rl-caller", callerToken));
    overLimit.send(JSON.stringify(encryptedCallRequest("ovr-rl-caller", "ovr-rl-callee")));
    expect(await nextFrame(overLimit)).toMatchObject({ type: "call_error", code: "rate_limited" });
  });

  it("rate limits one call past the hourly limit", async () => {
    const { callerToken, listener } = await setupPair("rl-callee", "rl-caller");
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      const c = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
      c.send(JSON.stringify(encryptedCallRequest("rl-caller", "rl-callee")));
      await nextFrame(c); // ringing
      const inc = await nextFrame(listener);
      listener.send(JSON.stringify(encryptedCallOutcome(inc.call_id, "rl-callee", "rl-caller")));
      await nextFrame(c); // reply
    }
    const overLimit = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
    overLimit.send(JSON.stringify(encryptedCallRequest("rl-caller", "rl-callee")));
    expect(await nextFrame(overLimit)).toMatchObject({ type: "call_error", code: "rate_limited" });
  });

  it("times out a call whose listener never replies", async () => {
    const { callerToken } = await setupPair("to-callee", "to-caller");
    const caller = await openWs("/v1/ws?role=call&to=to-callee&test_timeout_ms=100", wsAuth("to-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("to-caller", "to-callee")));
    const ringing = await nextFrame(caller);
    expect(await nextFrame(caller, 10_000)).toMatchObject({ type: "call_error", code: "timeout" });
    expect(await env.DB.prepare(
      "SELECT event, actor, actor_type FROM org_events WHERE target_id = ? AND event = 'call.timeout'",
    ).bind(ringing.call_id).first()).toEqual({
      event: "call.timeout", actor: "relay", actor_type: "system",
    });
  });

  it("does not misreport terminal-record retention cleanup as a timeout", async () => {
    const { callerToken, listener } = await setupPair("done-callee", "done-caller");
    const caller = await openWs(
      "/v1/ws?role=call&to=done-callee&test_timeout_ms=100",
      wsAuth("done-caller", callerToken),
    );
    caller.send(JSON.stringify(encryptedCallRequest("done-caller", "done-callee")));
    const ringing = await nextFrame(caller);
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify(encryptedCallOutcome(incoming.call_id, "done-callee", "done-caller")));
    await nextFrame(caller);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE target_id = ? AND event = 'call.timeout'",
    ).bind(ringing.call_id).first()).toEqual({ n: 0 });
  });

  it("rejects a second call_request on the same socket", async () => {
    const { callerToken } = await setupPair("p-callee", "p-caller");
    const caller = await openWs("/v1/ws?role=call&to=p-callee", wsAuth("p-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("p-caller", "p-callee")));
    const ringing = await nextFrame(caller);
    caller.send(JSON.stringify(encryptedCallRequest("p-caller", "p-callee")));
    expect(await nextFrame(caller)).toMatchObject({
      type: "call_error",
      code: "protocol_error",
      call_id: ringing.call_id,
      correlation_id: ringing.correlation_id,
    });
  });

  it("retains admitted call context when the second caller frame is malformed", async () => {
    const { callerToken } = await setupPair("pm-callee", "pm-caller");
    const caller = await openWs("/v1/ws?role=call&to=pm-callee", wsAuth("pm-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("pm-caller", "pm-callee")));
    const ringing = await nextFrame(caller);
    caller.send("not json");
    expect(await nextFrame(caller)).toMatchObject({
      type: "call_error",
      code: "protocol_error",
      call_id: ringing.call_id,
      correlation_id: ringing.correlation_id,
    });
  });

  it("survives listener reconnect mid-call", async () => {
    const { calleeToken, callerToken, listener } = await setupPair("rc-callee", "rc-caller");
    const caller = await openWs("/v1/ws?role=call&to=rc-callee", wsAuth("rc-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("rc-caller", "rc-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.close(1000, "network blip");
    const listener2 = await openWs("/v1/ws?role=listen", wsAuth("rc-callee", calleeToken));
    const outcome = encryptedCallOutcome(incoming.call_id, "rc-callee", "rc-caller");
    listener2.send(JSON.stringify(outcome));
    expect(await nextFrame(caller)).toEqual(outcome);
  });

  it("uses the authenticated handle for from, not a forged header", async () => {
    const { callerToken, listener } = await setupPair("id-callee", "id-caller");
    const caller = await openWs("/v1/ws?role=call&to=id-callee", {
      ...wsAuth("id-caller", callerToken),
      "X-Verified-From": "forged-identity",
    });
    caller.send(JSON.stringify(encryptedCallRequest("id-caller", "id-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    expect(incoming.from).toBe("id-caller");
  });

  it("drops an oversized encrypted outcome and accepts a later bounded outcome", async () => {
    const { callerToken, listener } = await setupPair("cjk-callee", "cjk-caller");
    const caller = await openWs("/v1/ws?role=call&to=cjk-callee", wsAuth("cjk-caller", callerToken));
    caller.send(JSON.stringify(encryptedCallRequest("cjk-caller", "cjk-callee")));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);

    const oversized = encryptedCallOutcome(incoming.call_id, "cjk-callee", "cjk-caller");
    oversized.envelope.ct = "A".repeat(MAX_E2EE_WIRE_BYTES);
    listener.send(JSON.stringify(oversized));
    await expect(nextFrame(caller, 50)).rejects.toThrow(/timeout/);

    const bounded = encryptedCallOutcome(incoming.call_id, "cjk-callee", "cjk-caller");
    listener.send(JSON.stringify(bounded));
    expect(await nextFrame(caller)).toEqual(bounded);
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
