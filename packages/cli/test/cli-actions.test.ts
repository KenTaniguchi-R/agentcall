import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { runCli } from "../src/index.js";
import { getPaths } from "../src/paths.js";
import { saveConfig } from "../src/config.js";
import { loadMemberships, readCached, saveMembership, writeCached } from "../src/rosters.js";
import { loadOutbound, rememberOutbound } from "../src/contextsOut.js";

vi.mock("../src/contacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/contacts.js")>();
  return {
    ...actual,
    resolveAddress: (...args: Parameters<typeof actual.resolveAddress>) =>
      args[1] === "local-sota"
        ? { ok: true as const, handle: "sota", host: "local.test", address: "sota@local.test" }
        : actual.resolveAddress(...args),
  };
});

// These tests cross the Commander seam. They assert wiring: argument parsing,
// stream routing, exit status, relay requests, and durable state. Business
// rules stay in their module tests. Never make this file concurrent: env vars,
// console spies, and process.exitCode are process-global.
//
// `setup` and `listen` are deliberately excluded. Setup mutates launchd and
// listen installs process handlers plus a keepalive timer; neither belongs in
// an in-process command harness.

type Run = { code: number; stdout: string; stderr: string };
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  vi.restoreAllMocks();
});

async function runCommand(home: string, argv: string[]): Promise<Run> {
  const previousHome = process.env.AGENTCALL_HOME;
  const previousRelay = process.env.AGENTCALL_RELAY;
  process.env.AGENTCALL_HOME = home;
  delete process.env.AGENTCALL_RELAY;
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  try {
    const code = await runCli(argv, {
      writeOut: (text) => stdout.push(text.trimEnd()),
      writeErr: (text) => stderr.push(text.trimEnd()),
    });
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    if (previousHome === undefined) delete process.env.AGENTCALL_HOME;
    else process.env.AGENTCALL_HOME = previousHome;
    if (previousRelay === undefined) delete process.env.AGENTCALL_RELAY;
    else process.env.AGENTCALL_RELAY = previousRelay;
  }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "agentcall-cli-"));
}

function startRelay(
  handler: (url: string, method: string, body: string) => { status: number; body?: unknown; headers?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const out = handler(req.url ?? "", req.method ?? "GET", raw);
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(out.body === undefined ? "" : JSON.stringify(out.body));
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
}

function startCallRelay(
  onFrame: (frame: Record<string, unknown>, ws: import("ws").WebSocket) => void,
): Promise<{ relay: string; connections: () => number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server, path: "/v1/ws" });
    let connectionCount = 0;
    wss.on("connection", (ws) => {
      connectionCount += 1;
      ws.on("message", (raw) => {
        if (String(raw) !== "ping") onFrame(JSON.parse(String(raw)), ws);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        relay: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        connections: () => connectionCount,
      });
    });
  });
}

function seedConfig(testHome: string, relay: string): void {
  saveConfig(getPaths(testHome), { org: "acme", handle: "ken", token: "tok", relay });
}

const A = "a".repeat(22);
const B = "b".repeat(22);
const KEY_PREFIX = "c".repeat(12);
const JOIN_KEY = `agjk_${KEY_PREFIX}_${"s".repeat(32)}`;
const bundle = (rosterId: string, handle = "sota") => ({
  roster_id: rosterId,
  entries: [{
    handle,
    agent_kind: "claude" as const,
    updated_at: 1,
    truncated: false,
    tasks: [{ id: "ask", name: "Ask", description: "TypeScript architecture", keywords: ["typescript"] }],
  }],
  skipped: 0,
});

describe.sequential("CLI command actions", () => {
  it("preserves the top-level no-config failure path", async () => {
    const out = await runCommand(home(), ["search", "typescript"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/agentcall setup/);
  });

  it("requires setup before fetching another agent's card", async () => {
    const out = await runCommand(home(), ["card", "ken@acme.agentcall.benree.tech"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/agentcall setup/);
  });

  it("captures Commander validation failures without exiting the process", async () => {
    const out = await runCommand(home(), ["roster", "join", A]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/required option.*--key/i);
  });

  it("exposes policy assertion failures through agentcall lint", async () => {
    const testHome = home();
    const paths = getPaths(testHome);
    saveConfig(paths, { org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude" });
    mkdirSync(join(testHome, ".agentcall"), { recursive: true });
    writeFileSync(paths.policyFile, JSON.stringify({
      default_offer: ["ask"], tests: [{ caller: "mia", deny: ["ask"] }],
    }));

    const out = await runCommand(testHome, ["lint"]);

    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/assertion 1.*ask/i);
  });

  it("renders the effective policy as a per-caller and per-task capability report", async () => {
    const testHome = home();
    const paths = getPaths(testHome);
    saveConfig(paths, {
      org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude",
    });
    mkdirSync(join(paths.tasksDir, "deploy"), { recursive: true });
    writeFileSync(join(paths.tasksDir, "deploy", "SKILL.md"), [
      "---",
      "name: Deploy production",
      "description: Build and deploy the service.",
      "tools: [read, write, exec]",
      "---",
      "Deploy carefully.",
    ].join("\n"));
    writeFileSync(paths.policyFile, JSON.stringify({
      default_offer: ["ask"],
      callers: {
        alice: { offer: ["deploy"] },
        "blocked-bot": { block: true },
      },
    }));

    const out = await runCommand(testHome, ["policy"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("Effective capability policy");
    expect(out.stdout).toMatch(new RegExp(`Everyone registered[\\s\\S]*ask — Ask a question[\\s\\S]*Working directory: ${paths.publicDir}`));
    expect(out.stdout).toMatch(/Named caller rule: alice \(before roster grants\)[\s\S]*deploy — Deploy production[\s\S]*exec — run shell commands/);
    expect(out.stdout).toContain("WARNING: exec can read, change, and send data outside this working directory");
    expect(out.stdout).toMatch(/Named caller rule: blocked-bot \(before roster grants\)[\s\S]*BLOCKED — no task can run/);
  });

  it("rejects a CLI policy edit that would break an assertion and preserves the file", async () => {
    const testHome = home();
    const paths = getPaths(testHome);
    saveConfig(paths, { org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude" });
    mkdirSync(join(testHome, ".agentcall"), { recursive: true });
    const original = {
      default_offer: ["ask"], tests: [{ caller: "mia", accept: ["ask"] }],
    };
    writeFileSync(paths.policyFile, JSON.stringify(original));

    const out = await runCommand(testHome, ["unoffer", "ask"]);

    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/assertion 1.*ask/i);
    expect(JSON.parse(readFileSync(paths.policyFile, "utf8"))).toEqual(original);
  });

  it("prints one-time roster credentials before a colliding local save can fail", async () => {
    let creates = 0;
    const relay = await startRelay(() => {
      creates += 1;
      return {
        status: 200,
        body: { roster_id: B, join_key: JOIN_KEY, admin_secret: "admin-once" },
      };
    });
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "roster", relay, roster_id: A });

    const out = await runCommand(testHome, ["roster", "create"]);

    expect(creates).toBe(1);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(B);
    expect(out.stdout).toContain(JOIN_KEY);
    expect(out.stdout).toContain("admin-once");
    expect(out.stderr).toMatch(/roster was created.*not saved locally/is);
    expect(out.stderr).toContain(`agentcall roster join ${B}`);
    expect(loadMemberships(getPaths(testHome))).toEqual([{ name: "roster", relay, roster_id: A }]);
  });

  it("persists a roster only after the relay accepts the join", async () => {
    let seen: { url?: string; method?: string; body?: string } = {};
    const relay = await startRelay((url, method, body) => {
      seen = { url, method, body };
      return { status: 200 };
    });
    const testHome = home();
    seedConfig(testHome, relay);

    const out = await runCommand(testHome, ["roster", "join", A, "--key", JOIN_KEY, "--as", "acme"]);

    expect(out.code).toBe(0);
    expect(seen).toEqual({ url: `/v1/roster/${A}/join`, method: "POST", body: JSON.stringify({ join_key: JOIN_KEY }) });
    expect(loadMemberships(getPaths(testHome))).toEqual([{ name: "acme", relay, roster_id: A }]);
  });

  it("preserves an existing local membership when a successful relay join collides", async () => {
    let joins = 0;
    const relay = await startRelay(() => {
      joins += 1;
      return { status: 200 };
    });
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "acme", relay, roster_id: A });

    const out = await runCommand(testHome, ["roster", "join", B, "--key", JOIN_KEY, "--as", "acme"]);

    expect(joins).toBe(1); // Relay membership happened; there is no rollback operation.
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/joined.*not saved locally/is);
    expect(out.stderr).toContain(`agentcall roster join ${B}`);
    expect(loadMemberships(getPaths(testHome))).toEqual([{ name: "acme", relay, roster_id: A }]);
  });

  it("removes local membership only after the relay accepts leave", async () => {
    let seen = "";
    const relay = await startRelay((url) => {
      seen = url;
      return { status: 200 };
    });
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "acme", relay, roster_id: A });

    const out = await runCommand(testHome, ["roster", "leave", "acme"]);

    expect(out.code).toBe(0);
    expect(seen).toBe(`/v1/roster/${A}/leave`);
    expect(loadMemberships(getPaths(testHome))).toEqual([]);
  });

  it("passes explicit confirmation for join-key-scoped eviction", async () => {
    let seen: { url?: string; body?: string } = {};
    const relay = await startRelay((url, _method, body) => {
      seen = { url, body };
      return { status: 200, body: { prefix: KEY_PREFIX, revoked_at: 3, evicted: 2 } };
    });
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "acme", relay, roster_id: A });

    const out = await runCommand(testHome, [
      "roster", "key", "revoke", "acme", KEY_PREFIX, "--evict", "--yes", "--admin-secret", "admin-secret",
    ]);

    expect(out.code).toBe(0);
    expect(seen).toEqual({
      url: `/v1/roster/${A}/keys/${KEY_PREFIX}/revoke`,
      body: JSON.stringify({ admin_secret: "admin-secret", evict: true }),
    });
    expect(out.stdout).toContain("Evicted 2 member(s)");
  });

  it("issues a key once and lists metadata without a secret", async () => {
    const metadata = {
      prefix: KEY_PREFIX, description: "contractor", created_by: "ken", created_at: 1, expires_at: 2_000_000_000_000,
      reusable: true, used: false, revoked_at: null,
    };
    const requests: { url: string; body?: string }[] = [];
    const relay = await startRelay((url, _method, body) => {
      requests.push({ url, body });
      return url.endsWith("/keys/list")
        ? { status: 200, body: { keys: [metadata] } }
        : { status: 200, body: { join_key: JOIN_KEY, key: metadata } };
    });
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "acme", relay, roster_id: A });

    const issued = await runCommand(testHome, [
      "roster", "key", "issue", "acme", "--description", "contractor", "--expires-in", "14",
      "--reusable", "--admin-secret", "admin-secret",
    ]);
    const listed = await runCommand(testHome, [
      "roster", "key", "list", "acme", "--admin-secret", "admin-secret",
    ]);

    expect(issued.code).toBe(0);
    expect(issued.stdout).toContain(JOIN_KEY);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`${KEY_PREFIX}\tactive\treusable`);
    expect(listed.stdout).not.toContain(JOIN_KEY);
    expect(requests).toEqual([
      {
        url: `/v1/roster/${A}/keys`,
        body: JSON.stringify({
          admin_secret: "admin-secret", description: "contractor", expires_in_days: 14, reusable: true,
        }),
      },
      { url: `/v1/roster/${A}/keys/list`, body: JSON.stringify({ admin_secret: "admin-secret" }) },
    ]);
  });

  it("keeps JSON stdout parseable when one roster refresh fails", async () => {
    const relay = await startRelay((url) =>
      url.includes(A) ? { status: 200, body: bundle(A), headers: { ETag: '"a1"' } } : { status: 500, body: { error: "down" } });
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "working", relay, roster_id: A });
    saveMembership(getPaths(testHome), { name: "broken", relay, roster_id: B });

    const out = await runCommand(testHome, ["search", "typescript", "--json"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toMatch(/broken:/);
    const json = JSON.parse(out.stdout);
    expect(json.results).toMatchObject([{ roster: "working", handle: "sota", task: "ask" }]);
  });

  it("returns failure when every roster refresh fails", async () => {
    const relay = await startRelay(() => ({ status: 500, body: { error: "down" } }));
    const testHome = home();
    seedConfig(testHome, relay);
    saveMembership(getPaths(testHome), { name: "one", relay, roster_id: A });
    saveMembership(getPaths(testHome), { name: "two", relay, roster_id: B });

    const out = await runCommand(testHome, ["search", "typescript", "--json"]);

    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).results).toEqual([]);
  });

  it("does not resurrect a revoked roster in a later offline invocation", async () => {
    const relay = await startRelay(() => ({ status: 404, body: { error: "gone" } }));
    const testHome = home();
    const paths = getPaths(testHome);
    seedConfig(testHome, relay);
    saveMembership(paths, { name: "acme", relay, roster_id: A });
    writeCached(paths, "acme", {
      relay, caller: "ken", roster_id: A, fetched_at: 0,
      entries: bundle(A).entries, skipped: 0,
    });

    const online = await runCommand(testHome, ["search", "typescript"]);
    expect(online.code).toBe(1);
    expect(readCached(paths, "acme", { relay, caller: "ken", roster_id: A })).toBeNull();

    const offline = await runCommand(testHome, ["search", "typescript", "--offline"]);
    expect(offline.code).toBe(1);
    expect(offline.stderr).toMatch(/never been fetched/);
  });

  it("rejects --continue with no stored conversation before opening a WebSocket", async () => {
    const callRelay = await startCallRelay(() => {});
    const testHome = home();
    seedConfig(testHome, callRelay.relay);

    const out = await runCommand(testHome, ["call", "local-sota", "follow up", "--continue"]);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/No open conversation/);
    expect(callRelay.connections()).toBe(0);
  });

  it("rejects --continue with --context before opening a WebSocket", async () => {
    const callRelay = await startCallRelay(() => {});
    const testHome = home();
    seedConfig(testHome, callRelay.relay);

    const out = await runCommand(testHome, [
      "call", "local-sota", "follow up", "--continue", "--context", "ctx_AAAAAAAAAAAAAAAAAAAAAA",
    ]);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/--continue or --context/);
    expect(callRelay.connections()).toBe(0);
  });

  it("rejects a --task that conflicts with the continued conversation before opening a WebSocket", async () => {
    const callRelay = await startCallRelay(() => {});
    const testHome = home();
    const paths = getPaths(testHome);
    seedConfig(testHome, callRelay.relay);
    rememberOutbound(paths, {
      relay: callRelay.relay, from: "ken", to: "sota", task: "resolved-task",
      context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA", at: 1,
    });

    const out = await runCommand(testHome, [
      "call", "local-sota", "follow up", "--continue", "--task", "other-task",
    ]);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/conversation is on task.*resolved-task.*not.*other-task/i);
    expect(callRelay.connections()).toBe(0);
  });

  it("stores a returned context and continues it with the resolved task while keeping stdout parseable", async () => {
    const frames: Record<string, unknown>[] = [];
    const contextId = "ctx_AAAAAAAAAAAAAAAAAAAAAA";
    const callRelay = await startCallRelay((frame, ws) => {
      frames.push(frame);
      ws.send(JSON.stringify({
        type: "call_reply", call_id: `call-${frames.length}`, text: `reply-${frames.length}`,
        task: "resolved-task", context_id: contextId,
      }));
    });
    const testHome = home();
    const paths = getPaths(testHome);
    seedConfig(testHome, callRelay.relay);

    const first = await runCommand(testHome, ["call", "local-sota", "hello", "--json"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ text: "reply-1", task: "resolved-task", context_id: contextId });
    expect(first.stderr).toMatch(/conversation open.*--continue/);
    expect(loadOutbound(paths)).toMatchObject([{
      relay: callRelay.relay, from: "ken", to: "sota", task: "resolved-task", context_id: contextId,
    }]);

    const second = await runCommand(testHome, ["call", "local-sota", "follow up", "--continue", "--json"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ text: "reply-2" });
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      type: "call_request", to: "sota", message: "follow up", task: "resolved-task", context_id: contextId,
    });
  });
});

describe("published CLI entry", () => {
  it("runs the built bin shim", () => {
    const bin = join(process.cwd(), "bin", "agentcall.js");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe("0.4.0");
  });
});
