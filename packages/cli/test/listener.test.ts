import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startListener } from "../src/listener.js";
import { getPaths } from "../src/paths.js";
import type { Config } from "../src/config.js";

let httpServer: Server;
let stopper: { stop(): void } | undefined;
afterEach(() => { stopper?.stop(); return new Promise<void>((r) => httpServer?.close(() => r())); });

function fakeRelay(onConn: (ws: WsSocket) => void): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/v1/ws" });
    wss.on("connection", onConn);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}`);
    });
  });
}

const cfg: Config = { handle: "ken", token: "tok", agent_kind: "claude", relay: "unused" };

function frames(ws: WsSocket, n: number): Promise<any[]> {
  return new Promise((resolve) => {
    const got: any[] = [];
    ws.on("message", (raw) => {
      const s = String(raw);
      if (s === "ping") return;
      got.push(JSON.parse(s));
      if (got.length === n) resolve(got);
    });
  });
}

describe("startListener", () => {
  it("answers an incoming call: answer -> run -> result, and audits", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async () => ({ text: "the answer", session_id: "s1" }),
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "shusaku", message: "q?" }));
    const [answer, result] = await expectFrames;
    expect(answer).toMatchObject({ type: "call_answer", call_id: "c1" });
    expect(result).toMatchObject({ type: "call_result", call_id: "c1", text: "the answer", session_id: "s1" });
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c1", from: "shusaku", status: "ok" });
  });

  it("reports busy when the queue is full", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    let resolveRun!: () => void;
    const running = new Promise<void>((r) => (resolveRun = r));
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths, maxPending: 0,
          run: async () => { await running; return { text: "slow" }; },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3); // answer(c1), failed(c2,busy), result(c1)
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "a", message: "long job" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "b", message: "hi" }));
    await new Promise((r) => setTimeout(r, 50));
    resolveRun();
    const got = await expectFrames;
    expect(got.find((f) => f.call_id === "c2")).toMatchObject({ type: "call_failed", code: "busy" });
  });

  it("maps runner failures to call_failed with the runner's code", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    const { AgentRunError } = await import("../src/runner.js");
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async () => { throw new AgentRunError("boom", "timeout"); },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c9", from: "x", message: "y" }));
    const got = await expectFrames;
    expect(got[1]).toMatchObject({ type: "call_failed", call_id: "c9", code: "timeout" });
  });
});
