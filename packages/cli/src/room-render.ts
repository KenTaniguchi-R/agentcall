import { userInfo } from "node:os";
import {
  RoomDisplayName,
  type RoomCloseReasonType, type RoomMutationResponseType, type RoomPublicInviteType, type RoomPublicParticipantType,
} from "@benree/agentcall-shared";

export function formatInviteLines(invites: readonly RoomPublicInviteType[]): string[] {
  return invites.map((invite) => `  Guest ${invite.seat}: ${invite.invite}`);
}

const CLOSE_REASON_COPY: Record<RoomCloseReasonType, string> = {
  host_left: "The host disconnected.",
  expired: "The Room's 30-minute time limit was reached.",
  idle: "The Room was closed for 10 minutes of inactivity.",
  verification_failed: "Not everyone confirmed the same membership code in time.",
  insufficient_participants: "Too few people remained in the Room.",
  abuse_limit: "The Room was closed after too many failed join attempts.",
  relay_error: "The relay closed the Room due to an internal error.",
};

export function formatCloseReason(reason: RoomCloseReasonType): string {
  return CLOSE_REASON_COPY[reason];
}

export function formatFingerprintPrompt(
  fingerprint: string, members: readonly Pick<RoomPublicParticipantType, "display_name">[],
): string {
  const names = members.map((m) => m.display_name).join(", ");
  return [
    `Room members: ${names}`,
    `Compare this code with everyone: ${fingerprint}`,
    "Does everyone see the same code? [y/N] ",
  ].join("\n");
}

function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  return `${minutes}m`;
}

export function formatRoomStatusBoard(snapshot: RoomMutationResponseType, elapsedMs: number): string {
  const lines = [
    `Room active · ${formatElapsed(elapsedMs)} elapsed · ${snapshot.participants.length} ${
      snapshot.participants.length === 1 ? "person" : "people"
    }`,
  ];
  for (const participant of snapshot.participants) {
    lines.push(`  ${participant.display_name.padEnd(10)} ${participant.state}`);
  }
  return lines.join("\n");
}

// RoomDisplayName requires 1-24 Unicode code points, no surrounding
// whitespace, no "@", and no control/bidi characters. This is a best-effort
// cleanup before the real check (RoomDisplayName.safeParse, run wherever a
// name is actually submitted) — it does not guarantee validity on its own.
export function sanitizeDisplayName(input: string): string {
  const codePoints = [...input.normalize("NFC").trim()];
  return codePoints.slice(0, 24).join("");
}

export function resolveHostDisplayName(explicit?: string): string {
  if (explicit) {
    const sanitized = sanitizeDisplayName(explicit);
    if (RoomDisplayName.safeParse(sanitized).success) return sanitized;
  }
  const sanitized = sanitizeDisplayName(userInfo().username);
  if (RoomDisplayName.safeParse(sanitized).success) return sanitized;
  return "Host";
}

/** A locally-suggested alternative after a 409 duplicate-name conflict. */
export function suggestAlternateDisplayName(rejected: string, attempt: number): string {
  const suffix = String(attempt + 1);
  const base = sanitizeDisplayName(rejected);
  const trimmed = [...base].slice(0, 24 - suffix.length).join("");
  const suggested = `${trimmed}${suffix}`;
  return RoomDisplayName.safeParse(suggested).success ? suggested : `Guest${suffix}`;
}
