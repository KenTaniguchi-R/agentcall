import { describe, expect, it } from "vitest";
import {
  AgentCard, CallError, CallFailed, CallRequest, CallReply, CallResult,
  CardUpload, ErrorCode, IncomingCall, MAX_OFFERED_TASKS, TASK_ID_RE,
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
    expect(IncomingCall.safeParse({
      type: "incoming_call", call_id: "c1", from: "a", message: "m", task: "ask", groups: ["g".repeat(22)],
    }).success).toBe(true);
    expect(CallResult.safeParse({ type: "call_result", call_id: "c1", text: "t", task: "ask" }).success).toBe(true);
    expect(CallReply.safeParse({ type: "call_reply", call_id: "c1", text: "t", task: "ask" }).success).toBe(true);
  });
  it("carries offered[] on call_failed and call_error", () => {
    expect(CallFailed.safeParse({ type: "call_failed", call_id: "c1", code: "task_not_offered", offered: ["ask"] }).success).toBe(true);
    expect(CallError.safeParse({ type: "call_error", code: "blocked", offered: [] }).success).toBe(true);
  });
  it("rejects an offered[] entry that isn't a valid task id (terminal-injection guard)", () => {
    const badFailed = CallFailed.safeParse({
      type: "call_failed", call_id: "c1", code: "task_not_offered", offered: ["Bad\x1b[31mTask"],
    });
    expect(badFailed.success).toBe(false);
    const badError = CallError.safeParse({ type: "call_error", code: "blocked", offered: ["Bad\x1b[31mTask"] });
    expect(badError.success).toBe(false);
  });
  it("rejects offered[] longer than MAX_OFFERED_TASKS (unbounded relay payload guard)", () => {
    const tooMany = Array.from({ length: MAX_OFFERED_TASKS + 1 }, (_, i) => `task-${i}`);
    expect(CallFailed.safeParse({
      type: "call_failed", call_id: "c1", code: "task_not_offered", offered: tooMany,
    }).success).toBe(false);
    expect(CallError.safeParse({ type: "call_error", code: "blocked", offered: tooMany }).success).toBe(false);
  });
  it("still accepts a valid offered[] list at or under the cap", () => {
    const okMany = Array.from({ length: MAX_OFFERED_TASKS }, (_, i) => `task-${i}`);
    expect(CallFailed.safeParse({
      type: "call_failed", call_id: "c1", code: "task_not_offered", offered: okMany,
    }).success).toBe(true);
  });
  it("accepts the new error codes", () => {
    for (const code of ["blocked", "task_not_offered", "task_unknown", "canceled"]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
  it("requires the dedicated confirmation frame for cancellation", () => {
    expect(CallError.safeParse({ type: "call_error", code: "canceled" }).success).toBe(true);
    expect(CallFailed.safeParse({ type: "call_failed", call_id: "c1", code: "canceled" }).success).toBe(false);
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
    expect(parsed.tasks[0]).toMatchObject({ id: "ask", examples: [] });
  });
  it("rejects a grant keyed by an invalid handle", () => {
    const bad = CardUpload.safeParse({
      agent_kind: "claude", tasks: [task], default_offer: ["ask"], grants: { "Bad Handle": ["ask"] },
    });
    expect(bad.success).toBe(false);
  });
  // `tier` was removed; cards already stored on the relay still carry it, so
  // parsing must strip it rather than reject the whole card.
  it("strips a legacy tier field instead of rejecting the card", () => {
    const parsed = CardUpload.parse({
      agent_kind: "claude", tasks: [{ ...task, tier: "T2" }], default_offer: ["ask"],
    });
    expect(parsed.tasks[0]).not.toHaveProperty("tier");
    expect(parsed.tasks[0].id).toBe("ask");
  });
  it("round-trips an AgentCard (the relay's GET response shape)", () => {
    const card = AgentCard.parse({
      handle: "ken", description: "", agent_kind: "claude",
      tasks: [{ ...task, examples: [] }], updated_at: 1752600000000,
    });
    expect(card.tasks).toHaveLength(1);
  });
});
