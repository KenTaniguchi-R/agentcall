import WebSocket, { type RawData } from "ws";
import {
  ROOM_MAX_CALL_WIRE_BYTES, RoomSocketRelayFrame,
  type RoomSocketClientFrameType, type RoomSocketRelayFrameType,
} from "@benree/agentcall-shared";

const PING_INTERVAL_MS = 30_000;

export interface RoomSocketHandlers {
  onFrame: (frame: RoomSocketRelayFrameType) => void | Promise<void>;
  /**
   * Terminal. #259's failure semantics are explicit that a client shows
   * `connection_lost` and **does not reconnect into the Room** — a Room
   * credential cannot resume, and the relay marks a silent participant
   * departed after 15s anyway. So this module has no reconnect path on
   * purpose; a dropped socket ends the session.
   */
  onClosed: (reason: RoomSocketCloseReason) => void;
}

export type RoomSocketCloseReason =
  | { kind: "unauthorized" }
  | { kind: "connection_lost"; detail: string }
  | { kind: "protocol_error" }
  | { kind: "local" };

export interface RoomSocketOptions extends RoomSocketHandlers {
  relay: string;
  credential: string;
  createSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  pingIntervalMs?: number;
}

export interface RoomSocket {
  send(frame: RoomSocketClientFrameType): void;
  close(): void;
}

function rawWireBytes(raw: RawData): number {
  if (typeof raw === "string") return Buffer.byteLength(raw);
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + part.byteLength, 0);
  return (raw as ArrayBuffer).byteLength;
}

export function openRoomSocket(options: RoomSocketOptions): RoomSocket {
  const {
    relay, credential, onFrame, onClosed,
    createSocket = (url, opts) => new WebSocket(url, opts), pingIntervalMs = PING_INTERVAL_MS,
  } = options;

  const url = `${relay.replace(/^http/, "ws")}/v1/room/ws`;
  const socket = createSocket(url, {
    headers: { Authorization: `Bearer ${credential}` },
    perMessageDeflate: false,
    maxPayload: ROOM_MAX_CALL_WIRE_BYTES,
  });

  let settled = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  const finish = (reason: RoomSocketCloseReason): void => {
    if (settled) return;
    settled = true;
    if (pingTimer) clearInterval(pingTimer);
    try { socket.close(); } catch { /* already gone */ }
    onClosed(reason);
  };

  socket.on("unexpected-response", (_req, res) => {
    finish(res.statusCode === 401 || res.statusCode === 403
      ? { kind: "unauthorized" }
      : { kind: "connection_lost", detail: `relay returned ${res.statusCode}` });
  });
  socket.on("error", (error: Error) => finish({ kind: "connection_lost", detail: error.message }));
  socket.on("close", () => finish({ kind: "connection_lost", detail: "the relay closed the connection" }));

  socket.on("open", () => {
    // Cloudflare drops an idle socket, and a Room call can legitimately go
    // quiet for the agent's full 90s timeout. unref() so this timer alone
    // never holds the process open.
    pingTimer = setInterval(() => { try { socket.ping(); } catch { /* dead */ } }, pingIntervalMs);
    pingTimer.unref?.();
  });

  socket.on("message", async (raw: RawData) => {
    if (settled) return;
    // Oversize is rejected before parsing into anything prompt-shaped, per
    // #259's "malformed or oversized frame" rule.
    if (rawWireBytes(raw) > ROOM_MAX_CALL_WIRE_BYTES) return finish({ kind: "protocol_error" });
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      return finish({ kind: "protocol_error" });
    }
    const frame = RoomSocketRelayFrame.safeParse(parsedJson);
    if (!frame.success) return finish({ kind: "protocol_error" });
    await onFrame(frame.data);
  });

  return {
    send(frame: RoomSocketClientFrameType): void {
      if (settled) return;
      try {
        socket.send(JSON.stringify(frame));
      } catch { /* the close handler reports it */ }
    },
    close(): void {
      finish({ kind: "local" });
    },
  };
}
