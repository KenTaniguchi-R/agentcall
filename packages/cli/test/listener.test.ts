import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startListener } from "../src/listener.js";
import { getLinePaths, getMachinePaths, type LinePaths, type MachinePaths } from "../src/paths.js";
import { AgentRunError } from "../src/runner.js";
import type { CallableLineConfig } from "../src/config.js";

let httpServer: Server;
let stopper: { stop(): void } | undefined;
// Resolves immediately when a test never started a relay — `httpServer?.close()`
// on an undefined server is a silent no-op whose callback never fires, which
// would hang teardown until vitest's timeout.
afterEach(() => {
  stopper?.stop();
  return new Promise<void>((r) => { if (httpServer) httpServer.close(() => r()); else r(); });
});

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

// CallableLineConfig, not LineConfig: `startListener` only accepts a config
// that has already passed `assertCallableLine`, and annotating the fixture as
// the wider `LineConfig` widens agent_kind back to optional at every spread
// site.
const cfg: CallableLineConfig = { handle: "ken", token: "tok", agent_kind: "claude", relay: "unused" };

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

// Fresh ~/.agentcall-shaped tmp root, isolated as both stateRoot and userHome
// so nothing in these tests can accidentally touch the real machine.
function freshMachine(): MachinePaths {
  const root = mkdtempSync(join(tmpdir(), "agentcall-l-"));
  return getMachinePaths(root, root);
}

// No policy/task seeded — loadPolicy and loadTasks both fall back to their
// built-in defaults (default_offer: ["ask"], the built-in "ask" task), which
// is enough for a plain message to resolve.
function seededPaths(): LinePaths {
  return getLinePaths(freshMachine(), "claude");
}

// The one way call-flow tests assemble listener deps: default config wired to
// the relay under test, plus a freshly seeded line-paths root. Tests needing a
// custom config field (e.g. workdir) or seeded policy/tasks spread this and
// override, or seed onto `.paths` before calling startListener.
function baseDeps(relay: string) {
  const paths = seededPaths();
  return { paths, relay, loadConfig: () => ({ ...cfg, relay }) };
}

describe("startListener workdir", () => {
  // Resolved once at startup so a typo'd workdir stops `agentcall listen`
  // with a clear message instead of failing every inbound call individually.
  it("throws at start rather than per call when workdir is unusable", () => {
    expect(() =>
      startListener({
        relay: "http://127.0.0.1:1", paths: seededPaths(),
        loadConfig: () => ({ ...cfg, workdir: "/no/such/project" }),
        run: async () => ({ text: "unused" }),
      }),
    ).toThrow(/does not exist/i);
  });

  it("spawns in the configured workdir and drops the confinement line from the prompt", async () => {
    const machine = freshMachine();
    const paths = getLinePaths(machine, "claude");
    const project = join(machine.stateRoot, "code", "api");
    mkdirSync(project, { recursive: true });
    const seen: { workdir?: string; prompt?: string } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, paths,
          loadConfig: () => ({ ...cfg, workdir: project }),
          run: async (_k, prompt, workdir) => {
            seen.prompt = prompt; seen.workdir = workdir;
            return { text: "ok" };
          },
        });
      });
    });
    const ws = await relayReady;
    const done = frames(ws, 3); // accepted, started, result
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "shusaku", message: "hi" }));
    await done;
    expect(seen.workdir).toBe(project);
    expect(seen.prompt).toContain(project);
    expect(seen.prompt).not.toMatch(/do not access anything outside it/i);
  });
});

describe("startListener", () => {
  it("answers an incoming call: accepted -> started -> result, and audits", async () => {
    let paths!: LinePaths;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        stopper = startListener({
          ...deps,
          run: async () => ({ text: "the answer", session_id: "s1" }),
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "shusaku", message: "q?" }));
    const [accepted, started, result] = await expectFrames;
    expect(accepted).toMatchObject({ type: "call_accepted", call_id: "c1" });
    expect(started).toMatchObject({ type: "call_started", call_id: "c1" });
    expect(result).toMatchObject({ type: "call_result", call_id: "c1", text: "the answer", session_id: "s1" });
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c1", from: "shusaku", status: "ok" });
  });

  it("reports busy when the queue is full", async () => {
    let resolveRun!: () => void;
    const running = new Promise<void>((r) => (resolveRun = r));
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          ...baseDeps(url),
          run: async () => { await running; return { text: "slow" }; },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 4); // accepted(c1), started(c1), failed(c2,busy), result(c1)
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "a", message: "long job" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "b", message: "hi" }));
    await new Promise((r) => setTimeout(r, 50));
    resolveRun();
    const got = await expectFrames;
    expect(got.find((f) => f.call_id === "c2")).toMatchObject({ type: "call_failed", code: "busy" });
  });

  it("maps runner failures to call_failed with the runner's code, without leaking stderr to the caller", async () => {
    let paths!: LinePaths;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        stopper = startListener({
          ...deps,
          run: async () => { throw new AgentRunError("boom: /Users/shusaku/secret-project stack trace", "timeout"); },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3); // accepted, started, failed
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c9", from: "x", message: "y" }));
    const got = await expectFrames;
    expect(got[2]).toMatchObject({ type: "call_failed", call_id: "c9", code: "timeout" });
    expect(got[2].detail).not.toContain("boom");
    expect(got[2].detail).not.toContain("secret-project");
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0].error).toContain("secret-project");
  });
});

describe("startListener acceptance and cancellation", () => {
  it("emits call_accepted before call_started", async () => {
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          ...baseDeps(url),
          run: async () => ({ text: "ok", session_id: "s" }),
        });
      });
    });
    const ws = await relayReady;
    const got = frames(ws, 3);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "amy", message: "hi" }));
    const types = (await got).map((f) => f.type);
    expect(types).toEqual(["call_accepted", "call_started", "call_result"]);
  });

  it("refuses a second concurrent call because maxPending is 0", async () => {
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          ...baseDeps(url),
          run: () => new Promise(() => {}), // first call never finishes
        });
      });
    });
    const ws = await relayReady;
    const got = frames(ws, 3); // accepted(c1), started(c1), failed(c2,busy)
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "amy", message: "hi" }));
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "amy", message: "hi" }));
    const all = await got;
    expect(all.filter((f) => f.type === "call_failed" && f.code === "busy")).toHaveLength(1);
  });

  it("acknowledges cancellation of a running call only after the agent exits", async () => {
    let exited = false;
    let paths!: LinePaths;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        stopper = startListener({
          ...deps,
          // Mirrors runAgent: settles only once teardown completes.
          run: (_k, _p, _w, _t, _s, _e, _c, signal?: AbortSignal) =>
            new Promise((_res, rej) => {
              signal?.addEventListener("abort", () => {
                setTimeout(() => { exited = true; rej(new AgentRunError("canceled", "canceled")); }, 10);
              }, { once: true });
            }),
        });
      });
    });
    const ws = await relayReady;
    const got = frames(ws, 3); // accepted, started, cancelled
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "amy", message: "hi" }));
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: "cancel_call", call_id: "c1" }));
    const all = await got;
    expect(all.find((f) => f.type === "call_cancelled")).toMatchObject({ phase: "running" });
    expect(exited).toBe(true);
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c1", from: "amy", status: "canceled" });
  });

  it("reports call_not_cancelled for an unknown call id", async () => {
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener(baseDeps(url));
      });
    });
    const ws = await relayReady;
    const got = frames(ws, 1);
    ws.send(JSON.stringify({ type: "cancel_call", call_id: "no-such-call" }));
    expect((await got)[0]).toMatchObject({ type: "call_not_cancelled", reason: "unknown" });
  });
});

function seedPolicy(paths: LinePaths, policy: object) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.policyFile, JSON.stringify(policy));
}

function seedTask(paths: LinePaths, id: string, frontmatter: string[], body = "do it\n") {
  const dir = join(paths.tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", body].join("\n"));
}

describe("startListener task resolution", () => {
  it("refuses a blocked caller without spawning, and audits it", async () => {
    let spawned = false;
    let paths!: LinePaths;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        seedPolicy(paths, { default_offer: ["ask"], callers: { spammer: { block: true } } });
        stopper = startListener({ ...deps, run: async () => { spawned = true; return { text: "x" }; } });
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
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        seedTask(deps.paths, "schedule-meeting", ["description: d"]);
        seedPolicy(deps.paths, { default_offer: ["ask"], callers: {} });
        stopper = startListener({ ...deps, run: async () => { spawned = true; return { text: "x" }; } });
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
    const seen: { prompt?: string; timeout?: number; envelope?: unknown } = {};
    let paths!: LinePaths;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        seedTask(deps.paths, "schedule-meeting", [
          "description: d",
          "tools: [read, fetch]",
          "network: [calendar.google.com]",
          "timeout_s: 60",
        ], "check the calendar\n");
        seedPolicy(deps.paths, { default_offer: ["ask"], callers: { shusaku: { offer: ["schedule-meeting"] } } });
        stopper = startListener({
          ...deps,
          run: async (_k, prompt, _p, timeoutMs, _spec, envelope) => {
            seen.prompt = prompt; seen.timeout = timeoutMs; seen.envelope = envelope;
            return { text: "booked" };
          },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3); // accepted, started, result
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c3", from: "shusaku", message: "tue?", task: "schedule-meeting" }));
    const [, , result] = await expectFrames;
    expect(result).toMatchObject({ type: "call_result", call_id: "c3", text: "booked", task: "schedule-meeting" });
    expect(seen.prompt).toContain("check the calendar");
    expect(seen.timeout).toBe(60_000);
    expect(seen.envelope).toEqual({ caps: ["read", "fetch"] });
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c3", task: "schedule-meeting", status: "ok" });
  });

  it("falls back to the ask task (read-only envelope) for a plain message", async () => {
    const seen: { envelope?: unknown } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          ...baseDeps(url),
          run: async (_k, _prompt, _p, _t, _spec, envelope) => { seen.envelope = envelope; return { text: "hi" }; },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3); // accepted, started, result
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c4", from: "anyone", message: "q?" }));
    const [, , result] = await expectFrames;
    expect(result).toMatchObject({ type: "call_result", task: "ask" });
    expect(seen.envelope).toEqual({ caps: ["read"] });
  });

  it("maps a corrupt policy file to call_failed agent_error without spawning, and without leaking the parse error", async () => {
    let spawned = false;
    let paths!: LinePaths;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.policyFile, "{corrupt");
        stopper = startListener({ ...deps, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c5", from: "a", message: "hi" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c5", code: "agent_error" });
    expect(failed.detail).not.toMatch(/JSON|SyntaxError|corrupt/i);
    expect(spawned).toBe(false);
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0].error).toMatch(/JSON|SyntaxError/i);
  });
});

// Minimal fake WebSocket for tests that need to assert on what each
// (re)connect sends without a full WebSocketServer round-trip — in
// particular, per-attempt Authorization headers, which fakeRelay's real
// handshake makes awkward to inspect per reconnect. `.emit` is test-only, not
// part of the `ws` API surface: it lets a test fire the same events
// startListener listens for (`open`, `message`, `close`) synchronously.
function fakeSocketFactory(onConnect: (url: string, opts: { headers: Record<string, string> }) => void) {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    private listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    on(event: string, cb: (...a: unknown[]) => void) { (this.listeners[event] ??= []).push(cb); return this; }
    send() { /* nothing to deliver in this fake */ }
    close() { /* nothing to tear down in this fake */ }
    emit(event: string, ...args: unknown[]) { (this.listeners[event] ?? []).forEach((cb) => cb(...args)); }
  }
  const factory = (url: string, opts: { headers: Record<string, string> }) => {
    onConnect(url, opts);
    const s = new FakeSocket();
    sockets.push(s);
    return s as unknown as import("ws").WebSocket;
  };
  return { factory, last: () => sockets.at(-1)! };
}

describe("startListener config reload", () => {
  let linePaths: LinePaths;
  beforeEach(() => { linePaths = seededPaths(); });

  // Config used to be resolved once at startListener() startup and captured
  // by the whole function — a rotated token (`agentcall rotate`) then only
  // took effect after the background listener was restarted. loadConfig is
  // now called fresh inside connect() on every attempt, including reconnects,
  // so a new token reaches the relay on the very next reconnect with no
  // restart needed.
  it("re-reads config on each reconnect so a rotated token takes effect", async () => {
    let token = "old";
    const seen: string[] = [];
    const sockets = fakeSocketFactory((_url, opts) => {
      seen.push(String(opts.headers.Authorization));
    });
    const l = startListener({
      relay: "https://r.example",
      paths: linePaths,
      loadConfig: () => ({ handle: "ken", token, relay: "https://r.example", agent_kind: "claude" }),
      socketFactory: sockets.factory,
      backoffMs: () => 0,
    });
    sockets.last().emit("close");          // force a reconnect
    // scheduleReconnect defers the next connect() through a real
    // `setTimeout`, even with backoffMs returning 0 — a 0ms timer still
    // doesn't fire until the current synchronous block finishes, so a tick
    // has to be awaited before the next `sockets.last()` reflects it.
    await new Promise((r) => setTimeout(r, 0));
    token = "new";
    sockets.last().emit("close");
    await new Promise((r) => setTimeout(r, 0));
    l.stop();
    expect(seen[0]).toBe("Bearer old");
    expect(seen.at(-1)).toBe("Bearer new");
  });
});
