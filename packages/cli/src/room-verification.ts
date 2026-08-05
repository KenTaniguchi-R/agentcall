import type { RoomCloseReasonType, RoomMutationResponseType } from "@benree/agentcall-shared";
import { roomMembershipFingerprint } from "@benree/agentcall-shared";
import { mutateRoom } from "./room-api.js";
import { pollRoomState, type RoomPollOptions } from "./room-poll.js";
import { formatFingerprintPrompt } from "./room-render.js";
import { createLineListener, type RoomLineListener } from "./tty.js";

export interface RoomVerificationDeps {
  relay: string;
  credential: string;
  ownParticipantId: string;
  poll?: typeof pollRoomState;
  mutate?: typeof mutateRoom;
  createListener?: () => RoomLineListener;
  pollIntervalMs?: number;
}

export type RoomVerificationResult =
  | { outcome: "active"; snapshot: RoomMutationResponseType }
  | { outcome: "closed"; reason: RoomCloseReasonType | "unknown" };

/**
 * Runs from the moment a poll snapshot shows `"verifying"` until the Room
 * reaches `"active"` or `"closed"`. Identical for host and guest: everyone
 * computes the same fingerprint locally from the same polled membership list
 * and confirms independently — nobody's confirmation is authoritative over
 * anyone else's.
 *
 * Uses a cancelable line listener, not tty.ts's per-question `ask()`, because
 * the prompt races against the relay's own `verification_deadline`: if the
 * deadline wins, the listener must be torn down cleanly rather than left
 * attached to stdin waiting for a line that may never come — two readline
 * interfaces on the same input stream is the exact "two readers race for the
 * typed line" hang this codebase has already fixed once (tty.ts's comments).
 */
export function runRoomVerification(deps: RoomVerificationDeps): Promise<RoomVerificationResult> {
  const {
    relay, credential, ownParticipantId, poll = pollRoomState, mutate = mutateRoom,
    createListener = createLineListener, pollIntervalMs,
  } = deps;

  return new Promise((resolve) => {
    let settled = false;
    let promptedEpoch = -1;
    const pollOptions: RoomPollOptions = {
      relay, credential, ownParticipantId, intervalMs: pollIntervalMs,
      onSnapshot: async (snapshot) => {
        if (settled) return;
        if (snapshot.room.state === "active") {
          settled = true;
          handle.stop();
          resolve({ outcome: "active", snapshot });
          return;
        }
        if (snapshot.room.state === "closed") {
          settled = true;
          handle.stop();
          resolve({ outcome: "closed", reason: snapshot.room.close_reason ?? "unknown" });
          return;
        }
        if (snapshot.room.state !== "verifying") return;
        if (promptedEpoch === snapshot.room.membership_epoch) return;
        promptedEpoch = snapshot.room.membership_epoch;

        const fingerprint = await roomMembershipFingerprint({
          room_id: snapshot.room.room_id,
          membership_epoch: snapshot.room.membership_epoch,
          members: snapshot.participants.map((p) => ({
            participant_id: p.participant_id, display_name: p.display_name,
            signing_public_key: p.signing_public_key, encryption_public_key: p.encryption_public_key,
          })),
        });
        const deadline = snapshot.room.verification_deadline ?? Date.now() + 60_000;
        const remainingMs = Math.max(1_000, deadline - Date.now());
        const listener = createListener();
        listener.print(formatFingerprintPrompt(fingerprint, snapshot.participants));
        const answer = await Promise.race<string | "timeout">([
          new Promise<string>((res) => listener.onLine(res)),
          new Promise<"timeout">((res) => setTimeout(() => res("timeout"), remainingMs)),
        ]);
        listener.close();
        if (settled) return;

        const action = answer.trim().toLowerCase() === "y" ? "confirm" : "reject";
        await mutate(relay, credential, action).catch(() => {});
      },
      onError: () => {},
    };
    const handle = poll(pollOptions);
  });
}
