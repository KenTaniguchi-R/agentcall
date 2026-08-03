export const ABUSE_SEVERITIES = ["low", "medium", "high"] as const;
export type AbuseSeverity = typeof ABUSE_SEVERITIES[number];

export const ABUSE_FLAGS = [
  "blocked_caller_attempt",
  "unoffered_task_request",
  "unknown_task_request",
  "tool_policy_denial",
] as const;
export type AbuseFlag = typeof ABUSE_FLAGS[number];

export interface AbuseSignal {
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
    case "task_not_offered":
      return { flags: ["unoffered_task_request"], severity: "medium" };
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
