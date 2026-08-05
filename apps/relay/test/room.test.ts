import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ROOM_ABSOLUTE_TTL_MS, ROOM_IDLE_TTL_MS, ROOM_INVITE_TTL_MS,
  type RoomParticipantRecordType, type RoomRecordType,
} from "@benree/agentcall-shared";
import type { RoomDO } from "../src/room/do.js";
import { registerHandle, wsAuth } from "./helpers.js";
import {
  createTestRoom as createRoom,
  joinTestRoom as join,
  mutateTestRoom as mutate,
  roomJoinBody as joinBody,
  roomJson as json,
  roomTestKey as key,
  type RoomTestErrorBody as ErrorBody,
  type RoomTestJoinBody as JoinBody,
} from "./room-helpers.js";

describe("accountless Room capability boundary", () => {
  it.each([2, 3, 6])("creates a %i-seat Room without a durable identity", async (seats) => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM handles").first<{ n: number }>();
    const created = await createRoom(seats);
    expect(created.room).toMatchObject({ state: "waiting", expected_participants: seats, membership_epoch: 0 });
    expect(created.credential).toMatch(/^acrp\.room_.+\.rp_.+\.[A-Za-z0-9_-]{43}$/);
    expect(created.invites).toHaveLength(seats - 1);
    expect(new Set(created.invites.map((entry) => entry.invite)).size).toBe(seats - 1);
    expect(created.invites.every((entry) => entry.expires_at - created.room.created_at === ROOM_INVITE_TTL_MS)).toBe(true);
    expect(created.room.expires_at - created.room.created_at).toBe(ROOM_ABSOLUTE_TTL_MS);
    expect(created.room.idle_deadline - created.room.created_at).toBe(ROOM_IDLE_TTL_MS);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM handles").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(JSON.stringify(created)).not.toContain("credential_hash");
    expect(JSON.stringify(created)).not.toContain("secret_hash");
  });

  it("atomically consumes an invite and makes the same proof idempotent", async () => {
    const created = await createRoom();
    const forgedBody = await joinBody(created.invites[0]!.invite, "Guest");
    forgedBody.signing_proof = `${forgedBody.signing_proof[0] === "A" ? "B" : "A"}${forgedBody.signing_proof.slice(1)}`;
    expect((await json<ErrorBody>(await SELF.fetch("https://relay.test/v1/rooms/join", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forgedBody),
    }))).status).toBe(404);
    const first = await join(created.invites[0]!.invite, "Guest");
    const duplicate = await join(created.invites[0]!.invite, "Guest");
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.participant.participant_id).toBe(first.body.participant.participant_id);
    expect(duplicate.body).not.toHaveProperty("credential");

    const substituted = await joinBody(created.invites[0]!.invite, "Guest", "F", undefined, key("C"));
    expect((await json<ErrorBody>(await SELF.fetch("https://relay.test/v1/rooms/join", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(substituted),
    }))).status).toBe(404);

    const stolen = await join(created.invites[0]!.invite, "Mallory", "F");
    expect(stolen).toEqual({ status: 404, body: { error: "Room invitation unavailable" } });
  });

  it("rejects duplicate participant public keys before membership can lock", async () => {
    const created = await createRoom();
    const res = await SELF.fetch("https://relay.test/v1/rooms/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await joinBody(created.invites[0]!.invite, "Guest", "C", key("B"))),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Room public key unavailable" });
  });

  it("derives Room and participant identity from the capability, not the body", async () => {
    const created = await createRoom();
    const guest = await join(created.invites[0]!.invite, "Guest");
    const forged = await mutate(guest.body.credential, "admit", {
      participant_id: guest.body.participant.participant_id,
      room_id: created.room.room_id,
    });
    expect(forged.status).toBe(400);
    expect((await mutate(guest.body.credential, "admit", {
      participant_id: guest.body.participant.participant_id,
    })).status).toBe(403);
    expect((await mutate("durable-team-token", "heartbeat")).status).toBe(401);
  });

  it("rejects Room capabilities on durable routes and durable credentials on Room routes", async () => {
    const handle = `room-boundary-${crypto.randomUUID().slice(0, 8)}`;
    const durableToken = await registerHandle(handle);
    const created = await createRoom();
    expect((await SELF.fetch("https://relay.test/v1/card/missing", {
      headers: wsAuth(handle, created.credential),
    })).status).toBe(401);
    expect((await SELF.fetch("https://relay.test/v1/room", {
      headers: { Authorization: `Bearer ${durableToken}` },
    })).status).toBe(401);
  });

  it("admits, locks, and activates only after every member confirms", async () => {
    const created = await createRoom();
    const guest = await join(created.invites[0]!.invite, "Guest");
    const admitted = await mutate(created.credential, "admit", {
      participant_id: guest.body.participant.participant_id,
    });
    expect(admitted.body.room).toMatchObject({ state: "verifying", membership_epoch: 1 });
    expect((await mutate(created.credential, "confirm")).body.room.state).toBe("verifying");
    const active = await mutate(guest.body.credential, "confirm");
    expect(active.body.room.state).toBe("active");
    expect(active.body.participants.map((participant) => participant.state)).toEqual(["ready", "ready"]);
  });

  it("closes verification when any locked member rejects or leaves", async () => {
    for (const action of ["reject", "leave"] as const) {
      const created = await createRoom();
      const guest = await join(created.invites[0]!.invite, `Guest ${action}`, action === "reject" ? "L" : "O");
      await mutate(created.credential, "admit", { participant_id: guest.body.participant.participant_id });
      const closed = await mutate(guest.body.credential, action);
      expect(closed.body.room).toMatchObject({ state: "closed", close_reason: "verification_failed" });
      expect((await mutate(created.credential, "heartbeat")).status).toBe(401);
    }
  });

  it("supports early host lock, revokes unused invites, and rejects duplicate names", async () => {
    const created = await createRoom(3);
    const duplicateName = await join(created.invites[0]!.invite, "host");
    expect(duplicateName.status).toBe(409);
    const guest = await join(created.invites[1]!.invite, "Guest", "F");
    expect((await mutate(created.credential, "admit", {
      participant_id: guest.body.participant.participant_id,
    })).body.room.state).toBe("waiting");
    expect((await mutate(created.credential, "lock")).body.room.state).toBe("verifying");
    expect((await join(created.invites[0]!.invite, "Late", "I")).status).toBe(404);
  });

  it("enforces host moderation and closes after three denied joins", async () => {
    const created = await createRoom(4);
    for (let index = 0; index < 3; index++) {
      const guest = await join(created.invites[index]!.invite, `Guest ${index}`, String.fromCharCode(67 + index * 3));
      const denied = await mutate(created.credential, "deny", {
        participant_id: guest.body.participant.participant_id,
      });
      if (index < 2) expect(denied.body.room.state).toBe("waiting");
      else expect(denied.body.room).toMatchObject({ state: "closed", close_reason: "abuse_limit" });
    }
    expect((await mutate(created.credential, "heartbeat")).status).toBe(401);
  });

  it("supports pause/resume and closes when the host leaves", async () => {
    const created = await createRoom();
    const guest = await join(created.invites[0]!.invite, "Guest");
    await mutate(created.credential, "admit", { participant_id: guest.body.participant.participant_id });
    await mutate(created.credential, "confirm");
    await mutate(guest.body.credential, "confirm");
    expect((await mutate(guest.body.credential, "pause")).body.participant.state).toBe("paused");
    expect((await mutate(guest.body.credential, "resume")).body.participant.state).toBe("ready");
    expect((await mutate(created.credential, "leave")).body.room.close_reason).toBe("host_left");
    expect((await mutate(guest.body.credential, "heartbeat")).status).toBe(401);
  });

  it("fails verification on deadline and erases participant credentials", async () => {
    const created = await createRoom();
    const guest = await join(created.invites[0]!.invite, "Guest");
    await mutate(created.credential, "admit", { participant_id: guest.body.participant.participant_id });
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(created.room.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const room = await state.storage.get<RoomRecordType>("room");
      await state.storage.put("room", { ...room!, verification_deadline: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await mutate(created.credential, "heartbeat")).status).toBe(401);
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      expect((await state.storage.list({ prefix: "participant:" })).size).toBe(0);
      expect((await state.storage.list({ prefix: "invite:" })).size).toBe(0);
      expect(await state.storage.get("closed")).toMatchObject({ close_reason: "verification_failed" });
    });
  });

  it("counts pending admission timeouts and closes at the abuse limit", async () => {
    const created = await createRoom(4);
    for (let index = 0; index < 3; index++) {
      expect((await join(
        created.invites[index]!.invite, `Pending ${index}`, String.fromCharCode(67 + index * 3),
      )).status).toBe(201);
    }
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(created.room.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const room = await state.storage.get<RoomRecordType>("room");
      await state.storage.put("room", { ...room!, invite_deadline: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      expect(await state.storage.get("closed")).toMatchObject({ close_reason: "abuse_limit" });
      expect((await state.storage.list({ prefix: "participant:" })).size).toBe(0);
    });
  });

  it.each([
    ["expired", { expires_at: Date.now() - 1 }],
    ["idle", { idle_deadline: Date.now() - 1 }],
  ] as const)("closes on the %s deadline", async (reason, deadline) => {
    const created = await createRoom();
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(created.room.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const room = await state.storage.get<RoomRecordType>("room");
      await state.storage.put("room", { ...room!, ...deadline });
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      expect(await state.storage.get("closed")).toMatchObject({ close_reason: reason });
    });
  });

  it("closes on host heartbeat loss and marks a non-host departed without changing the active epoch", async () => {
    const hostLost = await createRoom();
    const hostStub = env.ROOM_DO.get(env.ROOM_DO.idFromName(hostLost.room.room_id));
    await runInDurableObject(hostStub, async (_instance: RoomDO, state) => {
      const host = [...(await state.storage.list<RoomParticipantRecordType>({ prefix: "participant:" })).values()][0]!;
      await state.storage.put(`participant:${host.participant_id}`, { ...host, last_seen_at: Date.now() - 16_000 });
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    await runDurableObjectAlarm(hostStub);
    await runInDurableObject(hostStub, async (_instance: RoomDO, state) => {
      expect(await state.storage.get("closed")).toMatchObject({ close_reason: "host_left" });
    });

    const created = await createRoom(3);
    const first = await join(created.invites[0]!.invite, "First", "R");
    const second = await join(created.invites[1]!.invite, "Second", "U");
    await mutate(created.credential, "admit", { participant_id: first.body.participant.participant_id });
    await mutate(created.credential, "admit", { participant_id: second.body.participant.participant_id });
    await mutate(created.credential, "confirm");
    await mutate(first.body.credential, "confirm");
    await mutate(second.body.credential, "confirm");
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(created.room.room_id));
    await runInDurableObject(stub, async (_instance: RoomDO, state) => {
      const participant = await state.storage.get<RoomParticipantRecordType>(
        `participant:${first.body.participant.participant_id}`,
      );
      if (!participant) throw new Error("expected Room participant record");
      await state.storage.put(`participant:${participant.participant_id}`, {
        ...participant, last_seen_at: Date.now() - 16_000,
      });
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    await runDurableObjectAlarm(stub);
    const snapshot = await mutate(created.credential, "heartbeat");
    expect(snapshot.body.room).toMatchObject({ state: "active", membership_epoch: 1 });
    expect(snapshot.body.participants.find(
      (participant) => participant.participant_id === first.body.participant.participant_id,
    )?.state)
      .toBe("departed");
    expect((await mutate(first.body.credential, "heartbeat")).status).toBe(401);
  });

  it("runs a complete six-seat membership lifecycle without shrinking the locked epoch", async () => {
    const created = await createRoom(6);
    const guests: JoinBody[] = [];
    const labels = ["X", "Y", "Z", "a", "b"];
    for (let index = 0; index < 5; index++) {
      const guest = await join(created.invites[index]!.invite, `Member ${index + 2}`, labels[index]!);
      guests.push(guest.body);
      const admitted = await mutate(created.credential, "admit", {
        participant_id: guest.body.participant.participant_id,
      });
      expect(admitted.body.room.state).toBe(index === 4 ? "verifying" : "waiting");
    }
    await mutate(created.credential, "confirm");
    for (const [index, guest] of guests.entries()) {
      const confirmed = await mutate(guest.credential, "confirm");
      expect(confirmed.body.room.state).toBe(index === guests.length - 1 ? "active" : "verifying");
    }
    const left = await mutate(guests[0]!.credential, "leave");
    expect(left.body.room).toMatchObject({ state: "active", membership_epoch: 1 });
    expect(left.body.participants.find(
      (participant) => participant.participant_id === guests[0]!.participant.participant_id,
    )?.state)
      .toBe("departed");
  });
});
