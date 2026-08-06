import type { RoomCloseReasonType, RoomMutationResponseType } from "@benree/agentcall-shared";
import { roomMembershipFingerprint } from "@benree/agentcall-shared";
import { mutateRoom } from "./room-api.js";
import { pollRoomState, type RoomPollOptions } from "./room-poll.js";

export interface RoomVerificationDeps {
  relay: string;
  credential: string;
  ownParticipantId: string;
  poll?: typeof pollRoomState;
  mutate?: typeof mutateRoom;
  pollIntervalMs?: number;
}

export type RoomVerificationResult =
  | { outcome: "active"; snapshot: RoomMutationResponseType; fingerprint: string }
  | { outcome: "closed"; reason: RoomCloseReasonType | "unknown" };

/**
 * Runs from the moment a poll snapshot shows `"verifying"` until the Room
 * reaches `"active"` or `"closed"`. Identical for host and guest: everyone
 * computes the same fingerprint locally from the same polled membership list.
 *
 * The fingerprint is *reported*, not *gated on* (#369). It used to be a
 * blocking `[y/N]` the relay gave everyone 60 seconds to answer, where a
 * timeout, a stray keystroke, or one person stepping away closed the Room for
 * the whole group — unrecoverably, since locking already deleted the invites.
 * The check only ever detected substitution when people genuinely compared, and
 * a mandatory prompt is the design most likely to be cleared reflexively, so
 * this follows Zoom and Signal: access control blocks, key verification does
 * not. Callers surface the returned fingerprint so anyone who wants to compare
 * still can.
 */
export function runRoomVerification(deps: RoomVerificationDeps): Promise<RoomVerificationResult> {
  const {
    relay, credential, ownParticipantId, poll = pollRoomState, mutate = mutateRoom, pollIntervalMs,
  } = deps;

  return new Promise((resolve) => {
    let settled = false;
    let confirmedEpoch = -1;
    let fingerprint = "";
    const pollOptions: RoomPollOptions = {
      relay, credential, ownParticipantId, intervalMs: pollIntervalMs,
      onSnapshot: async (snapshot) => {
        if (settled) return;
        if (snapshot.room.state === "active") {
          settled = true;
          handle.stop();
          resolve({ outcome: "active", snapshot, fingerprint });
          return;
        }
        if (snapshot.room.state === "closed") {
          settled = true;
          handle.stop();
          resolve({ outcome: "closed", reason: snapshot.room.close_reason ?? "unknown" });
          return;
        }
        if (snapshot.room.state !== "verifying") return;
        // The poller fires repeatedly; a second confirm 409s once the relay has
        // marked this participant verified.
        if (confirmedEpoch === snapshot.room.membership_epoch) return;
        confirmedEpoch = snapshot.room.membership_epoch;

        fingerprint = await roomMembershipFingerprint({
          room_id: snapshot.room.room_id,
          membership_epoch: snapshot.room.membership_epoch,
          members: snapshot.participants.map((p) => ({
            participant_id: p.participant_id, display_name: p.display_name,
            signing_public_key: p.signing_public_key, encryption_public_key: p.encryption_public_key,
          })),
        });
        await mutate(relay, credential, "confirm").catch(() => {});
      },
      onError: () => {},
    };
    const handle = poll(pollOptions);
  });
}
