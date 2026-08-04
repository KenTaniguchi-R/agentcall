import type { RoomIdType, RoomParticipantIdType } from "@benree/agentcall-shared";
import type { Identity } from "./tenant.js";

export type TeamCallPrincipal = {
  kind: "team";
  organization: string;
  participant: string;
  credential_generation: number;
};

export type RoomCallPrincipal = {
  kind: "room";
  room_id: RoomIdType;
  participant_id: RoomParticipantIdType;
  membership_epoch: number;
};

export type AuthorizedCallPrincipal = TeamCallPrincipal | RoomCallPrincipal;
export type LiveCallPhase = "submitted" | "accepted" | "working";
export type CallTerminalReason = "completed" | "failed" | "canceled" | "expired";
export type AuthorizedCallLifecycle = {
  principal: AuthorizedCallPrincipal;
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

/** Build lifecycle input only after a Room capability is verified by RoomDO. */
export function roomCallPrincipal(input: {
  roomId: RoomIdType;
  participantId: RoomParticipantIdType;
  membershipEpoch: number;
}): RoomCallPrincipal {
  return {
    kind: "room",
    room_id: input.roomId,
    participant_id: input.participantId,
    membership_epoch: input.membershipEpoch,
  };
}

export function authorizedPrincipalKey(principal: AuthorizedCallPrincipal): string {
  return principal.kind === "team"
    ? `team:${principal.organization}:${principal.participant}:${principal.credential_generation}`
    : `room:${principal.room_id}:${principal.membership_epoch}:${principal.participant_id}`;
}

/** Begin lifecycle handling only after a route has authenticated this principal. */
export function beginAuthorizedCall(
  principal: AuthorizedCallPrincipal,
  deadline: number,
): AuthorizedCallLifecycle {
  return { principal, phase: "submitted", deadline };
}

/** Ignore duplicate or backward peer frames; neither routing path may regress. */
export function advanceAuthorizedCall(
  lifecycle: AuthorizedCallLifecycle,
  requested: LiveCallPhase,
): AuthorizedCallLifecycle {
  if (lifecycle.terminal || PHASE_RANK[requested] <= PHASE_RANK[lifecycle.phase]) return lifecycle;
  return { ...lifecycle, phase: requested };
}

/** Make cancellation terminal without discarding the already-authorized identity boundary. */
export function terminateAuthorizedCall(
  lifecycle: AuthorizedCallLifecycle,
  terminal: CallTerminalReason,
): AuthorizedCallLifecycle {
  return lifecycle.terminal ? lifecycle : { ...lifecycle, terminal };
}

/** Return an expired terminal lifecycle only once its bounded deadline is reached. */
export function expireAuthorizedCall(
  lifecycle: AuthorizedCallLifecycle,
  now: number,
): AuthorizedCallLifecycle | undefined {
  return now >= lifecycle.deadline ? terminateAuthorizedCall(lifecycle, "expired") : undefined;
}
