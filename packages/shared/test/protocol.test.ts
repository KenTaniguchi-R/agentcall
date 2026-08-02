import { describe, expect, it } from "vitest";
import {
  CallRequest, CallerFrame, RelayToCallerFrame, ListenerToRelayFrame,
  HANDLE_RE, RESERVED_HANDLES, MAX_MESSAGE_BYTES, parseAddress, safeParseFrame,
  RegisterRequest, CallReply, CallError, MAX_DETAIL_LENGTH, sanitizeDetail,
  CallAccepted, CallStarted, CancelCall, CallCancelled, CallNotCancelled, RelayToListenerFrame,
  TASK_ID_RE, MAX_TASK_ID_LENGTH,
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

describe("task id bounds", () => {
  it("MAX_TASK_ID_LENGTH matches TASK_ID_RE", () => {
    // A MAX_TASK_ID_LENGTH-character id (all a's) must match.
    expect(TASK_ID_RE.test("a".repeat(MAX_TASK_ID_LENGTH))).toBe(true);
    // One character longer must not match.
    expect(TASK_ID_RE.test("a".repeat(MAX_TASK_ID_LENGTH + 1))).toBe(false);
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

describe("CallReply task bounds", () => {
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

import {
  CONTEXT_ID_RE, ErrorCode,
  CONTEXT_TTL_MS, MAX_CONTEXT_TURNS, MAX_CONTEXTS, RATE_LIMIT_PER_HOUR,
} from "../src/protocol.js";

describe("context_id", () => {
  const good = "ctx_AAAAAAAAAAAAAAAAAAAAAA"; // 22 base64url chars

  it("accepts a minted id", () => {
    expect(CONTEXT_ID_RE.test(good)).toBe(true);
    // Exercises the full base64url alphabet: upper, lower, digit, - and _.
    expect(CONTEXT_ID_RE.test("ctx_aB3-_xxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("rejects wrong prefix, wrong length, and non-base64url characters", () => {
    expect(CONTEXT_ID_RE.test("AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(CONTEXT_ID_RE.test("sess_AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAAAAA")).toBe(false);  // 21
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAAAAAAA")).toBe(false); // 23
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAAAA+/")).toBe(false);
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAA\nAA")).toBe(false);
  });

  // The old MAX_SESSION_ID_LENGTH cap allowed any string up to 256 bytes.
  // A consumed field gets a shape, not a size limit.
  it("rejects a 256-char string the old length cap allowed", () => {
    expect(CallRequest.safeParse({
      type: "call_request", to: "ken", message: "hi", context_id: "x".repeat(256),
    }).success).toBe(false);
  });

  it("round-trips on request and reply, and stays optional", () => {
    expect(CallRequest.safeParse({
      type: "call_request", to: "ken", message: "hi", context_id: good,
    }).success).toBe(true);
    expect(CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi" }).success).toBe(true);
    expect(CallReply.safeParse({
      type: "call_reply", call_id: "c1", text: "ok", context_id: good,
    }).success).toBe(true);
  });

  it("adds context_unknown to the error codes", () => {
    expect(ErrorCode.safeParse("context_unknown").success).toBe(true);
  });

  it("exports threading bounds and the raised rate limit", () => {
    expect(CONTEXT_TTL_MS).toBe(1_800_000);
    expect(MAX_CONTEXT_TURNS).toBe(10);
    expect(MAX_CONTEXTS).toBe(100);
    expect(RATE_LIMIT_PER_HOUR).toBe(30);
  });
});
