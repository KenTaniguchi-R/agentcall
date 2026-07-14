import { describe, expect, it } from "vitest";
import {
  CallRequest, CallerFrame, RelayToCallerFrame, ListenerToRelayFrame,
  HANDLE_RE, RESERVED_HANDLES, MAX_MESSAGE_BYTES, parseAddress, safeParseFrame,
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
