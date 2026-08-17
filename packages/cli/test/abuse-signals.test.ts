import { describe, expect, it } from "vitest";
import { signalForInboundStatus } from "../src/abuse-signals.js";

describe("objective local abuse signals", () => {
  it.each([
    ["blocked", ["blocked_caller_attempt"], "high"],
    ["task_unknown", ["unknown_task_request"], "low"],
  ] as const)("classifies %s without inspecting message content", (status, flags, severity) => {
    expect(signalForInboundStatus(status)).toEqual({ flags: [...flags], severity });
  });

  // #379 deleted the task menu, so `task_not_offered` is no longer a reachable
  // admission outcome and `unoffered_task_request` went with it. Moved into
  // the non-signal list below rather than simply dropped: a status this
  // function quietly ignores is exactly the case worth pinning, since a flag
  // that cannot be raised otherwise reads as merely unused.
  it.each(["ok", "busy", "canceled", "policy_error", "context_unknown", "task_not_offered", undefined])(
    "does not turn %s into an abuse claim",
    (status) => {
      expect(signalForInboundStatus(status)).toEqual({ flags: [] });
    },
  );
});
