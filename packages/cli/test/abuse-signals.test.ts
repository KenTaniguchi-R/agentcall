import { describe, expect, it } from "vitest";
import { signalForInboundStatus } from "../src/abuse-signals.js";

describe("objective local abuse signals", () => {
  it.each([
    ["blocked", ["blocked_caller_attempt"], "high"],
    ["task_not_offered", ["unoffered_task_request"], "medium"],
    ["task_unknown", ["unknown_task_request"], "low"],
  ] as const)("classifies %s without inspecting message content", (status, flags, severity) => {
    expect(signalForInboundStatus(status)).toEqual({ flags: [...flags], severity });
  });

  it.each(["ok", "busy", "canceled", "policy_error", "context_unknown", undefined])(
    "does not turn %s into an abuse claim",
    (status) => {
      expect(signalForInboundStatus(status)).toEqual({ flags: [] });
    },
  );
});
