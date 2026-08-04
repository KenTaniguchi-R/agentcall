import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ROOM_HEARTBEAT_GRACE_MS,
  type RoomParticipantRecordType, type RoomRecordType, type RoomSocketRelayFrameType,
} from "@benree/agentcall-shared";
import type { RoomDO } from "../src/room/do.js";
import { registerHandle, wsAuth } from "./helpers.js";
import { createTestRoom, joinTestRoom, mutateTestRoom, roomAuth } from "./room-helpers.js";

type Member = { credential: string; participant_id: string };
type FrameWaiter = {
  resolve: (frame: RoomSocketRelayFrameType) => void;
  reject: (error: Error) => void;
};
const inboxes = new WeakMap<WebSocket, { frames: RoomSocketRelayFrameType[]; waiters: FrameWaiter[] }>();

async function activeRoom(seats: 2 | 3 | 6): Promise<{ room_id: string; members: Member[] }> {
  const created = await createTestRoom(seats);
  const members: Member[] = [{
    credential: created.credential,
    participant_id: created.room.moderator_participant_id,
  }];
  const labels = ["C", "F", "I", "L", "O"];
  for (let index = 0; index < seats - 1; index++) {
    const joined = await joinTestRoom(created.invites[index]!.invite, `Member ${index + 2}`, labels[index]!);
    expect(joined.status).toBe(201);
    members.push({
      credential: joined.body.credential,
      participant_id: joined.body.participant.participant_id,
    });
    await mutateTestRoom(created.credential, "admit", {
      participant_id: joined.body.participant.participant_id,
    });
  }
  for (const member of members) await mutateTestRoom(member.credential, "confirm");
  return { room_id: created.room.room_id, members };
}

async function openRoomWs(credential: string): Promise<WebSocket> {
  const response = await SELF.fetch("https://relay.test/v1/room/ws", {
    headers: { Upgrade: "websocket", ...roomAuth(credential) },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const inbox = { frames: [] as RoomSocketRelayFrameType[], waiters: [] as FrameWaiter[] };
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as RoomSocketRelayFrameType;
    const waiter = inbox.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else inbox.frames.push(frame);
  });
  return socket;
}

function nextRoomFrame(socket: WebSocket, timeoutMs = 2_000): Promise<RoomSocketRelayFrameType> {
  const inbox = inboxes.get(socket);
  if (!inbox) return Promise.reject(new Error("Room socket has no inbox"));
  const queued = inbox.frames.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const waiter: FrameWaiter = {
      resolve: (frame) => {
        clearTimeout(timeout);
        resolve(frame);
      },
      reject,
    };
    const timeout = setTimeout(() => {
      const index = inbox.waiters.indexOf(waiter);
      if (index >= 0) inbox.waiters.splice(index, 1);
      reject(new Error("Room frame timeout"));
    }, timeoutMs);
    inbox.waiters.push(waiter);
  });
}

function noRoomFrame(socket: WebSocket, timeoutMs = 100): Promise<void> {
  const inbox = inboxes.get(socket);
  if (!inbox) return Promise.reject(new Error("Room socket has no inbox"));
  if (inbox.frames.length > 0) return Promise.reject(new Error("unexpected Room fan-out"));
  return new Promise((resolve, reject) => {
    const waiter: FrameWaiter = {
      resolve: () => {
        clearTimeout(timeout);
        reject(new Error("unexpected Room fan-out"));
      },
      reject,
    };
    const timeout = setTimeout(() => {
      const index = inbox.waiters.indexOf(waiter);
      if (index >= 0) inbox.waiters.splice(index, 1);
      resolve();
    }, timeoutMs);
    inbox.waiters.push(waiter);
  });
}

function submit(callLetter: string, target: string, digestLetter = "d") {
  return {
    type: "room_call_submit" as const,
    call_id: `rc_${callLetter.repeat(22)}`,
    idempotency_key: callLetter.repeat(16),
    to_participant_id: target,
    request_digest: digestLetter.repeat(64),
    encrypted_request: "QQ",
  };
}

describe("targeted Room call routing", () => {
  it("keeps Team and Room socket credentials disjoint", async () => {
    const handle = `room-ws-${crypto.randomUUID().slice(0, 8)}`;
    const durableToken = await registerHandle(handle);
    expect((await SELF.fetch("https://relay.test/v1/room/ws", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${durableToken}` },
    })).status).toBe(401);

    const room = await activeRoom(2);
    expect((await SELF.fetch("https://relay.test/v1/ws?role=listen", {
      headers: { Upgrade: "websocket", ...wsAuth(handle, room.members[0]!.credential) },
    })).status).toBe(401);
  });

  it("fails unverified, departed, paused-sender, and wrong-epoch principals closed", async () => {
    const waiting = await createTestRoom(2);
    const joined = await joinTestRoom(waiting.invites[0]!.invite, "Waiting peer", "C");
    await mutateTestRoom(waiting.credential, "admit", {
      participant_id: joined.body.participant.participant_id,
    });
    expect((await SELF.fetch("https://relay.test/v1/room/ws", {
      headers: { Upgrade: "websocket", ...roomAuth(waiting.credential) },
    })).status).toBe(409);

    const room = await activeRoom(3);
    await mutateTestRoom(room.members[2]!.credential, "leave");
    expect((await SELF.fetch("https://relay.test/v1/room/ws", {
      headers: { Upgrade: "websocket", ...roomAuth(room.members[2]!.credential) },
    })).status).toBe(401);

    const caller = await openRoomWs(room.members[0]!.credential);
    await openRoomWs(room.members[1]!.credential);
    await mutateTestRoom(room.members[0]!.credential, "pause");
    caller.send(JSON.stringify(submit("R", room.members[1]!.participant_id)));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "paused" });
    await mutateTestRoom(room.members[0]!.credential, "resume");

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(room.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const server = state.getWebSockets(`participant:${room.members[0]!.participant_id}`)[0]!;
      const attachment = server.deserializeAttachment() as {
        kind: "room";
        principal: { membership_epoch: number };
      };
      server.serializeAttachment({
        ...attachment,
        principal: { ...attachment.principal, membership_epoch: 2 },
      });
    });
    caller.send(JSON.stringify(submit("S", room.members[1]!.participant_id)));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "room_inactive" });
  });

  it("rejects an oversized Room frame before JSON parsing into protocol fields", async () => {
    const room = await activeRoom(2);
    const caller = await openRoomWs(room.members[0]!.credential);
    caller.send(JSON.stringify({ type: "room_call_submit", padding: "x".repeat(40_000) }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({
      type: "room_call_error", code: "protocol_error",
    });
  });

  it("routes an opaque lifecycle to exactly one attested recipient", async () => {
    const room = await activeRoom(2);
    const caller = await openRoomWs(room.members[0]!.credential);
    const recipient = await openRoomWs(room.members[1]!.credential);
    const request = submit("A", room.members[1]!.participant_id);
    caller.send(JSON.stringify(request));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({
      type: "room_call_status", call_id: request.call_id, state: "submitted",
    });
    await expect(nextRoomFrame(recipient)).resolves.toMatchObject({
      type: "room_incoming_call",
      room_id: room.room_id,
      membership_epoch: 1,
      from_participant_id: room.members[0]!.participant_id,
      to_participant_id: room.members[1]!.participant_id,
      call_id: request.call_id,
      encrypted_request: "QQ",
    });
    recipient.send(JSON.stringify({ type: "room_call_accepted", call_id: request.call_id }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ state: "accepted" });
    recipient.send(JSON.stringify({ type: "room_call_started", call_id: request.call_id }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ state: "working" });
    recipient.send(JSON.stringify({
      type: "room_call_outcome", call_id: request.call_id, terminal: "completed", encrypted_outcome: "Qg",
    }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({
      type: "room_call_result", terminal: "completed", encrypted_outcome: "Qg",
    });
    caller.send(JSON.stringify(request));
    await expect(nextRoomFrame(caller)).resolves.toEqual({
      type: "room_call_result", call_id: request.call_id, terminal: "completed", replayed: true,
    });
    await noRoomFrame(recipient);
  });

  it.each([3, 6] as const)("never fans a %i-person call out to non-target members", async (seats) => {
    const room = await activeRoom(seats);
    const sockets = await Promise.all(room.members.map((member) => openRoomWs(member.credential)));
    const request = submit(seats === 3 ? "B" : "C", room.members[1]!.participant_id);
    sockets[0]!.send(JSON.stringify(request));
    await nextRoomFrame(sockets[0]!);
    await expect(nextRoomFrame(sockets[1]!)).resolves.toMatchObject({
      type: "room_incoming_call", to_participant_id: room.members[1]!.participant_id,
    });
    await Promise.all(sockets.slice(2).map(noRoomFrame));
  });

  it("fails paused, offline, self, and unknown targets before admission", async () => {
    const room = await activeRoom(2);
    const caller = await openRoomWs(room.members[0]!.credential);
    await mutateTestRoom(room.members[1]!.credential, "pause");
    for (const [letter, target, code] of [
      ["D", room.members[1]!.participant_id, "paused"],
      ["E", room.members[0]!.participant_id, "self_target"],
      ["F", `rp_${"Z".repeat(22)}`, "unknown_target"],
    ] as const) {
      caller.send(JSON.stringify(submit(letter, target)));
      await expect(nextRoomFrame(caller)).resolves.toMatchObject({ type: "room_call_error", code });
    }
    await mutateTestRoom(room.members[1]!.credential, "resume");
    caller.send(JSON.stringify(submit("G", room.members[1]!.participant_id)));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ type: "room_call_error", code: "offline" });
  });

  it("deduplicates submissions and rejects digest substitution without redelivery", async () => {
    const room = await activeRoom(3);
    const caller = await openRoomWs(room.members[0]!.credential);
    const recipient = await openRoomWs(room.members[1]!.credential);
    const request = submit("H", room.members[1]!.participant_id);
    caller.send(JSON.stringify(request));
    await nextRoomFrame(caller);
    await nextRoomFrame(recipient);
    await mutateTestRoom(room.members[1]!.credential, "pause");
    caller.send(JSON.stringify(request));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ state: "submitted" });
    await noRoomFrame(recipient);
    await mutateTestRoom(room.members[1]!.credential, "resume");
    caller.send(JSON.stringify({ ...request, request_digest: "f".repeat(64) }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "protocol_error" });
    await noRoomFrame(recipient);
    caller.send(JSON.stringify({ ...request, to_participant_id: room.members[2]!.participant_id }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "protocol_error" });
    await noRoomFrame(recipient);
  });

  it("terminates a caller cancellation immediately and rejects late output", async () => {
    const room = await activeRoom(2);
    const caller = await openRoomWs(room.members[0]!.credential);
    const recipient = await openRoomWs(room.members[1]!.credential);
    const request = submit("O", room.members[1]!.participant_id);
    caller.send(JSON.stringify(request));
    await nextRoomFrame(caller);
    await nextRoomFrame(recipient);

    caller.send(JSON.stringify({ type: "room_call_cancel", call_id: request.call_id }));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({
      type: "room_call_result", terminal: "canceled",
    });
    await expect(nextRoomFrame(recipient)).resolves.toMatchObject({ type: "room_cancel_call" });
    recipient.send(JSON.stringify({
      type: "room_call_outcome", call_id: request.call_id, terminal: "completed", encrypted_outcome: "Qg",
    }));
    await expect(nextRoomFrame(recipient)).resolves.toMatchObject({ code: "protocol_error" });
  });

  it("rejects an unsolicited recipient cancellation acknowledgement", async () => {
    const room = await activeRoom(2);
    const caller = await openRoomWs(room.members[0]!.credential);
    const recipient = await openRoomWs(room.members[1]!.credential);
    const request = submit("T", room.members[1]!.participant_id);
    caller.send(JSON.stringify(request));
    await nextRoomFrame(caller);
    await nextRoomFrame(recipient);
    recipient.send(JSON.stringify({ type: "room_call_canceled", call_id: request.call_id }));
    await expect(nextRoomFrame(recipient)).resolves.toMatchObject({ code: "protocol_error" });
    await noRoomFrame(caller);
  });

  it("enforces cooldown, busy, and the five-attempt allowance at relay admission", async () => {
    const room = await activeRoom(3);
    const caller = await openRoomWs(room.members[0]!.credential);
    const firstRecipient = await openRoomWs(room.members[1]!.credential);
    const secondRecipient = await openRoomWs(room.members[2]!.credential);
    const first = submit("I", room.members[1]!.participant_id);
    caller.send(JSON.stringify(first));
    await nextRoomFrame(caller);
    await nextRoomFrame(firstRecipient);

    const peer = secondRecipient;
    peer.send(JSON.stringify(submit("J", room.members[1]!.participant_id)));
    await expect(nextRoomFrame(peer)).resolves.toMatchObject({ code: "busy" });

    caller.send(JSON.stringify(submit("K", room.members[2]!.participant_id)));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "cooldown" });

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(room.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const participant = await state.storage.get<RoomParticipantRecordType>(
        `participant:${room.members[0]!.participant_id}`,
      );
      await state.storage.put(`participant:${room.members[0]!.participant_id}`, {
        ...participant!, calls_charged: 5,
      });
      await state.storage.put(`call:last-submission:${room.members[0]!.participant_id}`, 0);
    });
    caller.send(JSON.stringify(submit("L", room.members[2]!.participant_id)));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "limit" });
  });

  it("cancels live work on peer departure and Room expiry, rejecting late outcomes", async () => {
    const room = await activeRoom(3);
    const caller = await openRoomWs(room.members[0]!.credential);
    const recipient = await openRoomWs(room.members[1]!.credential);
    await openRoomWs(room.members[2]!.credential);
    const request = submit("M", room.members[1]!.participant_id);
    caller.send(JSON.stringify(request));
    await nextRoomFrame(caller);
    await nextRoomFrame(recipient);
    await mutateTestRoom(room.members[1]!.credential, "leave");
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({ code: "peer_left" });
    await expect(nextRoomFrame(recipient)).resolves.toMatchObject({ type: "room_cancel_call" });
    caller.send(JSON.stringify(request));
    await expect(nextRoomFrame(caller)).resolves.toMatchObject({
      type: "room_call_result", terminal: "failed", replayed: true,
    });
    recipient.send(JSON.stringify({
      type: "room_call_outcome", call_id: request.call_id, terminal: "completed", encrypted_outcome: "Qg",
    }));
    await expect(nextRoomFrame(recipient)).resolves.toMatchObject({ code: "room_inactive" });

    const expiring = await activeRoom(2);
    const expiringCaller = await openRoomWs(expiring.members[0]!.credential);
    const expiringRecipient = await openRoomWs(expiring.members[1]!.credential);
    const expiringRequest = submit("N", expiring.members[1]!.participant_id);
    expiringCaller.send(JSON.stringify(expiringRequest));
    await nextRoomFrame(expiringCaller);
    await nextRoomFrame(expiringRecipient);
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(expiring.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const record = await state.storage.get<RoomRecordType>("room");
      await state.storage.put("room", { ...record!, expires_at: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    await runDurableObjectAlarm(stub);
    await expect(nextRoomFrame(expiringCaller)).resolves.toMatchObject({ code: "room_expired" });
    await expect(nextRoomFrame(expiringRecipient)).resolves.toMatchObject({ type: "room_cancel_call" });
    expiringRecipient.send(JSON.stringify({
      type: "room_call_outcome", call_id: expiringRequest.call_id,
      terminal: "completed", encrypted_outcome: "Qg",
    }));
    await expect(nextRoomFrame(expiringRecipient)).resolves.toMatchObject({ code: "room_inactive" });
  });

  it("cancels live work after heartbeat loss and host departure", async () => {
    const heartbeatRoom = await activeRoom(3);
    const heartbeatCaller = await openRoomWs(heartbeatRoom.members[0]!.credential);
    const heartbeatRecipient = await openRoomWs(heartbeatRoom.members[1]!.credential);
    await openRoomWs(heartbeatRoom.members[2]!.credential);
    const heartbeatCall = submit("P", heartbeatRoom.members[1]!.participant_id);
    heartbeatCaller.send(JSON.stringify(heartbeatCall));
    await nextRoomFrame(heartbeatCaller);
    await nextRoomFrame(heartbeatRecipient);
    const heartbeatStub = env.ROOM_DO.get(env.ROOM_DO.idFromName(heartbeatRoom.room_id));
    await runInDurableObject(heartbeatStub, async (_instance: RoomDO, state) => {
      const key = `participant:${heartbeatRoom.members[1]!.participant_id}`;
      const participant = await state.storage.get<RoomParticipantRecordType>(key);
      await state.storage.put(key, {
        ...participant!, last_seen_at: Date.now() - ROOM_HEARTBEAT_GRACE_MS - 1,
      });
    });
    await runDurableObjectAlarm(heartbeatStub);
    await expect(nextRoomFrame(heartbeatCaller)).resolves.toMatchObject({ code: "peer_left" });
    await expect(nextRoomFrame(heartbeatRecipient)).resolves.toMatchObject({ type: "room_cancel_call" });

    const hostRoom = await activeRoom(2);
    const host = await openRoomWs(hostRoom.members[0]!.credential);
    const guest = await openRoomWs(hostRoom.members[1]!.credential);
    const hostCall = submit("Q", hostRoom.members[1]!.participant_id);
    host.send(JSON.stringify(hostCall));
    await nextRoomFrame(host);
    await nextRoomFrame(guest);
    await mutateTestRoom(hostRoom.members[0]!.credential, "leave");
    await expect(nextRoomFrame(host)).resolves.toMatchObject({ code: "peer_left" });
    await expect(nextRoomFrame(guest)).resolves.toMatchObject({ type: "room_cancel_call" });
  });
});
