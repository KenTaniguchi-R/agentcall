import {
  RoomCapability, RoomInviteCapability, RoomParticipantId, RoomSecret, RoomId, RoomInviteId,
  type RoomIdType, type RoomInviteIdType, type RoomParticipantIdType,
} from "@benree/agentcall-shared";

function randomBase64url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function newRoomId(): RoomIdType {
  return RoomId.parse(`room_${randomBase64url(16)}`);
}

export function newParticipantId(): RoomParticipantIdType {
  return RoomParticipantId.parse(`rp_${randomBase64url(16)}`);
}

export function newInviteId(): RoomInviteIdType {
  return RoomInviteId.parse(`ri_${randomBase64url(16)}`);
}

export function newRoomSecret(): string {
  return RoomSecret.parse(randomBase64url(32));
}

export function formatRoomCapability(
  roomId: RoomIdType, participantId: RoomParticipantIdType, secret: string,
): string {
  return RoomCapability.parse(`acrp.${roomId}.${participantId}.${secret}`);
}

export function formatRoomInvite(
  roomId: RoomIdType, inviteId: RoomInviteIdType, secret: string,
): string {
  return RoomInviteCapability.parse(`acri.${roomId}.${inviteId}.${secret}`);
}

export function parseRoomCapability(value: string): {
  roomId: RoomIdType; participantId: RoomParticipantIdType; secret: string;
} | undefined {
  if (!RoomCapability.safeParse(value).success) return undefined;
  const [, roomId, participantId, secret] = value.split(".");
  return {
    roomId: RoomId.parse(roomId),
    participantId: RoomParticipantId.parse(participantId),
    secret: RoomSecret.parse(secret),
  };
}

export function parseRoomInvite(value: string): {
  roomId: RoomIdType; inviteId: RoomInviteIdType; secret: string;
} | undefined {
  if (!RoomInviteCapability.safeParse(value).success) return undefined;
  const [, roomId, inviteId, secret] = value.split(".");
  return {
    roomId: RoomId.parse(roomId),
    inviteId: RoomInviteId.parse(inviteId),
    secret: RoomSecret.parse(secret),
  };
}
