import {
  RoomCreateRequest, RoomCreateResponse, RoomJoinRequest, RoomJoinResponse, RoomMutationResponse,
  type RoomActionType, type RoomCreateResponseType,
  type RoomJoinResponseType, type RoomMutationResponseType,
} from "@benree/agentcall-shared";
import type { z } from "zod";

/**
 * Room's own error type, deliberately not `api.ts`'s `ApiError` — that class's
 * `code` union (`handle_taken`, `invite_invalid`, ...) is shaped around the
 * durable-identity call path. Keeping Room's HTTP layer structurally separate
 * from the durable-identity one matches #259's "disjoint principal" guidance:
 * a Room capability must never be able to flow through a durable-identity
 * code path (or vice versa) just because they happen to share a type.
 */
export class RoomApiError extends Error {
  constructor(
    message: string,
    public code: "invalid" | "unavailable" | "conflict" | "unauthorized" | "network",
  ) {
    super(message);
  }
}

// Mirrors api.ts's RELAY_TIMEOUT_MS: without a signal, Node's fetch waits
// ~5 minutes on a black-holed connection, which looks identical to a hang.
const ROOM_RELAY_TIMEOUT_MS = 10_000;

async function roomFetch(
  relay: string, path: string, init: RequestInit, timeoutMs: number = ROOM_RELAY_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(`${relay}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError") {
      throw new RoomApiError(`Relay ${relay} did not respond within ${timeoutMs / 1000}s.`, "network");
    }
    throw new RoomApiError(`Cannot reach relay ${relay}: ${String(e)}`, "network");
  }
}

function statusCode(status: number): RoomApiError["code"] {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "invalid";
  if (status === 409) return "conflict";
  return "network";
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

async function parsedRoomCall<T>(
  res: Response, schema: { parse(value: unknown): T }, fallback: string,
): Promise<T> {
  if (!res.ok) throw new RoomApiError(await errorMessage(res, fallback), statusCode(res.status));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RoomApiError("The relay returned malformed JSON.", "network");
  }
  try {
    return schema.parse(body);
  } catch {
    throw new RoomApiError("The relay returned a malformed Room response.", "network");
  }
}

function bearer(credential: string): Record<string, string> {
  return { Authorization: `Bearer ${credential}` };
}

export async function createRoom(
  relay: string, request: z.input<typeof RoomCreateRequest>, timeoutMs?: number,
): Promise<RoomCreateResponseType> {
  const res = await roomFetch(relay, "/v1/rooms", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  }, timeoutMs);
  return parsedRoomCall(res, RoomCreateResponse, "Could not create the Room.");
}

export async function joinRoom(
  relay: string, request: z.input<typeof RoomJoinRequest>, timeoutMs?: number,
): Promise<RoomJoinResponseType> {
  const res = await roomFetch(relay, "/v1/rooms/join", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  }, timeoutMs);
  return parsedRoomCall(res, RoomJoinResponse, "Could not join the Room.");
}

export async function fetchRoomState(
  relay: string, credential: string, timeoutMs?: number,
): Promise<RoomMutationResponseType> {
  const res = await roomFetch(relay, "/v1/room", { headers: bearer(credential) }, timeoutMs);
  return parsedRoomCall(res, RoomMutationResponse, "Could not read the Room's state.");
}

export async function heartbeatRoom(
  relay: string, credential: string, timeoutMs?: number,
): Promise<RoomMutationResponseType> {
  const res = await roomFetch(relay, "/v1/room/heartbeat", {
    method: "POST", headers: { ...bearer(credential), "content-type": "application/json" }, body: "{}",
  }, timeoutMs);
  return parsedRoomCall(res, RoomMutationResponse, "Could not reach the Room.");
}

export async function mutateRoom(
  relay: string, credential: string, action: Exclude<RoomActionType, "heartbeat">,
  targetParticipantId?: string, timeoutMs?: number,
): Promise<RoomMutationResponseType> {
  const res = await roomFetch(relay, `/v1/room/${action}`, {
    method: "POST", headers: { ...bearer(credential), "content-type": "application/json" },
    body: JSON.stringify(targetParticipantId ? { participant_id: targetParticipantId } : {}),
  }, timeoutMs);
  return parsedRoomCall(res, RoomMutationResponse, `Could not ${action} in the Room.`);
}
