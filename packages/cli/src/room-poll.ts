import type { RoomMutationResponseType, RoomPublicParticipantType } from "@benree/agentcall-shared";
import { fetchRoomState, heartbeatRoom } from "./room-api.js";

type RoomParticipantStateType = RoomPublicParticipantType["state"];

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MAX_BACKOFF_MS = 5_000;

// enforceDeadlines (apps/relay/src/room/do.ts) runs on every relay request,
// including a bare GET, and closes the Room with reason "host_left" if a
// non-pending participant's last_seen_at goes stale by ROOM_HEARTBEAT_GRACE_MS
// (15s). last_seen_at is only refreshed by MUTATING actions — never by
// GET /v1/room. A host is "admitted" (live, not "pending") from the moment of
// creation, so polling with GET alone would make a Room close itself out from
// under its own host within 15 seconds, every time. Once past "pending",
// every poll tick must go through heartbeat instead of state, since it's the
// one GET-shaped action that also counts as liveness.
const LIVE_STATES: readonly RoomParticipantStateType[] = ["admitted", "verified", "ready", "paused"];

export interface RoomPollOptions {
  relay: string;
  credential: string;
  ownParticipantId: string;
  intervalMs?: number;
  fetchState?: typeof fetchRoomState;
  heartbeat?: typeof heartbeatRoom;
  onSnapshot: (snapshot: RoomMutationResponseType) => void | Promise<void>;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}

export interface RoomPollHandle {
  stop(): void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Polls Room state on an interval, choosing GET vs heartbeat per tick based on
 * the caller's own participant state as last observed (see LIVE_STATES above).
 * Backs off on transient network errors instead of throwing, since a single
 * dropped request mid-Room should not crash the CLI's foreground loop.
 */
export function pollRoomState(options: RoomPollOptions): RoomPollHandle {
  const {
    relay, credential, ownParticipantId, intervalMs = DEFAULT_POLL_INTERVAL_MS,
    fetchState = fetchRoomState, heartbeat = heartbeatRoom, onSnapshot, onError, signal,
  } = options;
  let stopped = false;
  let ownState: RoomParticipantStateType | undefined;
  let backoffMs = intervalMs;

  const tick = async (): Promise<void> => {
    if (stopped || signal?.aborted) return;
    try {
      const isLive = ownState !== undefined && LIVE_STATES.includes(ownState);
      const snapshot = isLive ? await heartbeat(relay, credential) : await fetchState(relay, credential);
      backoffMs = intervalMs;
      const self = snapshot.participant ?? snapshot.participants.find((p) => p.participant_id === ownParticipantId);
      if (self) ownState = self.state;
      await onSnapshot(snapshot);
    } catch (error) {
      onError?.(error);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
    if (stopped || signal?.aborted) return;
    await sleep(backoffMs, signal);
    await tick();
  };

  void tick();
  return { stop: () => { stopped = true; } };
}
