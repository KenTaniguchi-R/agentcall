import { describe, expect, it } from "vitest";
import {
  AgentCard, CallError, CallFailed, CallRequest, CallReply, CallResult,
  CardUpload, ErrorCode, IncomingCall, TASK_ID_RE,
} from "../src/index.js";

describe("task fields on call frames", () => {
  it("accepts call_request with an optional task id", () => {
    const ok = CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi", task: "schedule-meeting" });
    expect(ok.success).toBe(true);
    const noTask = CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi" });
    expect(noTask.success).toBe(true);
  });
  it("rejects a malformed task id", () => {
    const bad = CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi", task: "Bad_Task!" });
    expect(bad.success).toBe(false);
  });
  it("carries task through incoming_call, call_result, and call_reply", () => {
    expect(IncomingCall.safeParse({ type: "incoming_call", call_id: "c1", from: "a", message: "m", task: "ask" }).success).toBe(true);
    expect(CallResult.safeParse({ type: "call_result", call_id: "c1", text: "t", task: "ask" }).success).toBe(true);
    expect(CallReply.safeParse({ type: "call_reply", call_id: "c1", text: "t", task: "ask" }).success).toBe(true);
  });
  it("carries offered[] on call_failed and call_error", () => {
    expect(CallFailed.safeParse({ type: "call_failed", call_id: "c1", code: "task_not_offered", offered: ["ask"] }).success).toBe(true);
    expect(CallError.safeParse({ type: "call_error", code: "blocked", offered: [] }).success).toBe(true);
  });
  it("accepts the new error codes", () => {
    for (const code of ["blocked", "task_not_offered", "task_unknown"]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
});

describe("TASK_ID_RE", () => {
  it("accepts kebab-case ids and rejects uppercase/underscore/empty", () => {
    expect(TASK_ID_RE.test("schedule-meeting")).toBe(true);
    expect(TASK_ID_RE.test("ask")).toBe(true);
    expect(TASK_ID_RE.test("Bad")).toBe(false);
    expect(TASK_ID_RE.test("a_b")).toBe(false);
    expect(TASK_ID_RE.test("")).toBe(false);
  });
});

describe("card schemas", () => {
  const task = { id: "ask", name: "Ask", description: "Answer questions." };
  it("round-trips a CardUpload and applies defaults", () => {
    const parsed = CardUpload.parse({ agent_kind: "claude", tasks: [task], default_offer: ["ask"] });
    expect(parsed.description).toBe("");
    expect(parsed.grants).toEqual({});
    expect(parsed.tasks[0]).toMatchObject({ id: "ask", tier: "T1", examples: [] });
  });
  it("rejects a grant keyed by an invalid handle", () => {
    const bad = CardUpload.safeParse({
      agent_kind: "claude", tasks: [task], default_offer: ["ask"], grants: { "Bad Handle": ["ask"] },
    });
    expect(bad.success).toBe(false);
  });
  it("rejects a task with a bad tier", () => {
    const bad = CardUpload.safeParse({
      agent_kind: "claude", tasks: [{ ...task, tier: "T9" }], default_offer: [],
    });
    expect(bad.success).toBe(false);
  });
  it("round-trips an AgentCard (the relay's GET response shape)", () => {
    const card = AgentCard.parse({
      handle: "ken", description: "", agent_kind: "claude",
      tasks: [{ ...task, examples: [], tier: "T1" }], updated_at: 1752600000000,
    });
    expect(card.tasks).toHaveLength(1);
  });
});
