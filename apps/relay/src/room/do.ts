import { DurableObject } from "cloudflare:workers";
import {
  ROOM_HEARTBEAT_GRACE_MS, ROOM_IDLE_TTL_MS,
  ROOM_AGENT_TIMEOUT_MS, ROOM_MAX_CALLS_PER_PARTICIPANT,
  ROOM_MAX_CALL_WIRE_BYTES, ROOM_MAX_FAILED_JOINS, ROOM_SUBMISSION_COOLDOWN_MS,
  ROOM_VERIFICATION_TTL_MS,
  RoomAction, RoomMutationResponse, RoomSnapshot, RoomSocketClientFrame,
  type RoomActionType,
  type RoomCallStateType, type RoomCallSubmitType,
  type RoomCloseReasonType, type RoomInviteRecordType, type RoomParticipantRecordType,
  type RoomRecordType, type RoomRelayCallErrorCodeType, type RoomSocketClientFrameType,
  type RoomSocketRelayFrameType,
} from "@benree/agentcall-shared";
import { constantTimeEqual } from "../auth.js";
import {
  advanceAuthorizedCall, beginAuthorizedCall, expireAuthorizedCall, roomCallPrincipal,
  terminateAuthorizedCall, type AuthorizedCallLifecycle, type RoomCallPrincipal,
} from "../call-lifecycle.js";

type ClosedTombstone = { close_reason: RoomCloseReasonType; cleanup_at: number };
type InternalCreate = {
  room: RoomRecordType;
  host: RoomParticipantRecordType;
  invite: RoomInviteRecordType;
};
type InternalJoin = {
  invite_id: string;
  invite_hash: string;
  participant: RoomParticipantRecordType;
};
type RoomSocketAttachment = { kind: "room"; principal: RoomCallPrincipal };
type StoredRoomCall = {
  principal: RoomCallPrincipal;
  call_id: string;
  idempotency_key: string;
  room_id: string;
  membership_epoch: number;
  from_participant_id: string;
  to_participant_id: string;
  state: RoomCallStateType;
  request_digest: string;
  encrypted_request?: string;
  terminal?: "completed" | "failed" | "canceled" | "expired";
  created_at: number;
  expires_at: number;
};
type RoomOutbound = { participant_id: string; frame: RoomSocketRelayFrameType };

const ROOM_KEY = "room";
const CLOSED_KEY = "closed";
const FAILED_JOINS_KEY = "meta:failed-joins";
const CALL_RECORD_PREFIX = "call:record:";
const CALL_IDEMPOTENCY_PREFIX = "call:idempotency:";
const CALL_LAST_SUBMISSION_PREFIX = "call:last-submission:";
const participantKey = (id: string) => `participant:${id}`;
const inviteKey = (id: string) => `invite:${id}`;
const callKey = (id: string) => `${CALL_RECORD_PREFIX}${id}`;
const idempotencyKey = (participantId: string, key: string) =>
  `${CALL_IDEMPOTENCY_PREFIX}${participantId}:${key}`;
const lastSubmissionKey = (participantId: string) => `${CALL_LAST_SUBMISSION_PREFIX}${participantId}`;
const terminalCall = (state: RoomCallStateType) =>
  ["completed", "failed", "canceled", "expired"].includes(state);

function roomCallLifecycle(call: StoredRoomCall): AuthorizedCallLifecycle {
  return {
    principal: call.principal,
    phase: terminalCall(call.state) ? "working" : call.state as "submitted" | "accepted" | "working",
    deadline: call.expires_at,
    ...(call.terminal ? { terminal: call.terminal } : {}),
  };
}

function publicParticipant(participant: RoomParticipantRecordType) {
  const { credential_hash: _credentialHash, ...publicRecord } = participant;
  return publicRecord;
}

// Join order, host first. Every client renders this list beside the membership
// fingerprint, so the order has to be identical everywhere: participant_id
// breaks a same-millisecond tie rather than leaving it to storage order.
function publicRoom(room: RoomRecordType, participants: RoomParticipantRecordType[]) {
  return {
    room,
    participants: participants
      .sort((left, right) =>
        left.joined_at - right.joined_at ||
        (left.participant_id < right.participant_id ? -1 : left.participant_id > right.participant_id ? 1 : 0))
      .map(publicParticipant),
  };
}

export class RoomDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/create" && request.method === "POST") {
      return this.create(await request.json<InternalCreate>(), now);
    }
    if (url.pathname === "/join" && request.method === "POST") {
      return this.join(await request.json<InternalJoin>(), now);
    }

    const room = await this.ctx.storage.get<RoomRecordType>(ROOM_KEY);
    if (!room) return Response.json({ error: "Room unavailable" }, { status: 401 });
    const enforced = await this.enforceDeadlines(room, now);
    if (!enforced) return Response.json({ error: "Room unavailable" }, { status: 401 });

    const participantId = request.headers.get("X-Room-Participant") ?? "";
    const credentialHash = request.headers.get("X-Room-Credential-Hash") ?? "";
    const actor = await this.ctx.storage.get<RoomParticipantRecordType>(participantKey(participantId));
    if (!actor || !constantTimeEqual(actor.credential_hash, credentialHash) || actor.state === "departed") {
      return Response.json({ error: "Room capability unauthorized" }, { status: 401 });
    }

    if (url.pathname === "/ws" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "expected websocket" }, { status: 426 });
      }
      if (enforced.state !== "active" || !["ready", "paused"].includes(actor.state)) {
        return Response.json({ error: "Room is not active" }, { status: 409 });
      }
      if (this.participantSocket(actor.participant_id)) {
        return Response.json({ error: "Room participant already connected" }, { status: 409 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const principal = roomCallPrincipal({
        roomId: enforced.room_id,
        participantId: actor.participant_id,
        membershipEpoch: enforced.membership_epoch,
      });
      this.ctx.acceptWebSocket(server, ["room", `participant:${actor.participant_id}`]);
      server.serializeAttachment({ kind: "room", principal } satisfies RoomSocketAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      return Response.json(RoomMutationResponse.parse({
        ...(await this.snapshot(enforced)), participant: publicParticipant(actor),
      }));
    }
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const body: { participant_id?: string } = await request.json<{ participant_id?: string }>()
      .catch(() => ({}));
    const action = RoomAction.safeParse(url.pathname.slice(1));
    if (!action.success) return Response.json({ error: "Room action not found" }, { status: 404 });
    const result = await this.mutate(enforced, actor, action.data, body.participant_id, now);
    return Response.json(
      result.status >= 200 && result.status < 300 ? RoomMutationResponse.parse(result.body) : result.body,
      { status: result.status },
    );
  }

  private async create(input: InternalCreate, now: number): Promise<Response> {
    const created = await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(ROOM_KEY)) return false;
      await txn.put(ROOM_KEY, input.room);
      await txn.put(participantKey(input.host.participant_id), input.host);
      await txn.put(inviteKey(input.invite.invite_id), input.invite);
      await txn.put(FAILED_JOINS_KEY, 0);
      await this.schedule(txn, input.room, [input.host], now);
      return true;
    });
    if (!created) return Response.json({ error: "Room unavailable" }, { status: 409 });
    return Response.json(RoomSnapshot.parse(await this.snapshot(input.room)), { status: 201 });
  }

  private async join(input: InternalJoin, now: number): Promise<Response> {
    const existingRoom = await this.ctx.storage.get<RoomRecordType>(ROOM_KEY);
    if (!existingRoom || !(await this.enforceDeadlines(existingRoom, now))) {
      return Response.json({ error: "Room invitation unavailable" }, { status: 404 });
    }
    const result = await this.ctx.storage.transaction(async (txn) => {
      const room = await txn.get<RoomRecordType>(ROOM_KEY);
      if (!room || room.state !== "waiting" || now >= room.invite_deadline || now >= room.expires_at) {
        return { status: 404 as const, error: "Room invitation unavailable" };
      }
      const invite = await txn.get<RoomInviteRecordType>(inviteKey(input.invite_id));
      if (!invite || now >= invite.expires_at || !constantTimeEqual(invite.secret_hash, input.invite_hash)) {
        return { status: 404 as const, error: "Room invitation unavailable" };
      }
      const participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
      const retry = participants.find((existing) =>
        constantTimeEqual(existing.credential_hash, input.participant.credential_hash));
      if (retry) {
        if (
          retry.state === "pending" &&
          retry.display_name === input.participant.display_name &&
          retry.signing_public_key === input.participant.signing_public_key &&
          retry.encryption_public_key === input.participant.encryption_public_key &&
          retry.agent_adapter === input.participant.agent_adapter
        ) {
          return { status: 200 as const, participant: retry, room };
        }
        return { status: 404 as const, error: "Room invitation unavailable" };
      }
      if (invite.seats_remaining <= 0) {
        return { status: 404 as const, error: "Room invitation unavailable" };
      }
      const comparable = input.participant.display_name.normalize("NFC").toLowerCase();
      if (participants.some((participant) => participant.display_name.normalize("NFC").toLowerCase() === comparable)) {
        return { status: 409 as const, error: "Room display name unavailable" };
      }
      if (participants.some((participant) =>
        participant.signing_public_key === input.participant.signing_public_key ||
        participant.encryption_public_key === input.participant.encryption_public_key)) {
        return { status: 409 as const, error: "Room public key unavailable" };
      }
      const participant = input.participant;
      await txn.put(participantKey(participant.participant_id), participant);
      await txn.put(inviteKey(invite.invite_id), { ...invite, seats_remaining: invite.seats_remaining - 1 });
      const nextRoom = { ...room, idle_deadline: Math.min(room.expires_at, now + ROOM_IDLE_TTL_MS) };
      await txn.put(ROOM_KEY, nextRoom);
      await this.schedule(txn, nextRoom, [...participants, participant], now);
      return { status: 201 as const, participant, room: nextRoom };
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(RoomMutationResponse.parse({
      ...(await this.snapshot(result.room)), participant: publicParticipant(result.participant),
    }), { status: result.status });
  }

  private async mutate(
    room: RoomRecordType,
    actor: RoomParticipantRecordType,
    action: RoomActionType,
    targetId: string | undefined,
    now: number,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      let current = await txn.get<RoomRecordType>(ROOM_KEY);
      if (!current || current.state === "closed") return { status: 401, body: { error: "Room unavailable" } };
      let participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
      let currentActor = participants.find((participant) => participant.participant_id === actor.participant_id);
      if (!currentActor) return { status: 401, body: { error: "Room capability unauthorized" } };

      const moderator = currentActor.participant_id === current.moderator_participant_id;
      const moderationTarget = targetId
        ? participants.find((participant) => participant.participant_id === targetId)
        : undefined;

      if (action === "admit" || action === "deny") {
        if (!moderator) return { status: 403, body: { error: "host capability required" } };
        if (current.state !== "waiting" || !moderationTarget || moderationTarget.state !== "pending") {
          return { status: 409, body: { error: "participant is not pending" } };
        }
        if (action === "deny") {
          await txn.delete(participantKey(moderationTarget.participant_id));
          participants = participants.filter((participant) => participant.participant_id !== moderationTarget.participant_id);
          const failures = (await txn.get<number>(FAILED_JOINS_KEY) ?? 0) + 1;
          await txn.put(FAILED_JOINS_KEY, failures);
          if (failures >= ROOM_MAX_FAILED_JOINS) {
            const closed = await this.close(txn, current, "abuse_limit", now);
            return { status: 200, body: closed.body, outbounds: closed.outbounds };
          }
        } else {
          const admitted = { ...moderationTarget, state: "admitted" as const, admitted_at: now, last_seen_at: now };
          await txn.put(participantKey(admitted.participant_id), admitted);
          participants = participants.map((participant) =>
            participant.participant_id === admitted.participant_id ? admitted : participant);
          if (participants.filter((participant) => participant.state === "admitted").length === current.expected_participants) {
            current = await this.lock(txn, current, participants, now);
          }
        }
      } else if (action === "lock") {
        if (!moderator) return { status: 403, body: { error: "host capability required" } };
        if (current.state !== "waiting") return { status: 409, body: { error: "Room cannot lock" } };
        if (participants.filter((participant) => participant.state === "admitted").length < 2) {
          return { status: 409, body: { error: "Room needs another admitted participant" } };
        }
        current = await this.lock(txn, current, participants, now);
        participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
      } else if (action === "confirm") {
        if (current.state !== "verifying" || currentActor.state !== "admitted") {
          return { status: 409, body: { error: "Room is not awaiting this confirmation" } };
        }
        const verified = {
          ...currentActor, state: "verified" as const, verified_epoch: current.membership_epoch, last_seen_at: now,
        };
        await txn.put(participantKey(verified.participant_id), verified);
        participants = participants.map((participant) =>
          participant.participant_id === verified.participant_id ? verified : participant);
        currentActor = verified;
        const lockedParticipants = participants.filter((participant) => participant.state !== "departed");
        if (lockedParticipants.every((participant) => participant.state === "verified")) {
          participants = participants.map((participant) => ({ ...participant, state: "ready" as const }));
          for (const participant of participants) await txn.put(participantKey(participant.participant_id), participant);
          current = { ...current, state: "active", verification_deadline: undefined };
          currentActor = participants.find((participant) => participant.participant_id === actor.participant_id)!;
          await txn.put(ROOM_KEY, current);
        }
      } else if (action === "reject") {
        if (current.state !== "verifying" || !["admitted", "verified"].includes(currentActor.state)) {
          return { status: 409, body: { error: "Room is not awaiting this confirmation" } };
        }
        const closed = await this.close(txn, current, "verification_failed", now);
        return { status: 200, body: closed.body, outbounds: closed.outbounds };
      } else if (action === "pause" || action === "resume") {
        const expected = action === "pause" ? "ready" : "paused";
        if (current.state !== "active" || currentActor.state !== expected) {
          return { status: 409, body: { error: `participant cannot ${action}` } };
        }
        currentActor = { ...currentActor, state: action === "pause" ? "paused" : "ready", last_seen_at: now };
        await txn.put(participantKey(currentActor.participant_id), currentActor);
        participants = participants.map((participant) =>
          participant.participant_id === currentActor!.participant_id ? currentActor! : participant);
      } else if (action === "heartbeat") {
        if (currentActor.state === "pending" || currentActor.state === "departed") {
          return { status: 409, body: { error: "participant cannot heartbeat" } };
        }
        currentActor = { ...currentActor, last_seen_at: now };
        await txn.put(participantKey(currentActor.participant_id), currentActor);
        participants = participants.map((participant) =>
          participant.participant_id === currentActor!.participant_id ? currentActor! : participant);
      } else if (action === "leave") {
        if (moderator) {
          const closed = await this.close(txn, current, "host_left", now);
          return { status: 200, body: closed.body, outbounds: closed.outbounds };
        }
        if (current.state === "verifying") {
          const closed = await this.close(txn, current, "verification_failed", now);
          return { status: 200, body: closed.body, outbounds: closed.outbounds };
        }
        const outbounds = await this.terminateParticipantCalls(txn, currentActor.participant_id, "peer_left");
        currentActor = { ...currentActor, state: "departed" };
        await txn.put(participantKey(currentActor.participant_id), currentActor);
        participants = participants.map((participant) =>
          participant.participant_id === currentActor!.participant_id ? currentActor! : participant);
        const liveCount = participants.filter((participant) => participant.state !== "departed").length;
        if (current.state !== "waiting" && liveCount < 2) {
          const closed = await this.close(txn, current, "insufficient_participants", now);
          return {
            status: 200, body: closed.body, outbounds: [...outbounds, ...closed.outbounds],
          };
        }
        current = { ...current, idle_deadline: Math.min(current.expires_at, now + ROOM_IDLE_TTL_MS) };
        await txn.put(ROOM_KEY, current);
        await this.schedule(txn, current, participants, now);
        return {
          status: 200,
          body: RoomMutationResponse.parse({
            ...publicRoom(current, participants), participant: publicParticipant(currentActor),
          }),
          outbounds,
        };
      }

      current = { ...current, idle_deadline: Math.min(current.expires_at, now + ROOM_IDLE_TTL_MS) };
      await txn.put(ROOM_KEY, current);
      await this.schedule(txn, current, participants, now);
      return {
        status: 200,
        body: RoomMutationResponse.parse({
          ...publicRoom(current, participants), participant: publicParticipant(currentActor),
        }),
      };
    });
    this.dispatchRoomOutbounds(("outbounds" in result ? result.outbounds : undefined) ?? []);
    return { status: result.status, body: result.body };
  }

  private async lock(
    txn: DurableObjectTransaction,
    room: RoomRecordType,
    participants: RoomParticipantRecordType[],
    now: number,
  ): Promise<RoomRecordType> {
    const pending = participants.filter((participant) => participant.state === "pending");
    for (const participant of pending) await txn.delete(participantKey(participant.participant_id));
    const invites = await txn.list({ prefix: "invite:" });
    if (invites.size > 0) await txn.delete([...invites.keys()]);
    const next = {
      ...room,
      state: "verifying" as const,
      membership_epoch: room.membership_epoch + 1,
      verification_deadline: Math.min(room.expires_at, now + ROOM_VERIFICATION_TTL_MS),
    };
    await txn.put(ROOM_KEY, next);
    return next;
  }

  private async snapshot(room: RoomRecordType) {
    const participants = [...(await this.ctx.storage.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
    return publicRoom(room, participants);
  }

  private participantSocket(participantId: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`participant:${participantId}`)[0];
  }

  private sendRoomFrame(socket: WebSocket | undefined, frame: RoomSocketRelayFrameType): boolean {
    if (!socket) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private dispatchRoomOutbounds(outbounds: RoomOutbound[]): void {
    for (const outbound of outbounds) {
      this.sendRoomFrame(this.participantSocket(outbound.participant_id), outbound.frame);
    }
  }

  private sendRoomError(
    socket: WebSocket | undefined,
    code: RoomRelayCallErrorCodeType,
    callId?: string,
  ): void {
    this.sendRoomFrame(socket, {
      type: "room_call_error",
      code,
      ...(callId ? { call_id: callId as `rc_${string}` } : {}),
    });
  }

  private socketAttachment(socket: WebSocket): RoomSocketAttachment | undefined {
    const attachment = socket.deserializeAttachment() as RoomSocketAttachment | null;
    return attachment?.kind === "room" ? attachment : undefined;
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.socketAttachment(socket);
    if (!attachment || typeof message !== "string" ||
      new TextEncoder().encode(message).byteLength > ROOM_MAX_CALL_WIRE_BYTES) {
      this.sendRoomError(socket, "protocol_error");
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(message);
    } catch {
      this.sendRoomError(socket, "protocol_error");
      return;
    }
    const parsed = RoomSocketClientFrame.safeParse(parsedJson);
    if (!parsed.success) {
      this.sendRoomError(socket, "protocol_error");
      return;
    }
    const now = Date.now();
    const room = await this.ctx.storage.get<RoomRecordType>(ROOM_KEY);
    const active = room && await this.enforceDeadlines(room, now);
    if (!active || active.state !== "active" ||
      attachment.principal.room_id !== active.room_id ||
      attachment.principal.membership_epoch !== active.membership_epoch) {
      this.sendRoomError(socket, room && now >= room.expires_at ? "room_expired" : "room_inactive");
      return;
    }
    const actor = await this.ctx.storage.get<RoomParticipantRecordType>(
      participantKey(attachment.principal.participant_id),
    );
    if (!actor || actor.state === "departed") {
      this.sendRoomError(socket, "room_inactive");
      return;
    }
    await this.touchParticipant(actor, active, now);

    const frame = parsed.data;
    if (frame.type === "room_call_submit") {
      await this.submitRoomCall(socket, attachment.principal, frame, now);
    } else if (frame.type === "room_call_cancel") {
      await this.cancelRoomCall(socket, attachment.principal, frame.call_id);
    } else {
      await this.advanceRoomCall(socket, attachment.principal, frame);
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.noteSocketLoss(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.noteSocketLoss(socket);
  }

  private async noteSocketLoss(socket: WebSocket): Promise<void> {
    const attachment = this.socketAttachment(socket);
    if (!attachment) return;
    const now = Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const room = await txn.get<RoomRecordType>(ROOM_KEY);
      const participant = await txn.get<RoomParticipantRecordType>(
        participantKey(attachment.principal.participant_id),
      );
      if (!room || !participant || participant.state === "departed") return;
      await txn.put(participantKey(participant.participant_id), { ...participant, last_seen_at: now });
      await this.schedule(txn, room, [
        ...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values(),
      ], now);
    });
  }

  private async touchParticipant(
    participant: RoomParticipantRecordType,
    room: RoomRecordType,
    now: number,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(participantKey(participant.participant_id), { ...participant, last_seen_at: now });
      const nextRoom = { ...room, idle_deadline: Math.min(room.expires_at, now + ROOM_IDLE_TTL_MS) };
      await txn.put(ROOM_KEY, nextRoom);
      const participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
      await this.schedule(txn, nextRoom, participants, now);
    });
  }

  private async submitRoomCall(
    senderSocket: WebSocket,
    principal: RoomCallPrincipal,
    frame: RoomCallSubmitType,
    now: number,
  ): Promise<void> {
    const recipientSocket = this.participantSocket(frame.to_participant_id);
    const decision = await this.ctx.storage.transaction(async (txn) => {
      const room = await txn.get<RoomRecordType>(ROOM_KEY);
      const sender = await txn.get<RoomParticipantRecordType>(participantKey(principal.participant_id));
      if (!room || room.state !== "active" || room.membership_epoch !== principal.membership_epoch || !sender) {
        return { kind: "error" as const, code: "room_inactive" as const };
      }
      const previousCallId = await txn.get<string>(idempotencyKey(principal.participant_id, frame.idempotency_key));
      if (previousCallId) {
        const previous = await txn.get<StoredRoomCall>(callKey(previousCallId));
        if (!previous || previous.call_id !== frame.call_id ||
          previous.request_digest !== frame.request_digest ||
          previous.to_participant_id !== frame.to_participant_id) {
          return { kind: "error" as const, code: "protocol_error" as const };
        }
        return { kind: "duplicate" as const, call: previous };
      }
      if (sender.state === "paused") return { kind: "error" as const, code: "paused" as const };
      if (sender.state !== "ready") return { kind: "error" as const, code: "room_inactive" as const };
      if (frame.to_participant_id === principal.participant_id) {
        return { kind: "error" as const, code: "self_target" as const };
      }
      const recipient = await txn.get<RoomParticipantRecordType>(participantKey(frame.to_participant_id));
      if (!recipient || recipient.state === "departed") {
        return { kind: "error" as const, code: "unknown_target" as const };
      }
      if (recipient.state === "paused") return { kind: "error" as const, code: "paused" as const };
      if (recipient.state !== "ready" || !recipientSocket) {
        return { kind: "error" as const, code: "offline" as const };
      }

      if (await txn.get(callKey(frame.call_id))) {
        return { kind: "error" as const, code: "protocol_error" as const };
      }
      const calls = [...(await txn.list<StoredRoomCall>({ prefix: CALL_RECORD_PREFIX })).values()];
      if (calls.some((call) => call.to_participant_id === frame.to_participant_id && !terminalCall(call.state))) {
        return { kind: "error" as const, code: "busy" as const };
      }
      if (sender.calls_charged >= ROOM_MAX_CALLS_PER_PARTICIPANT) {
        return { kind: "error" as const, code: "limit" as const };
      }
      const lastSubmission = await txn.get<number>(lastSubmissionKey(principal.participant_id));
      if (lastSubmission !== undefined && now - lastSubmission < ROOM_SUBMISSION_COOLDOWN_MS) {
        return { kind: "error" as const, code: "cooldown" as const };
      }
      const expiresAt = Math.min(room.expires_at, now + ROOM_AGENT_TIMEOUT_MS);
      const lifecycle = beginAuthorizedCall(principal, expiresAt);
      const call: StoredRoomCall = {
        principal: lifecycle.principal as RoomCallPrincipal,
        call_id: frame.call_id,
        idempotency_key: frame.idempotency_key,
        room_id: room.room_id,
        membership_epoch: room.membership_epoch,
        from_participant_id: principal.participant_id,
        to_participant_id: frame.to_participant_id,
        state: lifecycle.phase,
        request_digest: frame.request_digest,
        encrypted_request: frame.encrypted_request,
        created_at: now,
        expires_at: lifecycle.deadline,
      };
      await txn.put(callKey(call.call_id), call);
      await txn.put(idempotencyKey(principal.participant_id, frame.idempotency_key), call.call_id);
      await txn.put(lastSubmissionKey(principal.participant_id), now);
      await txn.put(participantKey(sender.participant_id), { ...sender, calls_charged: sender.calls_charged + 1 });
      const participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
      await this.schedule(txn, room, participants, now);
      return { kind: "accepted" as const, call };
    });

    if (decision.kind === "error") {
      this.sendRoomError(senderSocket, decision.code, frame.call_id);
      return;
    }
    if (decision.kind === "duplicate") {
      if (terminalCall(decision.call.state)) {
        this.sendRoomFrame(senderSocket, {
          type: "room_call_result",
          call_id: decision.call.call_id as `rc_${string}`,
          terminal: decision.call.terminal ?? (decision.call.state as "completed" | "failed" | "canceled" | "expired"),
          replayed: true,
        });
      } else {
        this.sendRoomFrame(senderSocket, {
          type: "room_call_status",
          call_id: decision.call.call_id as `rc_${string}`,
          state: decision.call.state as "submitted" | "accepted" | "working",
        });
      }
      return;
    }

    const call = decision.call;
    this.sendRoomFrame(senderSocket, {
      type: "room_call_status", call_id: frame.call_id, state: "submitted",
    });
    const delivered = this.sendRoomFrame(recipientSocket, {
      type: "room_incoming_call",
      room_id: principal.room_id,
      membership_epoch: principal.membership_epoch,
      from_participant_id: principal.participant_id,
      to_participant_id: frame.to_participant_id,
      call_id: frame.call_id,
      request_digest: frame.request_digest,
      encrypted_request: frame.encrypted_request,
      expires_at: call.expires_at,
    });
    if (!delivered) {
      await this.finishCall(call, "failed");
      this.sendRoomError(senderSocket, "offline", frame.call_id);
      return;
    }
  }

  private async advanceRoomCall(
    socket: WebSocket,
    principal: RoomCallPrincipal,
    frame: Exclude<RoomSocketClientFrameType, RoomCallSubmitType | { type: "room_call_cancel" }>,
  ): Promise<void> {
    const call = await this.ctx.storage.get<StoredRoomCall>(callKey(frame.call_id));
    if (!call || call.to_participant_id !== principal.participant_id) {
      this.sendRoomError(socket, "protocol_error", frame.call_id);
      return;
    }
    if (terminalCall(call.state)) {
      if (frame.type === "room_call_canceled" && call.state === "canceled") return;
      this.sendRoomError(socket, "protocol_error", frame.call_id);
      return;
    }
    const callerSocket = this.participantSocket(call.from_participant_id);
    if (frame.type === "room_call_accepted" || frame.type === "room_call_started") {
      const requested = frame.type === "room_call_accepted" ? "accepted" : "working";
      if (requested === "working" && call.state !== "accepted") {
        this.sendRoomError(socket, "protocol_error", frame.call_id);
        return;
      }
      const current = call.state as "submitted" | "accepted" | "working";
      const next = advanceAuthorizedCall(roomCallLifecycle(call), requested).phase;
      if (next === current) return;
      const { encrypted_request: _request, ...withoutRequest } = call;
      await this.ctx.storage.put(callKey(call.call_id), { ...withoutRequest, state: next });
      this.sendRoomFrame(callerSocket, {
        type: "room_call_status", call_id: frame.call_id, state: next,
      });
      return;
    }
    if (frame.type === "room_call_outcome") {
      const terminal = frame.terminal;
      if (!(await this.finishCall(call, terminal))) {
        this.sendRoomError(socket, "protocol_error", frame.call_id);
        return;
      }
      this.sendRoomFrame(callerSocket, {
        type: "room_call_result",
        call_id: frame.call_id,
        terminal,
        ...(frame.encrypted_outcome ? { encrypted_outcome: frame.encrypted_outcome } : {}),
      });
      return;
    }
    if (frame.type === "room_call_canceled") {
      this.sendRoomError(socket, "protocol_error", frame.call_id);
    }
  }

  private async cancelRoomCall(
    socket: WebSocket,
    principal: RoomCallPrincipal,
    callId: string,
  ): Promise<void> {
    const call = await this.ctx.storage.get<StoredRoomCall>(callKey(callId));
    if (!call || call.from_participant_id !== principal.participant_id || terminalCall(call.state)) {
      this.sendRoomError(socket, "protocol_error", callId);
      return;
    }
    if (!(await this.finishCall(call, "canceled"))) {
      this.sendRoomError(socket, "protocol_error", callId);
      return;
    }
    this.sendRoomFrame(this.participantSocket(call.to_participant_id), {
      type: "room_cancel_call", call_id: callId as `rc_${string}`,
    });
    this.sendRoomFrame(socket, {
      type: "room_call_result", call_id: callId as `rc_${string}`, terminal: "canceled",
    });
  }

  private async finishCall(
    call: StoredRoomCall,
    terminal: "completed" | "failed" | "canceled" | "expired",
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<StoredRoomCall>(callKey(call.call_id));
      if (!current || terminalCall(current.state)) return false;
      const terminated = terminateAuthorizedCall(roomCallLifecycle(current), terminal);
      const { encrypted_request: _request, ...metadata } = current;
      await txn.put(callKey(current.call_id), {
        ...metadata, state: terminated.terminal!, terminal: terminated.terminal!,
      });
      return true;
    });
  }

  private async terminateParticipantCalls(
    txn: DurableObjectTransaction,
    participantId: string,
    code: "peer_left",
  ): Promise<RoomOutbound[]> {
    const outbounds: RoomOutbound[] = [];
    const calls = await txn.list<StoredRoomCall>({ prefix: CALL_RECORD_PREFIX });
    for (const call of calls.values()) {
      if (terminalCall(call.state) ||
        (call.from_participant_id !== participantId && call.to_participant_id !== participantId)) continue;
      if (call.to_participant_id === participantId) {
        outbounds.push({
          participant_id: call.from_participant_id,
          frame: { type: "room_call_error", code, call_id: call.call_id as `rc_${string}` },
        });
      }
      outbounds.push({
        participant_id: call.to_participant_id,
        frame: { type: "room_cancel_call", call_id: call.call_id as `rc_${string}` },
      });
      const terminated = terminateAuthorizedCall(roomCallLifecycle(call), "failed");
      const { encrypted_request: _request, ...metadata } = call;
      await txn.put(callKey(call.call_id), {
        ...metadata, state: terminated.terminal!, terminal: terminated.terminal!,
      });
    }
    return outbounds;
  }

  private async expireCalls(now: number): Promise<void> {
    const outbounds = await this.ctx.storage.transaction(async (txn) => {
      const pending: RoomOutbound[] = [];
      const calls = await txn.list<StoredRoomCall>({ prefix: CALL_RECORD_PREFIX });
      for (const call of calls.values()) {
        const expired = expireAuthorizedCall(roomCallLifecycle(call), now);
        if (!expired || terminalCall(call.state)) continue;
        pending.push({
          participant_id: call.from_participant_id,
          frame: { type: "room_call_result", call_id: call.call_id as `rc_${string}`, terminal: "expired" },
        });
        pending.push({
          participant_id: call.to_participant_id,
          frame: { type: "room_cancel_call", call_id: call.call_id as `rc_${string}` },
        });
        const { encrypted_request: _request, ...metadata } = call;
        await txn.put(callKey(call.call_id), {
          ...metadata, state: expired.terminal!, terminal: expired.terminal!,
        });
      }
      return pending;
    });
    this.dispatchRoomOutbounds(outbounds);
  }

  private async terminateAllCalls(
    txn: DurableObjectTransaction,
    code: "peer_left" | "room_expired",
  ): Promise<RoomOutbound[]> {
    const outbounds: RoomOutbound[] = [];
    const calls = await txn.list<StoredRoomCall>({ prefix: CALL_RECORD_PREFIX });
    for (const call of calls.values()) {
      if (terminalCall(call.state)) continue;
      outbounds.push({
        participant_id: call.from_participant_id,
        frame: { type: "room_call_error", code, call_id: call.call_id as `rc_${string}` },
      }, {
        participant_id: call.to_participant_id,
        frame: { type: "room_cancel_call", call_id: call.call_id as `rc_${string}` },
      });
    }
    return outbounds;
  }

  private async close(
    txn: DurableObjectTransaction,
    room: RoomRecordType,
    reason: RoomCloseReasonType,
    now: number,
  ) {
    const closedRoom: RoomRecordType = {
      ...room, state: "closed", close_reason: reason, verification_deadline: undefined,
    };
    const outbounds = await this.terminateAllCalls(txn, reason === "expired" ? "room_expired" : "peer_left");
    const keys = [...(await txn.list()).keys()];
    if (keys.length > 0) await txn.delete(keys);
    const cleanupAt = Math.max(now, room.expires_at + 3_600_000);
    await txn.put<ClosedTombstone>(CLOSED_KEY, { close_reason: reason, cleanup_at: cleanupAt });
    await txn.setAlarm(cleanupAt);
    return { body: publicRoom(closedRoom, []), outbounds };
  }

  private async enforceDeadlines(room: RoomRecordType, now: number): Promise<RoomRecordType | undefined> {
    if (room.state === "waiting" && now >= room.invite_deadline) {
      const outbounds = await this.ctx.storage.transaction(async (txn) => {
        const participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
        const timedOut = participants.filter((participant) => participant.state === "pending").length;
        const failures = (await txn.get<number>(FAILED_JOINS_KEY) ?? 0) + timedOut;
        const closed = await this.close(
          txn,
          room,
          failures >= ROOM_MAX_FAILED_JOINS ? "abuse_limit" : "insufficient_participants",
          now,
        );
        return closed.outbounds;
      });
      this.dispatchRoomOutbounds(outbounds);
      return undefined;
    }
    const participants = [...(await this.ctx.storage.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
    let reason: RoomCloseReasonType | undefined;
    if (now >= room.expires_at) reason = "expired";
    else if (now >= room.idle_deadline) reason = "idle";
    else if (room.state === "verifying" && room.verification_deadline !== undefined && now >= room.verification_deadline) {
      reason = "verification_failed";
    } else {
      const live = participants.filter((participant) => participant.state !== "pending" && participant.state !== "departed");
      const stale = live.filter((participant) => now - participant.last_seen_at >= ROOM_HEARTBEAT_GRACE_MS);
      if (stale.some((participant) => participant.participant_id === room.moderator_participant_id)) reason = "host_left";
      else if (stale.length > 0) {
        if (room.state === "verifying") {
          reason = "verification_failed";
        } else {
          const outbounds = await this.ctx.storage.transaction(async (txn) => {
            const pending: RoomOutbound[] = [];
            for (const participant of stale) {
              pending.push(...await this.terminateParticipantCalls(txn, participant.participant_id, "peer_left"));
              await txn.put(participantKey(participant.participant_id), {
                ...participant, state: "departed",
              } satisfies RoomParticipantRecordType);
            }
            return pending;
          });
          this.dispatchRoomOutbounds(outbounds);
          if (room.state !== "waiting" && live.length - stale.length < 2) reason = "insufficient_participants";
        }
      }
    }
    if (!reason) return room;
    const closed = await this.ctx.storage.transaction(async (txn) => this.close(txn, room, reason!, now));
    this.dispatchRoomOutbounds(closed.outbounds);
    return undefined;
  }

  private async schedule(
    txn: DurableObjectTransaction,
    room: RoomRecordType,
    participants: RoomParticipantRecordType[],
    now: number,
  ) {
    const liveHeartbeats = participants
      .filter((participant) => participant.state !== "pending" && participant.state !== "departed")
      .map((participant) => participant.last_seen_at + ROOM_HEARTBEAT_GRACE_MS);
    const calls = [...(await txn.list<StoredRoomCall>({ prefix: CALL_RECORD_PREFIX })).values()];
    const callDeadlines = calls.filter((call) => !terminalCall(call.state)).map((call) => call.expires_at);
    const deadlines = [room.expires_at, room.idle_deadline, ...liveHeartbeats, ...callDeadlines];
    if (room.state === "waiting") deadlines.push(room.invite_deadline);
    if (room.verification_deadline !== undefined) deadlines.push(room.verification_deadline);
    await txn.setAlarm(Math.max(now + 1, Math.min(...deadlines)));
  }

  override async alarm(): Promise<void> {
    const closed = await this.ctx.storage.get<ClosedTombstone>(CLOSED_KEY);
    if (closed) {
      if (Date.now() >= closed.cleanup_at) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm(closed.cleanup_at);
      return;
    }
    const room = await this.ctx.storage.get<RoomRecordType>(ROOM_KEY);
    if (!room) return;
    const now = Date.now();
    const active = await this.enforceDeadlines(room, now);
    if (!active) return;
    await this.expireCalls(now);
    const participants = [...(await this.ctx.storage.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
    await this.ctx.storage.transaction((txn) => this.schedule(txn, active, participants, now));
  }
}
