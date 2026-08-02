import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_TTL_MS, MAX_CONTEXT_TURNS } from "@benree/agentcall-shared";
import { startListener } from "../src/listener.js";
import { getPaths } from "../src/paths.js";
import { AgentRunError } from "../src/runner.js";
import { loadContexts, mintContextId, saveContexts, type ContextBinding } from "../src/contexts.js";
import type { CallableConfig } from "../src/config.js";

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

// CallableConfig, not Config: `startListener` only accepts a config that has
// already passed `assertCallableConfig`, and annotating the fixture as the
// wider `Config` widens agent_kind back to optional at every spread site.
const cfg: CallableConfig = { org: "acme", handle: "ken", token: "tok", agent_kind: "claude", relay: "unused" };

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

// Fresh ~/.agentcall-shaped tmp root, no policy/task seeded — loadPolicy and
// loadTasks both fall back to their built-in defaults (default_offer: ["ask"],
// the built-in "ask" task), which is enough for a plain message to resolve.
function seededPaths(): ReturnType<typeof getPaths> {
  return getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
}

// The one way call-flow tests assemble listener deps: default config wired to
// the relay under test, plus a freshly seeded paths root. Tests needing a
// custom config field (e.g. workdir) or seeded policy/tasks spread this and
// override, or seed onto `.paths` before calling startListener.
function baseDeps(relay: string) {
  return { config: { ...cfg, relay }, paths: seededPaths(), relay };
}

describe("startListener workdir", () => {
  // Resolved once at startup so a typo'd workdir stops `agentcall listen`
  // with a clear message instead of failing every inbound call individually.
  it("throws at start rather than per call when workdir is unusable", () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    expect(() =>
      startListener({
        relay: "http://127.0.0.1:1", paths,
        config: { ...cfg, workdir: "/no/such/project" },
        run: async () => ({ text: "unused" }),
      }),
    ).toThrow(/does not exist/i);
  });

  it("spawns in the configured workdir and drops the confinement line from the prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-l-"));
    const paths = getPaths(home);
    const project = join(home, "code", "api");
    mkdirSync(project, { recursive: true });
    const seen: { workdir?: string; prompt?: string } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, paths,
          config: { ...cfg, workdir: project },
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
    let paths!: ReturnType<typeof getPaths>;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        const deps = baseDeps(url);
        paths = deps.paths;
        stopper = startListener({
          ...deps,
          run: async () => ({ text: "the answer", session_id: "agent-session-s1" }),
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "shusaku", message: "q?" }));
    const [accepted, started, result] = await expectFrames;
    expect(accepted).toMatchObject({ type: "call_accepted", call_id: "c1" });
    expect(started).toMatchObject({ type: "call_started", call_id: "c1" });
    // call_result carries the MINTED binding handle. This assertion used to read
    // `context_id: "s1"` -- the agent's own session id forwarded straight onto
    // the wire, which is the capability leak the context design exists to close.
    expect(result).toMatchObject({ type: "call_result", call_id: "c1", text: "the answer" });
    expect(result.context_id).toMatch(/^ctx_[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(result)).not.toContain("agent-session");
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
    let paths!: ReturnType<typeof getPaths>;
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
    let paths!: ReturnType<typeof getPaths>;
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
    let spawned = false;
    let paths!: ReturnType<typeof getPaths>;
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
    let paths!: ReturnType<typeof getPaths>;
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
    let paths!: ReturnType<typeof getPaths>;
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

// Drives one inbound call and returns the frames the listener sent back.
// `seed` runs against the deps before the listener starts, so a test can plant
// a binding, a policy, or a task.
async function oneCall(
  incoming: Record<string, unknown>,
  opts: {
    seed?: (paths: ReturnType<typeof getPaths>) => void;
    run?: (...a: any[]) => Promise<{ text: string; session_id?: string }>;
    saveContexts?: () => void;
    frameCount?: number;
  } = {},
): Promise<{ frames: any[]; paths: ReturnType<typeof getPaths> }> {
  let deps!: ReturnType<typeof baseDeps>;
  const got = await new Promise<any[]>((resolve) => {
    void fakeRelay((ws) => {
      const collected = frames(ws, opts.frameCount ?? 3);
      ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "sota", ...incoming }));
      void collected.then(resolve);
    }).then((url) => {
      deps = baseDeps(url);
      opts.seed?.(deps.paths);
      stopper = startListener({
        ...deps,
        run: opts.run ?? (async () => ({ text: "ok", session_id: "real-agent-session" })),
        saveContexts: opts.saveContexts,
      });
    });
  });
  return { frames: got, paths: deps.paths };
}

describe("listener contexts", () => {
  // 22 base64url characters, so it satisfies CONTEXT_ID_RE and survives
  // loadContexts' schema parse. A binding that fails that parse would be
  // dropped on load and every test below would pass for the wrong reason.
  const SEEDED_CTX = "ctx_AAAAAAAAAAAAAAAAAAAAAA";

  const seedBinding =
    (over: Partial<ContextBinding> = {}) =>
    (paths: ReturnType<typeof getPaths>) => {
      const b: ContextBinding = {
        context_id: SEEDED_CTX,
        agent_session_id: "real-agent-session",
        caller: "sota",
        task: "ask",
        agent_kind: "claude",
        // baseDeps' config sets no workdir, so resolveWorkdir returns publicDir.
        workdir: paths.publicDir,
        turns: 1,
        created_at: Date.now(),
        last_used_at: Date.now(),
        ...over,
      };
      saveContexts(paths, [b]);
    };

  it("mints a context on a fresh threadable call and returns it", async () => {
    const { frames: f, paths } = await oneCall({ message: "hi" });
    const result = f.find((x) => x.type === "call_result");
    expect(result.context_id).toMatch(/^ctx_[A-Za-z0-9_-]{22}$/);
    const stored = loadContexts(paths);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.agent_session_id).toBe("real-agent-session");
    expect(stored[0]!.caller).toBe("sota");
    expect(stored[0]!.context_id).toBe(result.context_id);
  });

  it("delivers a completed answer without a context when context persistence fails", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
    try {
      const { frames: f, paths } = await oneCall(
        { message: "hi" },
        { saveContexts: () => { throw new Error("ENOSPC: disk full"); } },
      );
      expect(f.map((x) => x.type)).toEqual(["call_accepted", "call_started", "call_result"]);
      expect(f[2]).toMatchObject({ call_id: "c1", text: "ok", task: "ask" });
      expect(f[2].context_id).toBeUndefined();
      expect(loadContexts(paths)).toEqual([]);
      expect(errors.some((line) => line.includes("could not save the call context") && line.includes("ENOSPC"))).toBe(true);
      const audit = JSON.parse(readFileSync(paths.callsLog, "utf8").trim());
      expect(audit).toMatchObject({ status: "ok", context_persist_error: expect.stringContaining("ENOSPC") });
    } finally {
      spy.mockRestore();
    }
  });

  // The binding is the security boundary: the real session id must never be
  // what goes back on the wire.
  it("never returns the real agent session id", async () => {
    const { frames: f } = await oneCall({ message: "hi" });
    const result = f.find((x) => x.type === "call_result");
    expect(result.context_id).not.toBe("real-agent-session");
    expect(JSON.stringify(f)).not.toContain("real-agent-session");
  });

  it("resumes with the real session id when the binding matches", async () => {
    let sawResume: string | undefined;
    await oneCall(
      { message: "and the commit?", context_id: SEEDED_CTX },
      {
        seed: seedBinding(),
        run: async (...a: any[]) => {
          sawResume = a[8] as string | undefined;
          return { text: "ok", session_id: "real-agent-session" };
        },
      },
    );
    expect(sawResume).toBe("real-agent-session");
  });

  it("builds the threaded prompt variant on a resumed call", async () => {
    let prompt = "";
    await oneCall(
      { message: "and the commit?", context_id: SEEDED_CTX },
      {
        seed: seedBinding(),
        run: async (...a: any[]) => {
          prompt = a[1] as string;
          return { text: "ok", session_id: "real-agent-session" };
        },
      },
    );
    expect(prompt).toContain("continuing a call");
    expect(prompt).not.toContain("one-shot");
  });

  it("increments the turn count on a resumed call", async () => {
    const { paths } = await oneCall(
      { message: "again", context_id: SEEDED_CTX },
      { seed: seedBinding({ turns: 3 }) },
    );
    expect(loadContexts(paths)[0]!.turns).toBe(4);
  });

  // Regression: the roll-forward block used to be gated on `out.session_id`,
  // so a resumed turn whose agent returned none left the binding at its old
  // turn count with its TTL sliding from the last successful write. A caller
  // could then resume forever, pinned below MAX_CONTEXT_TURNS. Reachable for
  // real: parseCodexJsonl's non-JSON fallback returns session_id: undefined.
  it("still counts a resumed turn when the agent returns no session id, so the cap holds", async () => {
    const first = await oneCall(
      { message: "turn ten", context_id: SEEDED_CTX },
      { seed: seedBinding({ turns: MAX_CONTEXT_TURNS - 1 }), run: async () => ({ text: "ok" }) },
    );
    const rolled = loadContexts(first.paths)[0]!;
    expect(rolled.turns).toBe(MAX_CONTEXT_TURNS);
    // The session id it had nothing to replace with is kept, not clobbered
    // with undefined — it is still the right one to resume next time.
    expect(rolled.agent_session_id).toBe("real-agent-session");

    // oneCall owns the module-level relay/listener handles, so the first pair
    // has to be torn down here rather than in afterEach, which only ever sees
    // the second.
    stopper?.stop();
    await new Promise<void>((r) => httpServer.close(() => r()));

    let spawned = false;
    const { frames: f } = await oneCall(
      { message: "turn eleven", context_id: SEEDED_CTX },
      {
        frameCount: 1,
        run: async () => { spawned = true; return { text: "should not happen" }; },
        // The rolled-forward binding, re-homed into the second call's tmp root
        // so the refusal can only come from the turn cap and not from a
        // workdir mismatch.
        seed: (p) => saveContexts(p, [{ ...rolled, workdir: p.publicDir }]),
      },
    );
    expect(f[0]).toMatchObject({ type: "call_failed", code: "context_unknown" });
    expect(spawned).toBe(false);
  });

  // contexts.ts's invariant: the real agent_session_id never reaches an audit
  // log. A stale binding makes `claude --resume <id>` print that id in its own
  // error text, which runAgent folds into the AgentRunError message.
  it("scrubs the real session id out of an audited failure", async () => {
    const { paths } = await oneCall(
      { message: "resume a dead session", context_id: SEEDED_CTX },
      {
        seed: seedBinding(),
        run: async () => {
          throw new AgentRunError(
            "agent exited 1: No conversation found with session ID: real-agent-session",
            "agent_error",
          );
        },
      },
    );
    const line = JSON.parse(readFileSync(paths.callsLog, "utf8").trim().split("\n").at(-1)!);
    expect(line).toMatchObject({ status: "agent_error" });
    expect(line.error).not.toContain("real-agent-session");
    expect(line.error).toContain("<session>");
  });

  it("keeps the same context id across a resumed turn rather than minting a second", async () => {
    const { frames: f, paths } = await oneCall(
      { message: "again", context_id: SEEDED_CTX },
      { seed: seedBinding() },
    );
    expect(f.find((x) => x.type === "call_result").context_id).toBe(SEEDED_CTX);
    expect(loadContexts(paths)).toHaveLength(1);
  });

  // The table the design exists to satisfy. Every row must fail the call and
  // spawn nothing.
  const refusals: Array<[string, Partial<ContextBinding>]> = [
    ["a different caller", { caller: "mallory" }],
    ["a different task", { task: "deploy-status" }],
    ["a different agent kind", { agent_kind: "codex" }],
    ["a changed workdir", { workdir: "/somewhere/else" }],
    ["an expired context", { last_used_at: Date.now() - CONTEXT_TTL_MS - 1 }],
    ["an exhausted turn cap", { turns: MAX_CONTEXT_TURNS }],
  ];

  for (const [label, over] of refusals) {
    it(`refuses ${label} with context_unknown and no spawn`, async () => {
      let spawned = false;
      const { frames: f } = await oneCall(
        { message: "sneaky", context_id: SEEDED_CTX },
        {
          seed: seedBinding(over),
          frameCount: 1,
          run: async () => { spawned = true; return { text: "should not happen" }; },
        },
      );
      expect(f[0]).toMatchObject({ type: "call_failed", code: "context_unknown" });
      expect(spawned).toBe(false);
    });
  }

  // Not one of the six admitContext checks: the binding matches on every field
  // it stores, including the task *id*. What changed is the task itself. The
  // owner added `exec` to notes/SKILL.md after this binding was minted, so
  // deriveThreadable now says no -- and a binding minted an hour ago must not
  // outlive the decision it was minted under.
  it("refuses a context whose task has since become non-threadable, with no spawn", async () => {
    let spawned = false;
    const { frames: f } = await oneCall(
      { message: "and now rm -rf", context_id: SEEDED_CTX, task: "notes" },
      {
        frameCount: 1,
        run: async () => { spawned = true; return { text: "should not happen" }; },
        seed: (p) => {
          seedTask(p, "notes", ["description: d", "tools: [read, exec]"]);
          seedPolicy(p, { default_offer: ["ask", "notes"] });
          seedBinding({ task: "notes" })(p);
        },
      },
    );
    expect(f[0]).toMatchObject({ type: "call_failed", code: "context_unknown" });
    expect(spawned).toBe(false);
  });

  it("refuses an unknown context with no spawn", async () => {
    let spawned = false;
    const { frames: f } = await oneCall(
      { message: "sneaky", context_id: mintContextId() },
      { frameCount: 1, run: async () => { spawned = true; return { text: "no" }; } },
    );
    expect(f[0]).toMatchObject({ type: "call_failed", code: "context_unknown" });
    expect(spawned).toBe(false);
  });

  // One code for every reason. A refusal must not tell the caller whether the
  // token they guessed exists at all, nor which of the six checks rejected it.
  // Paired with the "unknown context" test above, which asserts the identical
  // frame for a token that was never minted: same keys, same values.
  it("gives a refusal no detail that distinguishes it from any other refusal", async () => {
    const { frames: f } = await oneCall(
      { message: "x", context_id: SEEDED_CTX },
      { seed: seedBinding({ caller: "mallory" }), frameCount: 1 },
    );
    expect(Object.keys(f[0]).sort()).toEqual(["call_id", "code", "type"]);
  });

  it("does not mint a context for a non-threadable task", async () => {
    const { frames: f, paths } = await oneCall({ message: "hi", task: "risky" }, {
      seed: (p) => {
        seedTask(p, "risky", ["description: d", "tools: [read, exec]"]);
        seedPolicy(p, { default_offer: ["ask", "risky"] });
      },
    });
    expect(f.find((x) => x.type === "call_result").context_id).toBeUndefined();
    expect(loadContexts(paths)).toHaveLength(0);
  });

  it("audits the context id and turn number", async () => {
    const { paths } = await oneCall({ message: "hi" });
    const line = JSON.parse(readFileSync(paths.callsLog, "utf8").trim().split("\n").at(-1)!);
    expect(line.context_id).toMatch(/^ctx_/);
    expect(line.turn).toBe(1);
    expect(JSON.stringify(line)).not.toContain("real-agent-session");
  });

  it("audits a refused context without spawning or minting", async () => {
    const { paths } = await oneCall(
      { message: "sneaky", context_id: SEEDED_CTX },
      { seed: seedBinding({ caller: "mallory" }), frameCount: 1 },
    );
    const line = JSON.parse(readFileSync(paths.callsLog, "utf8").trim().split("\n").at(-1)!);
    expect(line).toMatchObject({ status: "context_unknown", from: "sota", task: "ask" });
    // The refusal path must not roll the binding forward or touch its turn count.
    expect(loadContexts(paths)[0]!.turns).toBe(1);
  });
});
