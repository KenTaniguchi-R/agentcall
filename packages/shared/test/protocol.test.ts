import { describe, expect, it } from "vitest";
import {
  CallRequest, CallerFrame, RelayToCallerFrame, ListenerToRelayFrame,
  HANDLE_RE, RESERVED_HANDLES, MAX_MESSAGE_BYTES, MAX_SESSION_ID_LENGTH, parseAddress, safeParseFrame,
  RegisterRequest, CallReply, IncomingCall, CallError, MAX_DETAIL_LENGTH, sanitizeDetail,
  CallAccepted, CallStarted, CancelCall, CallCancelled, CallNotCancelled, RelayToListenerFrame,
  AGENT_KINDS, AgentKindSchema,
} from "../src/index.js";

describe("handle rules", () => {
  it("accepts valid handles", () => {
    for (const h of ["ken", "a1", "my-agent-01"]) expect(HANDLE_RE.test(h)).toBe(true);
  });
  it("rejects invalid handles", () => {
    for (const h of ["K", "-a", "a", "a".repeat(32), "a_b", "a b", ""]) expect(HANDLE_RE.test(h)).toBe(false);
  });
  it("reserves system names", () => {
    expect(RESERVED_HANDLES).toContain("admin");
    expect(RESERVED_HANDLES).toContain("www");
  });
});

describe("parseAddress", () => {
  it("splits handle@host", () => {
    expect(parseAddress("ken@agentcall.benree.tech")).toEqual({ handle: "ken", host: "agentcall.benree.tech" });
  });
  it("rejects garbage", () => {
    expect(parseAddress("ken")).toBeNull();
    expect(parseAddress("KEN@x.y")).toBeNull();
    expect(parseAddress("ken@")).toBeNull();
  });
});

describe("frames", () => {
  it("round-trips a call_request", () => {
    const f = { type: "call_request", to: "ken", message: "hi" };
    expect(CallRequest.parse(f)).toEqual(f);
    expect(safeParseFrame(CallerFrame, JSON.stringify(f))).toEqual(f);
  });
  it("rejects unknown type via safeParseFrame", () => {
    expect(safeParseFrame(CallerFrame, JSON.stringify({ type: "nope" }))).toBeNull();
    expect(safeParseFrame(CallerFrame, "not json")).toBeNull();
  });
  it("relay->caller union covers status/reply/error", () => {
    expect(safeParseFrame(RelayToCallerFrame, JSON.stringify({ type: "call_status", state: "ringing" }))).not.toBeNull();
    expect(safeParseFrame(RelayToCallerFrame, JSON.stringify({ type: "call_reply", call_id: "x", text: "y" }))).not.toBeNull();
    expect(safeParseFrame(RelayToCallerFrame, JSON.stringify({ type: "call_error", code: "offline" }))).not.toBeNull();
  });
  it("listener->relay union covers answer/result/failed", () => {
    expect(safeParseFrame(ListenerToRelayFrame, JSON.stringify({ type: "call_answer", call_id: "x" }))).not.toBeNull();
    expect(safeParseFrame(ListenerToRelayFrame, JSON.stringify({ type: "call_result", call_id: "x", text: "t" }))).not.toBeNull();
    expect(safeParseFrame(ListenerToRelayFrame, JSON.stringify({ type: "call_failed", call_id: "x", code: "busy" }))).not.toBeNull();
  });
  it("exposes size constants", () => {
    expect(MAX_MESSAGE_BYTES).toBe(64_000);
  });
});

describe("session_id bounds", () => {
  it("rejects a CallRequest with an oversized session_id", () => {
    const f = { type: "call_request", to: "ken", message: "hi", session_id: "s".repeat(MAX_SESSION_ID_LENGTH + 1) };
    expect(CallRequest.safeParse(f).success).toBe(false);
    expect(safeParseFrame(CallerFrame, JSON.stringify(f))).toBeNull();
  });

  it("accepts a CallRequest with a session_id within the bound", () => {
    const f = { type: "call_request", to: "ken", message: "hi", session_id: "s".repeat(MAX_SESSION_ID_LENGTH) };
    expect(CallRequest.safeParse(f).success).toBe(true);
  });

  it("applies the same session_id bound to other frames carrying it", () => {
    const oversized = "s".repeat(MAX_SESSION_ID_LENGTH + 1);
    expect(CallReply.safeParse({ type: "call_reply", call_id: "x", text: "t", session_id: oversized }).success).toBe(false);
    expect(IncomingCall.safeParse({ type: "incoming_call", call_id: "x", from: "a", message: "m", session_id: oversized }).success).toBe(false);
  });

  it("bounds CallReply.task with the same TASK_ID_RE as other task fields", () => {
    expect(CallReply.safeParse({ type: "call_reply", call_id: "x", text: "t", task: "Not Valid!" }).success).toBe(false);
    expect(CallReply.safeParse({ type: "call_reply", call_id: "x", text: "t", task: "valid-task" }).success).toBe(true);
  });
});

describe("detail bounds and sanitization", () => {
  it("bounds CallError.detail — it is printed straight to a caller's terminal", () => {
    const over = "x".repeat(MAX_DETAIL_LENGTH + 1);
    expect(CallError.safeParse({ type: "call_error", code: "agent_error", detail: over }).success).toBe(false);
    expect(CallError.safeParse({ type: "call_error", code: "agent_error", detail: "x".repeat(MAX_DETAIL_LENGTH) }).success).toBe(true);
  });

  it("sanitizeDetail strips the ESC that makes a CSI/OSC sequence dangerous", () => {
    const out = sanitizeDetail("\u001b[31mred\u001b[0m\u001b]0;pwned");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("red");
  });

  it("sanitizeDetail strips 8-bit C1 introducers, not just ESC", () => {
    expect(sanitizeDetail("\u009b31m")).not.toContain("\u009b");
  });

  it("sanitizeDetail neutralizes carriage-return line overwriting", () => {
    expect(sanitizeDetail("real error\rFAKE SUCCESS")).not.toContain("\r");
  });

  it("sanitizeDetail replaces controls with a space so words don't run together", () => {
    expect(sanitizeDetail("line one\nline two")).toBe("line one line two");
  });

  it("sanitizeDetail leaves ordinary text (including non-ASCII) alone", () => {
    expect(sanitizeDetail("agent failed — 日本語 ok")).toBe("agent failed — 日本語 ok");
  });

  it("sanitizeDetail truncates to MAX_DETAIL_LENGTH without splitting a surrogate pair", () => {
    expect(sanitizeDetail("x".repeat(MAX_DETAIL_LENGTH + 50)).length).toBe(MAX_DETAIL_LENGTH);
    // An astral char straddling the cut must be dropped whole, never halved.
    const straddling = "a".repeat(MAX_DETAIL_LENGTH - 1) + "😀";
    const cut = sanitizeDetail(straddling);
    expect(cut.length).toBe(MAX_DETAIL_LENGTH - 1);
    expect(/[\ud800-\udfff]/.test(cut)).toBe(false);
  });

  it("sanitized output always satisfies the CallError.detail bound", () => {
    const hostile = ("\u001b[2J" + "y".repeat(50)).repeat(100);
    const detail = sanitizeDetail(hostile);
    expect(CallError.safeParse({ type: "call_error", code: "agent_error", detail }).success).toBe(true);
  });
});

describe("RegisterRequest", () => {
  it("parses with and without agent_kind (absent = caller-only)", () => {
    expect(RegisterRequest.parse({ handle: "ken", agent_kind: "claude" }))
      .toEqual({ handle: "ken", agent_kind: "claude" });
    expect(RegisterRequest.parse({ handle: "solo" })).toEqual({ handle: "solo" });
  });
  it("still rejects invalid agent kinds", () => {
    expect(RegisterRequest.safeParse({ handle: "ken", agent_kind: "vim" }).success).toBe(false);
  });
});

describe("AgentKind", () => {
  it("exposes the known agent kinds", () => {
    expect(AGENT_KINDS).toEqual(["claude", "codex"]);
  });

  it("accepts a known kind and rejects an unknown one", () => {
    expect(AgentKindSchema.parse("codex")).toBe("codex");
    expect(AgentKindSchema.safeParse("hermes").success).toBe(false);
  });
});

describe("cancellation and acknowledgement frames", () => {
  it("accepts the acknowledgement frames", () => {
    expect(CallAccepted.safeParse({ type: "call_accepted", call_id: "c1" }).success).toBe(true);
    expect(CallStarted.safeParse({ type: "call_started", call_id: "c1" }).success).toBe(true);
  });

  it("accepts cancel_call from the relay", () => {
    expect(CancelCall.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(true);
  });

  it("requires a phase on call_cancelled", () => {
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "running" }).success).toBe(true);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "pending" }).success).toBe(true);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1" }).success).toBe(false);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "elsewhere" }).success).toBe(false);
  });

  it("constrains call_not_cancelled reasons", () => {
    for (const reason of ["already_terminal", "unknown", "too_late"]) {
      expect(CallNotCancelled.safeParse({ type: "call_not_cancelled", call_id: "c1", reason }).success).toBe(true);
    }
    expect(CallNotCancelled.safeParse({ type: "call_not_cancelled", call_id: "c1", reason: "because" }).success).toBe(false);
  });

  it("routes the new frames through the right unions", () => {
    for (const f of [
      { type: "call_accepted", call_id: "c1" },
      { type: "call_started", call_id: "c1" },
      { type: "call_cancelled", call_id: "c1", phase: "running" },
      { type: "call_not_cancelled", call_id: "c1", reason: "too_late" },
    ]) {
      expect(ListenerToRelayFrame.safeParse(f).success, JSON.stringify(f)).toBe(true);
      expect(RelayToListenerFrame.safeParse(f).success, JSON.stringify(f)).toBe(false);
    }
    expect(RelayToListenerFrame.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(true);
    expect(ListenerToRelayFrame.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(false);
  });
});
