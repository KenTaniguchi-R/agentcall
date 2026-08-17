const ABUSE_SEVERITIES = ["low", "medium", "high"] as const;
export type AbuseSeverity = typeof ABUSE_SEVERITIES[number];

// `unoffered_task_request` went with #379's task menu: `task_not_offered` is no
// longer a reachable admission outcome, so nothing can raise the flag. A local
// history row still carrying it from before the change fails history.ts's flag
// validation and is skipped — that is call history on the owner's own machine,
// and the alternative is keeping a flag nothing can ever set again.
const ABUSE_FLAGS = [
  "blocked_caller_attempt",
  "unknown_task_request",
  "tool_policy_denial",
] as const;
export type AbuseFlag = typeof ABUSE_FLAGS[number];

interface AbuseSignal {
  flags: AbuseFlag[];
  severity?: AbuseSeverity;
}

const RANK: Record<AbuseSeverity, number> = { low: 1, medium: 2, high: 3 };

export function maxAbuseSeverity(
  left: AbuseSeverity | undefined,
  right: AbuseSeverity,
): AbuseSeverity {
  return left === undefined || RANK[right] > RANK[left] ? right : left;
}

// Objective admission outcomes only. This deliberately does not inspect prompt
// text: keyword matching is neither an abuse boundary nor a defensible
// harassment/injection classifier.
export function signalForInboundStatus(status: unknown): AbuseSignal {
  switch (status) {
    case "blocked":
      return { flags: ["blocked_caller_attempt"], severity: "high" };
    case "task_unknown":
      return { flags: ["unknown_task_request"], severity: "low" };
    default:
      return { flags: [] };
  }
}

export function isAbuseFlag(value: unknown): value is AbuseFlag {
  return typeof value === "string" && (ABUSE_FLAGS as readonly string[]).includes(value);
}

export function isAbuseSeverity(value: unknown): value is AbuseSeverity {
  return typeof value === "string" && (ABUSE_SEVERITIES as readonly string[]).includes(value);
}
