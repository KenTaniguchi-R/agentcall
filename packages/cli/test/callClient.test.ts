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

// Thin wrapper over fakeRelay: captures each non-ping frame the client sends
// and hands it to `handler` alongside the socket, so tests can assert on the
// outbound frame and script a reply in one place.
function fakeRelayCapture(handler: (ws: import("ws").WebSocket, frame: any) => void): Promise<string> {
  return fakeRelay((ws) => {
    ws.on("message", (raw) => {
      const s = String(raw);
      if (s === "ping") return;
      handler(ws, JSON.parse(s));
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

  it("sends a keepalive ping on an interval and ignores pong replies", async () => {
    const pings: string[] = [];
    const relay = await fakeRelay((ws) => {
      ws.on("message", (raw) => {
        const s = String(raw);
        if (s === "ping") { pings.push(s); return; }
        const f = JSON.parse(s);
        if (f.type === "call_request") {
          ws.send("pong");
          setTimeout(() => ws.send(JSON.stringify({ type: "call_reply", call_id: "c1", text: "yo" })), 60);
        }
      });
    });
    const reply = await callAgent({ relay, ...base, pingIntervalMs: 20 });
    expect(reply.text).toBe("yo");
    expect(pings.length).toBeGreaterThan(0);
  });

  it("sends the task field in call_request when opts.task is set", async () => {
    // Arrange a fake relay that captures the first frame, then replies.
    let captured: any;
    const url = await fakeRelayCapture((ws, frame) => {
      captured = frame;
      ws.send(JSON.stringify({ type: "call_reply", call_id: "c1", text: "ok", task: frame.task }));
    });
    const reply = await callAgent({ relay: url, from: "bob", token: "t", to: "ken", message: "tue?", task: "schedule-meeting" });
    expect(captured).toMatchObject({ type: "call_request", task: "schedule-meeting" });
    expect(reply.task).toBe("schedule-meeting");
  });

  // The CLI must not trust the relay to have sanitized `detail`: the relay and
  // the CLI deploy independently, so an older or rogue relay can still hand us
  // raw control bytes that would otherwise land in the user's terminal.
  it("strips terminal escapes from call_error detail before it reaches the message", async () => {
    const url = await fakeRelayCapture((ws) => {
      ws.send(JSON.stringify({
        type: "call_error", code: "agent_error",
        detail: "\u001b[2Jcleared your screen\u001b]0;retitled\u0007",
      }));
    });
    const err = await callAgent({ relay: url, from: "bob", token: "t", to: "ken", message: "x" })
      .then(() => null, (e) => e);
    expect(err.code).toBe("agent_error");
    expect(err.message).not.toContain("\u001b");
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(err.message)).toBe(false);
    expect(err.message).toContain("cleared your screen");
  });

  it("surfaces offered[] from call_error on the thrown CallError", async () => {
    const url = await fakeRelayCapture((ws) => {
      ws.send(JSON.stringify({ type: "call_error", code: "task_not_offered", offered: ["ask", "owner-introduction"] }));
    });
    const err = await callAgent({ relay: url, from: "bob", token: "t", to: "ken", message: "x", task: "deploy" })
      .then(() => null, (e) => e);
    expect(err.code).toBe("task_not_offered");
    expect(err.offered).toEqual(["ask", "owner-introduction"]);
    expect(err.message).toContain("ask");
  });
});
