import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function seedPolicy(paths: ReturnType<typeof getPaths>, policy: object) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.policyFile, JSON.stringify(policy));
}

function seedTask(paths: ReturnType<typeof getPaths>, id: string, frontmatter: string[], body = "do it\n") {
  const dir = join(paths.tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", body].join("\n"));
}

describe("startListener task resolution", () => {
  it("refuses a blocked caller without spawning, and audits it", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    seedPolicy(paths, { default_offer: ["ask"], callers: { spammer: { block: true } } });
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({ relay: url, config: cfg, paths, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "spammer", message: "hi" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c1", code: "blocked" });
    expect(spawned).toBe(false);
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c1", from: "spammer", status: "blocked" });
  });

  it("refuses an ungranted task with the caller's offered menu, without spawning", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    seedTask(paths, "schedule-meeting", ["description: d"]);
    seedPolicy(paths, { default_offer: ["ask"], callers: {} });
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({ relay: url, config: cfg, paths, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "stranger", message: "book", task: "schedule-meeting" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c2", code: "task_not_offered", offered: ["ask"] });
    expect(spawned).toBe(false);
  });

  it("runs a granted task with its envelope and timeout, echoing task in call_result", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    seedTask(paths, "schedule-meeting", [
      "description: d",
      "tools: [read, fetch]",
      "network: [calendar.google.com]",
      "timeout_s: 60",
    ], "check the calendar\n");
    seedPolicy(paths, { default_offer: ["ask"], callers: { shusaku: { offer: ["schedule-meeting"] } } });
    const seen: { prompt?: string; timeout?: number; envelope?: unknown } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async (_k, prompt, _p, timeoutMs, _spec, envelope) => {
            seen.prompt = prompt; seen.timeout = timeoutMs; seen.envelope = envelope;
            return { text: "booked" };
          },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c3", from: "shusaku", message: "tue?", task: "schedule-meeting" }));
    const [, result] = await expectFrames;
    expect(result).toMatchObject({ type: "call_result", call_id: "c3", text: "booked", task: "schedule-meeting" });
    expect(seen.prompt).toContain("check the calendar");
    expect(seen.timeout).toBe(60_000);
    expect(seen.envelope).toEqual({ caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] });
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c3", task: "schedule-meeting", status: "ok" });
  });

  it("falls back to the ask task (read-only envelope) for a plain message", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    const seen: { envelope?: unknown } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async (_k, _prompt, _p, _t, _spec, envelope) => { seen.envelope = envelope; return { text: "hi" }; },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c4", from: "anyone", message: "q?" }));
    const [, result] = await expectFrames;
    expect(result).toMatchObject({ type: "call_result", task: "ask" });
    expect(seen.envelope).toEqual({ caps: ["read"], write_paths: [], network: [] });
  });

  it("maps a corrupt policy file to call_failed agent_error without spawning", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.policyFile, "{corrupt");
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({ relay: url, config: cfg, paths, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c5", from: "a", message: "hi" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c5", code: "agent_error" });
    expect(spawned).toBe(false);
  });
});
