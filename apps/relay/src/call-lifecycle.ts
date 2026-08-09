import type { Identity } from "./tenant.js";

export type TeamCallPrincipal = {
  kind: "team";
  organization: string;
  participant: string;
  credential_generation: number;
};

export type LiveCallPhase = "submitted" | "accepted" | "working";
type CallTerminalReason = "completed" | "failed" | "canceled" | "expired";
export type CallLifecycle = {
  principal: TeamCallPrincipal;
  phase: LiveCallPhase;
  deadline: number;
  terminal?: CallTerminalReason;
};

const PHASE_RANK: Record<LiveCallPhase, number> = {
  submitted: 0,
  accepted: 1,
  working: 2,
};

/** Build lifecycle input only after durable route authentication succeeds. */
export function teamCallPrincipal(identity: Identity): TeamCallPrincipal {
  return {
    kind: "team",
    organization: identity.org,
    participant: identity.handle,
    credential_generation: identity.recoveryGeneration,
  };
}

/** Begin lifecycle handling only after a route has authenticated this principal. */
export function beginAuthorizedCall(
  principal: TeamCallPrincipal,
  deadline: number,
): CallLifecycle {
  return { principal, phase: "submitted", deadline };
}

/** Ignore duplicate or backward peer frames; neither routing path may regress. */
export function advanceAuthorizedCall(
  lifecycle: CallLifecycle,
  requested: LiveCallPhase,
): CallLifecycle {
  if (lifecycle.terminal || PHASE_RANK[requested] <= PHASE_RANK[lifecycle.phase]) return lifecycle;
  return { ...lifecycle, phase: requested };
}

/** Make cancellation terminal without discarding the already-authorized identity boundary. */
export function terminateAuthorizedCall(
  lifecycle: CallLifecycle,
  terminal: CallTerminalReason,
): CallLifecycle {
  return lifecycle.terminal ? lifecycle : { ...lifecycle, terminal };
}

/** Return an expired terminal lifecycle only once its bounded deadline is reached. */
export function expireAuthorizedCall(
  lifecycle: CallLifecycle,
  now: number,
): CallLifecycle | undefined {
  return now >= lifecycle.deadline ? terminateAuthorizedCall(lifecycle, "expired") : undefined;
}
