import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { callAgent, CallError } from "../src/callClient.js";

let httpServer: Server;
afterEach(() => new Promise<void>((r) => httpServer?.close(() => r())));

type Script = (ws: import("ws").WebSocket, req: import("node:http").IncomingMessage) => void;

function fakeRelay(script: Script): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer((_q, s) => { s.writeHead(404); s.end(); });
    const wss = new WebSocketServer({ server: httpServer, path: "/v1/ws" });
    wss.on("connection", script);
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const base = { from: "me", token: "tok", to: "ken", message: "hi" };

describe("callAgent", () => {
  it("resolves with the reply and reports statuses", async () => {
    const relay = await fakeRelay((ws, req) => {
      expect(req.headers.authorization).toBe("Bearer tok");
      expect(req.headers["x-agentcall-handle"]).toBe("me");
      ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        expect(f).toMatchObject({ type: "call_request", to: "ken", message: "hi" });
        ws.send(JSON.stringify({ type: "call_status", state: "ringing" }));
        ws.send(JSON.stringify({ type: "call_status", state: "answered" }));
        ws.send(JSON.stringify({ type: "call_reply", call_id: "c1", text: "yo", session_id: "s9" }));
        ws.close(1000);
      });
    });
    const states: string[] = [];
    const reply = await callAgent({ relay, ...base, onStatus: (s) => states.push(s) });
    expect(reply.text).toBe("yo");
    expect(reply.session_id).toBe("s9");
    expect(states).toEqual(["ringing", "answered"]);
  });

  it("rejects with the relay's error code", async () => {
    const relay = await fakeRelay((ws) => {
      ws.on("message", () => ws.send(JSON.stringify({ type: "call_error", code: "offline" })));
    });
    await expect(callAgent({ relay, ...base })).rejects.toMatchObject({ code: "offline" });
  });

  it("rejects when the socket closes before a reply", async () => {
    const relay = await fakeRelay((ws) => { ws.on("message", () => ws.close(1011)); });
    await expect(callAgent({ relay, ...base })).rejects.toBeInstanceOf(CallError);
  });

  it("times out client-side", async () => {
    const relay = await fakeRelay(() => { /* say nothing */ });
    await expect(callAgent({ relay, ...base, timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" });
  });
});
