import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom, fetchRoomState, heartbeatRoom, joinRoom, mutateRoom, RoomApiError } from "../src/room-api.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => { vi.restoreAllMocks(); });

const validRoomSnapshot = {
  room: {
    room_id: "room_AAAAAAAAAAAAAAAAAAAAAA", state: "waiting", moderator_participant_id: "rp_AAAAAAAAAAAAAAAAAAAAAA",
    expected_participants: 2, membership_epoch: 0, created_at: 1, invite_deadline: 2, idle_deadline: 3, expires_at: 4,
  },
  participants: [],
};

describe("createRoom", () => {
  it("posts to /v1/rooms and parses the response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      ...validRoomSnapshot,
      credential: "acrp.room_AAAAAAAAAAAAAAAAAAAAAA.rp_AAAAAAAAAAAAAAAAAAAAAA." + "a".repeat(43),
      invite: {
        invite: "acri.room_AAAAAAAAAAAAAAAAAAAAAA.ri_AAAAAAAAAAAAAAAAAAAAAA." + "b".repeat(43),
        expires_at: 5, seats_remaining: 1,
      },
    }, 201));
    const request = {
      expected_participants: 2 as const, display_name: "ken",
      signing_public_key: "a".repeat(43), encryption_public_key: "b".repeat(43),
      agent_adapter: "claude@2.1.220:darwin/arm64",
    };
    await createRoom("https://relay.test", request);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://relay.test/v1/rooms");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(request);
  });

  it("turns a non-2xx response into a RoomApiError with a mapped code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "Room unavailable" }, 503));
    await expect(createRoom("https://relay.test", {} as never)).rejects.toMatchObject({
      constructor: RoomApiError, code: "network",
    });
  });
});

describe("joinRoom", () => {
  it("maps a 409 to a conflict RoomApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "display name taken" }, 409));
    const error = await joinRoom("https://relay.test", {} as never).catch((e) => e);
    expect(error).toBeInstanceOf(RoomApiError);
    expect((error as RoomApiError).code).toBe("conflict");
    expect((error as RoomApiError).message).toBe("display name taken");
  });

  it("maps a 404 (invitation unavailable) to invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "Room invitation unavailable" }, 404));
    const error = await joinRoom("https://relay.test", {} as never).catch((e) => e);
    expect((error as RoomApiError).code).toBe("invalid");
  });
});

describe("fetchRoomState / heartbeatRoom", () => {
  it("fetchRoomState sends the capability as a bearer token, no auth headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validRoomSnapshot));
    await fetchRoomState("https://relay.test", "acrp.room_x.rp_y.secret");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://relay.test/v1/room");
    expect((init as RequestInit).method).toBeUndefined();
    expect((init as any).headers.Authorization).toBe("Bearer acrp.room_x.rp_y.secret");
  });

  it("heartbeatRoom posts to /v1/room/heartbeat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validRoomSnapshot));
    await heartbeatRoom("https://relay.test", "acrp.room_x.rp_y.secret");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://relay.test/v1/room/heartbeat");
    expect((init as RequestInit).method).toBe("POST");
  });
});

describe("mutateRoom", () => {
  it("posts to /v1/room/<action> with the target participant when given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validRoomSnapshot));
    await mutateRoom("https://relay.test", "acrp.room_x.rp_y.secret", "admit", "rp_target");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://relay.test/v1/room/admit");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ participant_id: "rp_target" });
  });

  it("omits participant_id for actions that don't target anyone", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validRoomSnapshot));
    await mutateRoom("https://relay.test", "acrp.room_x.rp_y.secret", "confirm");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });
});

describe("network failures", () => {
  it("turns a timeout into a network RoomApiError without hanging", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const error = await fetchRoomState("https://relay.test", "acrp.x", 5).catch((e) => e);
    expect(error).toBeInstanceOf(RoomApiError);
    expect((error as RoomApiError).code).toBe("network");
  });

  it("turns malformed JSON into a network RoomApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
    const error = await fetchRoomState("https://relay.test", "acrp.x").catch((e) => e);
    expect(error).toBeInstanceOf(RoomApiError);
    expect((error as RoomApiError).code).toBe("network");
  });
});
