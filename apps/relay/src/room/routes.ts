import type { Context, Hono } from "hono";
import {
  ROOM_ABSOLUTE_TTL_MS, ROOM_IDLE_TTL_MS, ROOM_INVITE_TTL_MS,
  RoomAction, RoomCreateRequest, RoomCreateResponse, RoomJoinRequest, RoomJoinResponse,
  RoomMutationRequest, RoomSnapshot, verifyRoomJoinProof,
  type RoomActionType,
  type RoomPublicInviteType,
  type RoomInviteRecordType, type RoomParticipantRecordType, type RoomRecordType,
} from "@benree/agentcall-shared";
import { sha256Hex } from "../auth.js";
import type { RelayAppEnv } from "../middleware.js";
import { jsonBody } from "../middleware.js";
import {
  formatRoomCapability, formatRoomInvite, newInviteId, newParticipantId, newRoomId,
  newRoomSecret, parseRoomCapability, parseRoomInvite,
} from "./capability.js";

function bearer(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1] ?? "";
}

export function mountRooms(app: Hono<RelayAppEnv>): void {
  app.post("/v1/rooms", async (c) => {
    const parsed = await jsonBody(c, RoomCreateRequest);
    if (!parsed) return c.json({ error: "invalid Room request" }, 400);
    const now = Date.now();
    const roomId = newRoomId();
    const participantId = newParticipantId();
    const hostSecret = newRoomSecret();
    const room: RoomRecordType = {
      room_id: roomId,
      state: "waiting",
      moderator_participant_id: participantId,
      expected_participants: parsed.expected_participants,
      membership_epoch: 0,
      created_at: now,
      invite_deadline: now + ROOM_INVITE_TTL_MS,
      idle_deadline: now + ROOM_IDLE_TTL_MS,
      expires_at: now + ROOM_ABSOLUTE_TTL_MS,
    };
    const host: RoomParticipantRecordType = {
      participant_id: participantId,
      room_id: roomId,
      state: "admitted",
      display_name: parsed.display_name,
      credential_hash: await sha256Hex(hostSecret),
      signing_public_key: parsed.signing_public_key,
      encryption_public_key: parsed.encryption_public_key,
      agent_adapter: parsed.agent_adapter,
      joined_at: now,
      admitted_at: now,
      last_seen_at: now,
      calls_charged: 0,
    };
    const inviteId = newInviteId();
    const inviteSecret = newRoomSecret();
    const seatsRemaining = parsed.expected_participants - 1;
    const inviteRecord: RoomInviteRecordType = {
      invite_id: inviteId, room_id: roomId,
      secret_hash: await sha256Hex(inviteSecret), expires_at: room.invite_deadline,
      seats_remaining: seatsRemaining,
    };
    const publicInvite: RoomPublicInviteType = {
      invite: formatRoomInvite(roomId, inviteId, inviteSecret),
      expires_at: room.invite_deadline,
      seats_remaining: seatsRemaining,
    };
    const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(roomId));
    const response = await stub.fetch("https://room.internal/create", {
      method: "POST", body: JSON.stringify({ room, host, invite: inviteRecord }),
    });
    if (!response.ok) return c.json({ error: "Room unavailable" }, 503);
    const snapshot = RoomSnapshot.parse(await response.json());
    return c.json(RoomCreateResponse.parse({
      ...snapshot,
      credential: formatRoomCapability(roomId, participantId, hostSecret),
      invite: publicInvite,
    }), 201);
  });

  app.post("/v1/rooms/join", async (c) => {
    const parsed = await jsonBody(c, RoomJoinRequest);
    if (!parsed) return c.json({ error: "invalid Room join" }, 400);
    if (!(await verifyRoomJoinProof(parsed))) {
      return c.json({ error: "Room invitation unavailable" }, 404);
    }
    const invite = parseRoomInvite(parsed.invite);
    if (!invite) return c.json({ error: "Room invitation unavailable" }, 404);
    const participantId = newParticipantId();
    const now = Date.now();
    const participant: RoomParticipantRecordType = {
      participant_id: participantId,
      room_id: invite.roomId,
      state: "pending",
      display_name: parsed.display_name,
      credential_hash: await sha256Hex(parsed.participant_secret),
      signing_public_key: parsed.signing_public_key,
      encryption_public_key: parsed.encryption_public_key,
      agent_adapter: parsed.agent_adapter,
      joined_at: now,
      last_seen_at: now,
      calls_charged: 0,
    };
    const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(invite.roomId));
    const response = await stub.fetch("https://room.internal/join", {
      method: "POST",
      body: JSON.stringify({
        invite_id: invite.inviteId,
        invite_hash: await sha256Hex(invite.secret),
        participant,
      }),
    });
    const rawBody: unknown = await response.json();
    if (!response.ok) return c.json(rawBody as { error: string }, response.status as 400 | 404 | 409);
    const body = RoomJoinResponse.parse(rawBody);
    const returnedId = body.participant!.participant_id;
    return response.status === 201
      ? c.json(RoomJoinResponse.parse({
        ...body,
        credential: formatRoomCapability(invite.roomId, returnedId, parsed.participant_secret),
      }), 201)
      : c.json(RoomJoinResponse.parse(body), 200);
  });

  app.get("/v1/room", async (c) => forwardRoom(c, "state", "GET", {}));
  app.get("/v1/room/ws", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected websocket" }, 426);
    }
    const capability = parseRoomCapability(bearer(c.req.header("Authorization")));
    if (!capability) return c.json({ error: "Room capability unauthorized" }, 401);
    const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(capability.roomId));
    return stub.fetch("https://room.internal/ws", {
      headers: {
        Upgrade: "websocket",
        "X-Room-Participant": capability.participantId,
        "X-Room-Credential-Hash": await sha256Hex(capability.secret),
      },
    });
  });
  for (const action of RoomAction.options) {
    app.post(`/v1/room/${action}`, async (c) => {
      const parsed = await jsonBody(c, RoomMutationRequest);
      if (!parsed) return c.json({ error: "invalid Room action" }, 400);
      return forwardRoom(c, action, "POST", parsed);
    });
  }
}

async function forwardRoom(
  c: Context<RelayAppEnv>,
  action: RoomActionType | "state",
  method: "GET" | "POST",
  body: object,
): Promise<Response> {
  const capability = parseRoomCapability(bearer(c.req.header("Authorization")));
  if (!capability) return c.json({ error: "Room capability unauthorized" }, 401);
  const stub = c.env.ROOM_DO.get(c.env.ROOM_DO.idFromName(capability.roomId));
  const headers = new Headers({
    "X-Room-Participant": capability.participantId,
    "X-Room-Credential-Hash": await sha256Hex(capability.secret),
  });
  return stub.fetch(`https://room.internal/${action}`, {
    method, headers, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
