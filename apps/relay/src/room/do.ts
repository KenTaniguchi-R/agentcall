import { DurableObject } from "cloudflare:workers";
import {
  ROOM_ABSOLUTE_TTL_MS, ROOM_HEARTBEAT_GRACE_MS, ROOM_IDLE_TTL_MS,
  ROOM_INVITE_TTL_MS, ROOM_MAX_FAILED_JOINS, ROOM_VERIFICATION_TTL_MS,
  RoomAction, RoomMutationResponse, RoomSnapshot,
  type RoomActionType,
  type RoomCloseReasonType, type RoomInviteRecordType, type RoomParticipantRecordType,
  type RoomRecordType,
} from "@benree/agentcall-shared";
import { constantTimeEqual } from "../auth.js";

type ClosedTombstone = { close_reason: RoomCloseReasonType; cleanup_at: number };
type InternalCreate = {
  room: RoomRecordType;
  host: RoomParticipantRecordType;
  invites: RoomInviteRecordType[];
};
type InternalJoin = {
  invite_id: string;
  invite_hash: string;
  participant: RoomParticipantRecordType;
};

const ROOM_KEY = "room";
const CLOSED_KEY = "closed";
const FAILED_JOINS_KEY = "meta:failed-joins";
const participantKey = (id: string) => `participant:${id}`;
const inviteKey = (id: string) => `invite:${id}`;

function publicParticipant(participant: RoomParticipantRecordType) {
  const { credential_hash: _credentialHash, ...publicRecord } = participant;
  return publicRecord;
}

function publicRoom(room: RoomRecordType, participants: RoomParticipantRecordType[]) {
  return {
    room,
    participants: participants.sort((left, right) => left.seat - right.seat).map(publicParticipant),
  };
}

export class RoomDO extends DurableObject {
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
      for (const invite of input.invites) await txn.put(inviteKey(invite.invite_id), invite);
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
      if (invite.participant_id) {
        const existing = await txn.get<RoomParticipantRecordType>(participantKey(invite.participant_id));
        if (
          existing?.state === "pending" &&
          constantTimeEqual(existing.credential_hash, input.participant.credential_hash) &&
          existing.display_name === input.participant.display_name &&
          existing.signing_public_key === input.participant.signing_public_key &&
          existing.encryption_public_key === input.participant.encryption_public_key &&
          existing.agent_adapter === input.participant.agent_adapter
        ) {
          return { status: 200 as const, participant: existing, room };
        }
        return { status: 404 as const, error: "Room invitation unavailable" };
      }
      const participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
      const comparable = input.participant.display_name.normalize("NFC").toLowerCase();
      if (participants.some((participant) => participant.display_name.normalize("NFC").toLowerCase() === comparable)) {
        return { status: 409 as const, error: "Room display name unavailable" };
      }
      if (participants.some((participant) =>
        participant.signing_public_key === input.participant.signing_public_key ||
        participant.encryption_public_key === input.participant.encryption_public_key)) {
        return { status: 409 as const, error: "Room public key unavailable" };
      }
      const participant = { ...input.participant, seat: invite.seat };
      await txn.put(participantKey(participant.participant_id), participant);
      await txn.put(inviteKey(invite.invite_id), {
        ...invite, consumed_at: now, participant_id: participant.participant_id,
      });
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
    return this.ctx.storage.transaction(async (txn) => {
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
            return { status: 200, body: await this.close(txn, current, "abuse_limit", now) };
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
        return { status: 200, body: await this.close(txn, current, "verification_failed", now) };
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
        if (moderator) return { status: 200, body: await this.close(txn, current, "host_left", now) };
        if (current.state === "verifying") {
          return { status: 200, body: await this.close(txn, current, "verification_failed", now) };
        }
        currentActor = { ...currentActor, state: "departed" };
        await txn.put(participantKey(currentActor.participant_id), currentActor);
        participants = participants.map((participant) =>
          participant.participant_id === currentActor!.participant_id ? currentActor! : participant);
        const liveCount = participants.filter((participant) => participant.state !== "departed").length;
        if (current.state !== "waiting" && liveCount < 2) {
          return { status: 200, body: await this.close(txn, current, "insufficient_participants", now) };
        }
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

  private async close(
    txn: DurableObjectTransaction,
    room: RoomRecordType,
    reason: RoomCloseReasonType,
    now: number,
  ) {
    const closedRoom: RoomRecordType = {
      ...room, state: "closed", close_reason: reason, verification_deadline: undefined,
    };
    const keys = [...(await txn.list()).keys()];
    if (keys.length > 0) await txn.delete(keys);
    const cleanupAt = Math.max(now, room.expires_at + 3_600_000);
    await txn.put<ClosedTombstone>(CLOSED_KEY, { close_reason: reason, cleanup_at: cleanupAt });
    await txn.setAlarm(cleanupAt);
    return publicRoom(closedRoom, []);
  }

  private async enforceDeadlines(room: RoomRecordType, now: number): Promise<RoomRecordType | undefined> {
    if (room.state === "waiting" && now >= room.invite_deadline) {
      await this.ctx.storage.transaction(async (txn) => {
        const participants = [...(await txn.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
        const timedOut = participants.filter((participant) => participant.state === "pending").length;
        const failures = (await txn.get<number>(FAILED_JOINS_KEY) ?? 0) + timedOut;
        await this.close(
          txn,
          room,
          failures >= ROOM_MAX_FAILED_JOINS ? "abuse_limit" : "insufficient_participants",
          now,
        );
      });
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
          for (const participant of stale) {
            await this.ctx.storage.put(participantKey(participant.participant_id), {
              ...participant, state: "departed",
            } satisfies RoomParticipantRecordType);
          }
          if (room.state !== "waiting" && live.length - stale.length < 2) reason = "insufficient_participants";
        }
      }
    }
    if (!reason) return room;
    await this.ctx.storage.transaction(async (txn) => this.close(txn, room, reason!, now));
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
    const deadlines = [room.expires_at, room.idle_deadline, ...liveHeartbeats];
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
    const active = await this.enforceDeadlines(room, Date.now());
    if (!active) return;
    const participants = [...(await this.ctx.storage.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()];
    await this.ctx.storage.transaction((txn) => this.schedule(txn, active, participants, Date.now()));
  }
}
