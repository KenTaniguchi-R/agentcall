import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";
import { getPaths } from "../src/paths.js";
import { saveConfig } from "../src/config.js";
import { loadMemberships, readCached, saveMembership, writeCached } from "../src/rosters.js";

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

function seedConfig(testHome: string, relay: string): void {
  saveConfig(getPaths(testHome), { org: "acme", handle: "ken", token: "tok", relay });
}

const A = "a".repeat(22);
const B = "b".repeat(22);
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

  it("captures Commander validation failures without exiting the process", async () => {
    const out = await runCommand(home(), ["roster", "join", A]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/required option.*--secret/i);
  });

  it("persists a roster only after the relay accepts the join", async () => {
    let seen: { url?: string; method?: string; body?: string } = {};
    const relay = await startRelay((url, method, body) => {
      seen = { url, method, body };
      return { status: 200 };
    });
    const testHome = home();
    seedConfig(testHome, relay);

    const out = await runCommand(testHome, ["roster", "join", A, "--secret", "join-me", "--as", "acme"]);

    expect(out.code).toBe(0);
    expect(seen).toEqual({ url: `/v1/roster/${A}/join`, method: "POST", body: JSON.stringify({ secret: "join-me" }) });
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

    const out = await runCommand(testHome, ["roster", "join", B, "--secret", "spent", "--as", "acme"]);

    expect(joins).toBe(1); // Relay membership happened; there is no rollback operation.
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/roster forget/);
    expect(loadMemberships(getPaths(testHome))).toEqual([{ name: "acme", relay, roster_id: A }]);
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
});

describe("published CLI entry", () => {
  it("runs the built bin shim", () => {
    const bin = join(process.cwd(), "bin", "agentcall.js");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe("0.4.0");
  });
});
