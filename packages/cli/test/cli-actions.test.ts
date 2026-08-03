import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createProgram, runCli } from "../src/index.js";
import { getLinePaths, getMachinePaths, type LinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { loadMemberships, readCached, saveMembership, writeCached } from "../src/rosters.js";
import { loadOutbound, rememberOutbound } from "../src/contextsOut.js";
import { loadKnownPeers } from "../src/known-peers.js";
import { writeJsonAtomic } from "../src/json-store.js";
import {
  encryptionKeyTranscript, exportPublicKey, fingerprint, generateEncryptionKeyPair, identityTranscript,
  generateIdentityKeyPair, HPKE_SUITE, keyIdFor, RELAY_CALL_TIMEOUT_MS, requestTranscript,
  signTranscript, transcriptHash, type E2EEOutcomeType, type E2EEResponsePayloadType,
} from "@benree/agentcall-shared";
import { openE2EERequest, sealE2EEResponse } from "../src/e2ee.js";
import type { StoredKeys } from "../src/keys.js";

// The "local-sota" contact stands in for an address on whichever relay the
// current test spun up. pickOutboundLine (src/outbound.ts) now matches the
// destination's host against a LINE's own configured relay before placing a
// call, so a fixed placeholder host could never match a real seeded line.
// routing.host lets each test point the mocked resolution at its own
// ephemeral relay's host; vi.hoisted keeps the mutable ref safe against
// vi.mock's hoisting to the top of the module.
const routing = vi.hoisted(() => ({ host: "local.test" }));
vi.mock("../src/contacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/contacts.js")>();
  return {
    ...actual,
    resolveAddress: (...args: Parameters<typeof actual.resolveAddress>) =>
      args[1] === "local-sota"
        ? { ok: true as const, handle: "sota", host: routing.host, address: `sota@${routing.host}` }
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
  vi.unstubAllGlobals();
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

describe("cross-platform listener CLI", () => {
  it("describes the platform-neutral service opt-out during setup", () => {
    const setup = createProgram().commands.find((command) => command.name() === "setup");
    const options = setup?.options.map((option) => option.long);

    expect(options).toContain("--skip-service");
    expect(options).not.toContain("--skip-launchd");
  });

  it("uses the same service opt-out when adding another line", () => {
    const line = createProgram().commands.find((command) => command.name() === "line");
    const add = line?.commands.find((command) => command.name() === "add");
    const options = add?.options.map((option) => option.long);

    expect(options).toContain("--skip-service");
    expect(options).not.toContain("--skip-launchd");
  });
});

describe("trust CLI", () => {
  it("removes exactly one full-address pin only through --reset", async () => {
    const testHome = home();
    const machine = getMachinePaths(testHome, testHome);
    writeJsonAtomic(machine.knownPeersFile, { peers: [{
      address: "peer@relay.example", identity_pub: "abc",
      fingerprint: "SHA256:0123456789abcdef0123456789abcdef",
      first_seen_at: 1, highest_encryption_epoch: 1, call_count: 1,
    }] });
    const result = await runCommand(testHome, ["trust", "--reset", "peer@relay.example"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed the identity pin for peer@relay.example");
    expect(loadKnownPeers(machine)).toEqual([]);
  });

  it("prints a peer-verifiable fingerprint and exits nonzero on a later pin change", async () => {
    const identityBundle = async (address: string) => {
      const identity = await generateIdentityKeyPair();
      const identityPub = await exportPublicKey(identity.publicKey);
      const encryption = await generateEncryptionKeyPair();
      const pub = await exportPublicKey(encryption.publicKey);
      const record = {
        v: 1 as const, address, key_id: await keyIdFor(pub), suite: HPKE_SUITE, pub,
        epoch: 1, not_before: Date.now() - 1_000, not_after: Date.now() + 60_000, prev: null,
      };
      const identityRecord = { v: 1 as const, address, identity_pub: identityPub };
      return {
        expected: await fingerprint(identityTranscript(identityRecord)),
        response: {
          identity: identityRecord,
          encryption: { record, signature: await signTranscript(identity.privateKey, encryptionKeyTranscript(record)) },
        },
      };
    };
    let response: unknown;
    const relay = "https://local.test";
    routing.host = "local.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));
    const address = "sota@local.test";
    const firstIdentity = await identityBundle(address);
    response = firstIdentity.response;
    const testHome = home();
    seedConfig(testHome, relay);

    const first = await runCommand(testHome, ["verify", "local-sota"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain(`Pinned fingerprint: ${firstIdentity.expected}`);
    expect(first.stdout).toContain(`Served fingerprint: ${firstIdentity.expected}`);

    const replacement = await identityBundle(address);
    response = replacement.response;
    const changed = await runCommand(testHome, ["verify", "local-sota"]);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain(firstIdentity.expected);
    expect(changed.stderr).toContain(replacement.expected);
    expect(loadKnownPeers(getMachinePaths(testHome))[0]?.fingerprint).toBe(firstIdentity.expected);
  });
});

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

async function testKeys(): Promise<StoredKeys> {
  const identity = await generateIdentityKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const privateKey = async (key: CryptoKey) => Buffer.from(await crypto.subtle.exportKey("pkcs8", key)).toString("base64url");
  return {
    identity_pkcs8: await privateKey(identity.privateKey),
    identity_pub: await exportPublicKey(identity.publicKey),
    encryption_pkcs8: await privateKey(encryption.privateKey),
    encryption_pub: await exportPublicKey(encryption.publicKey),
    epoch: 1,
    previous_encryption_transcript_hash: null,
  };
}

const localCallKeys = new Map<string, StoredKeys>();

async function startCallRelay(
  onFrame: (
    frame: Record<string, unknown>,
    reply: (outcome: E2EEOutcomeType) => Promise<void>,
  ) => void | Promise<void>,
): Promise<{ relay: string; connections: () => number }> {
  const remote = await testKeys();
  const relayOrigin = "127.0.0.1";
  const remoteAddress = `sota@${relayOrigin}`;
  const identity = { v: 1 as const, address: remoteAddress, identity_pub: remote.identity_pub };
  const record = {
    v: 1 as const, address: remoteAddress, key_id: await keyIdFor(remote.encryption_pub),
    suite: HPKE_SUITE, pub: remote.encryption_pub, epoch: 1,
    not_before: Date.now() - 1_000, not_after: Date.now() + 60_000, prev: null,
  };
  const keyResponse = {
    identity,
    encryption: {
      record,
      signature: await signTranscript(
        await crypto.subtle.importKey(
          "pkcs8", Buffer.from(remote.identity_pkcs8, "base64url"),
          { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
        ),
        encryptionKeyTranscript(record),
      ),
    },
  };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/v1/keys/sota") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(keyResponse));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server, path: "/v1/ws" });
    let connectionCount = 0;
    wss.on("connection", (ws) => {
      connectionCount += 1;
      ws.on("message", async (raw) => {
        if (String(raw) === "ping") return;
        const outer = JSON.parse(String(raw));
        const local = localCallKeys.get(relayOrigin);
        if (!local) throw new Error("test caller keys were not seeded");
        const request = await openE2EERequest(
          outer.envelope, remote.encryption_pkcs8, local.identity_pub,
          {
            relay_origin: relayOrigin, from: `ken@${relayOrigin}`, to: remoteAddress,
            key_id: record.key_id, epoch: record.epoch,
          },
        );
        const reply = async (outcome: E2EEOutcomeType) => {
          const issuedAt = Date.now();
          const response: E2EEResponsePayloadType = {
            v: 1, direction: "response", relay_origin: relayOrigin,
            from: remoteAddress, to: `ken@${relayOrigin}`, request_id: request.request_id,
            sender_identity_key_id: await keyIdFor(remote.identity_pub),
            recipient_encryption_key_id: await keyIdFor(local.encryption_pub),
            recipient_epoch: local.epoch, issued_at: issuedAt,
            expires_at: Math.min(request.expires_at, issuedAt + RELAY_CALL_TIMEOUT_MS),
            request_transcript_hash: await transcriptHash(requestTranscript(request)), outcome,
          };
          ws.send(JSON.stringify({
            type: "call_outcome", call_id: `call-${connectionCount}`,
            terminal: outcome.kind === "reply" ? "completed" : "failed",
            envelope: await sealE2EEResponse(response, remote, {
              pub: local.encryption_pub, key_id: response.recipient_encryption_key_id, epoch: local.epoch,
            }),
          }));
        };
        await onFrame({
          type: "call_request", to: "sota", message: request.message,
          ...(request.task ? { task: request.task } : {}),
          ...(request.context_id ? { context_id: request.context_id } : {}),
        }, reply);
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

// Every cli-actions test runs a single line named "claude". With only one
// line on the machine, resolveLine/resolvePrimary (person.ts) picks it
// automatically, so no separate savePerson call is needed here.
function seedConfig(testHome: string, relay: string): LinePaths {
  const paths = getLinePaths(getMachinePaths(testHome), "claude");
  saveLineConfig(paths, { org: "acme", handle: "ken", token: "tok", relay });
  const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rawPublic = (key: ReturnType<typeof pair>["publicKey"]) => {
    const jwk = key.export({ format: "jwk" });
    return Buffer.concat([
      Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url"),
    ]).toString("base64url");
  };
  const identity = pair();
  const encryption = pair();
  const keys: StoredKeys = {
    identity_pkcs8: identity.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    identity_pub: rawPublic(identity.publicKey),
    encryption_pkcs8: encryption.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    encryption_pub: rawPublic(encryption.publicKey),
    epoch: 1,
    previous_encryption_transcript_hash: null,
  };
  writeJsonAtomic(paths.identityKeyFile, keys);
  localCallKeys.set(new URL(relay).hostname, keys);
  return paths;
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
  it("renders the employee's local call and tool history", async () => {
    const testHome = home();
    const paths = seedConfig(testHome, "https://relay.example");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.callsLog, [
      JSON.stringify({
        ts: "2026-08-02T20:00:00.000Z", call_id: "call-1", from: "alice",
        message: "review the patch", reply: "two findings", task: "review-pr",
        status: "ok", duration_ms: 42,
      }),
      JSON.stringify({
        ts: "2026-08-02T20:00:00.010Z", type: "tool_denied", call_id: "call-1",
        tool: "Bash", rule: "credential-read", detail: "blocked",
      }),
    ].join("\n") + "\n");
    writeFileSync(paths.toolsLog, [
      JSON.stringify({ ts: "2026-08-02T20:00:00.005Z", type: "tool_call", call_id: "call-1", tool: "Read", allowed: true }),
      JSON.stringify({ ts: "2026-08-02T20:00:00.010Z", type: "tool_call", call_id: "call-1", tool: "Bash", allowed: false }),
    ].join("\n") + "\n");

    const out = await runCommand(testHome, ["history"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("2026-08-02T20:00:00.000Z  alice  review-pr  ok  42ms");
    expect(out.stdout).toContain("Asked: review the patch");
    expect(out.stdout).toContain("Replied: two findings");
    expect(out.stdout).toContain("Tools: 2 attempts, 1 denied");
  });

  it("returns newest local history as JSON and discloses malformed log records", async () => {
    const testHome = home();
    const paths = seedConfig(testHome, "https://relay.example");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.callsLog, [
      JSON.stringify({
        ts: "2026-08-02T19:00:00.000Z", call_id: "old", from: "alice",
        message: "old question", task: "ask", status: "ok", duration_ms: 1,
      }),
      "not-json",
      JSON.stringify({
        ts: "2026-08-02T19:30:00.000Z", call_id: "broken", from: 42,
        message: "wrong type", status: "ok",
      }),
      JSON.stringify({
        ts: "2026-08-02T19:45:00.000Z", call_id: "forged", from: "mallory",
        message: "ordinary", status: "ok",
        flags: ["blocked_caller_attempt"], severity: "high",
      }),
      JSON.stringify({
        ts: "2026-08-02T20:00:00.000Z", call_id: "new", from: "bob",
        message: "new question", reply: "new answer", task: "ask", status: "ok", duration_ms: 2,
      }),
    ].join("\n") + "\n");
    writeFileSync(paths.toolsLog, JSON.stringify({
      ts: "2026-08-02T20:00:00.001Z", type: "tool_call", call_id: "new",
    }) + "\n");

    const out = await runCommand(testHome, ["history", "--limit", "1", "--json"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toContain("Skipped 4 malformed local history records");
    expect(JSON.parse(out.stdout)).toEqual([{
      ts: "2026-08-02T20:00:00.000Z", call_id: "new", from: "bob",
      message: "new question", reply: "new answer", task: "ask", status: "ok",
      duration_ms: 2, tool_attempts: 0, tools_denied: 0,
    }]);
  });

  it("filters objective local abuse signals and derives tool denials", async () => {
    const testHome = home();
    const paths = seedConfig(testHome, "https://relay.example");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.callsLog, [
      JSON.stringify({
        ts: "2026-08-02T19:00:00.000Z", call_id: "ordinary", from: "alice",
        message: "normal question", task: "ask", status: "ok",
      }),
      JSON.stringify({
        ts: "2026-08-02T19:30:00.000Z", call_id: "blocked", from: "mallory",
        message: "try anyway", task: "ask", status: "blocked",
        flags: ["blocked_caller_attempt"], severity: "high",
      }),
      JSON.stringify({
        ts: "2026-08-02T20:00:00.000Z", call_id: "denied-tool", from: "bob",
        message: "read it", task: "ask", status: "ok",
      }),
    ].join("\n") + "\n");
    writeFileSync(paths.toolsLog, JSON.stringify({
      ts: "2026-08-02T20:00:00.001Z", type: "tool_call",
      call_id: "denied-tool", tool: "Read", allowed: false,
    }) + "\n" + JSON.stringify({
      ts: "2026-08-02T19:00:00.001Z", type: "tool_call",
      call_id: "ordinary", tool: "Bash", mode: "observe", allowed: false,
    }) + "\n");

    const out = await runCommand(testHome, ["history", "--flagged", "--json"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toContain("Skipped 1 malformed local history record");
    expect(JSON.parse(out.stdout)).toMatchObject([
      { call_id: "denied-tool", flags: ["tool_policy_denial"], severity: "high" },
      { call_id: "blocked", flags: ["blocked_caller_attempt"], severity: "high" },
    ]);
    expect(out.stdout).not.toContain("ordinary");
  });

  it("bounds local history scanning and discloses partial logs", async () => {
    const testHome = home();
    const paths = seedConfig(testHome, "https://relay.example");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.callsLog,
      JSON.stringify({
        ts: "2026-08-02T19:00:00.000Z", call_id: "old", from: "alice",
        message: "old question", task: "ask", status: "ok",
      }) + "\n" + "x".repeat(4 * 1024 * 1024) + "\n" + JSON.stringify({
        ts: "2026-08-02T20:00:00.000Z", call_id: "new", from: "bob",
        message: "new question", task: "ask", status: "ok",
      }) + "\n");

    const out = await runCommand(testHome, ["history", "--limit", "1", "--json"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toMatch(/scan.*limited.*calls\.log/i);
    expect(JSON.parse(out.stdout)).toMatchObject([{ call_id: "new" }]);
  });

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

  it("creates, inventories, and revokes organization invites without reprinting secrets", async () => {
    const id = "d".repeat(64);
    const secret = "i".repeat(43);
    const metadata = {
      id, description: "contractor", created_by: "ken", created_at: 1,
      expires_at: 2_000_000_000_000, used_at: null, used_by: null, revoked_at: null,
    };
    const requests: Array<{ url: string; body: string }> = [];
    const relay = await startRelay((url, _method, body) => {
      requests.push({ url, body });
      if (url.endsWith("/list")) return { status: 200, body: { invites: [metadata] } };
      if (url.endsWith("/revoke")) return { status: 200, body: { id, revoked_at: 3 } };
      return { status: 200, body: { invite: secret, metadata } };
    });
    const testHome = home();
    seedConfig(testHome, relay);

    const created = await runCommand(testHome, [
      "invite", "create", "--description", "contractor", "--expires-in-days", "30", "--role", "admin",
    ]);
    const listed = await runCommand(testHome, ["invite", "list"]);
    const revoked = await runCommand(testHome, ["invite", "revoke", id]);

    expect(created).toMatchObject({ code: 0, stdout: secret });
    expect(created.stderr).toContain(`ID ${id}`);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([metadata]);
    expect(listed.stdout).not.toContain(secret);
    expect(revoked).toMatchObject({ code: 0, stdout: expect.stringContaining(`Revoked ${id}`) });
    expect(requests).toEqual([
      { url: "/v1/invites", body: JSON.stringify({ description: "contractor", expires_in_days: 30, role: "admin" }) },
      { url: "/v1/invites/list", body: "" },
      { url: `/v1/invites/${id}/revoke`, body: "" },
    ]);
  });

  it("streams every audit page as NDJSON and prints the final checkpoint", async () => {
    const requests: string[] = [];
    const relay = await startRelay((url) => {
      requests.push(url);
      const second = url.includes("page_token=next");
      return { status: 200, body: {
        events: [{
          ledger: second ? "roster" : "org", id: 1,
          event: second ? "roster.create" : "org.invite.issue", action_type: "C",
          roster_id: second ? "r1" : null, actor: "ken", actor_type: "handle",
          target_type: second ? "roster" : "invite", target_id: "target", target_role: null,
          actor_ip: null, actor_country: null, description: "event", at: second ? 2 : 1,
        }],
        checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 1, roster_event_count: 1 },
        next_page_token: second ? "" : "next",
        completion_receipt: null,
        acknowledged_checkpoint: null,
      } };
    });
    const testHome = home();
    seedConfig(testHome, relay);

    const out = await runCommand(testHome, [
      "audit", "export", "--after", "1970-01-01T00:00:00.000Z", "--before", "100", "--page-size", "1",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout.split("\n").map((line) => JSON.parse(line).ledger)).toEqual(["org", "roster"]);
    expect(out.stderr).toContain("Checkpoint org=1 roster=1");
    expect(requests).toEqual([
      "/v1/audit/events?after=0&before=100&page_size=1",
      "/v1/audit/events?after=0&before=100&page_size=1&page_token=next",
    ]);
  });

  it("forwards audit filters and streams spreadsheet-safe CSV", async () => {
    const requests: string[] = [];
    const relay = await startRelay((url) => {
      requests.push(url);
      return { status: 200, body: {
        events: [{
          ledger: "org", id: 1, event: "org.invite.issue", action_type: "C", roster_id: null,
          actor: "ken", actor_type: "handle", target_type: "invite", target_id: "target",
          target_role: "member", actor_ip: "203.0.113.10", actor_country: "US",
          description: "=1+1, \"sensitive\"", at: 1,
        }],
        checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 0, roster_event_count: 0 },
        next_page_token: "",
        completion_receipt: null,
        acknowledged_checkpoint: null,
      } };
    });
    const testHome = home();
    seedConfig(testHome, relay);

    const out = await runCommand(testHome, [
      "audit", "export", "--actor", "ken", "--event", "org.invite.issue",
      "--ip", "203.0.113.10", "--format", "csv",
    ]);
    expect(out.code).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines[0]).toBe(
      "ledger,id,event,action_type,roster_id,actor,actor_type,target_type,target_id,target_role,actor_ip,actor_country,description,at",
    );
    expect(lines[1]).toContain('"\'=1+1, ""sensitive"""');
    expect(requests).toEqual([
      "/v1/audit/events?actor=ken&event=org.invite.issue&actor_ip=203.0.113.10&page_size=100",
    ]);
  });

  it("rejects invalid audit time and page size before contacting the relay", async () => {
    const testHome = home();
    seedConfig(testHome, "http://127.0.0.1:1");
    const invalidTime = await runCommand(testHome, ["audit", "export", "--after", "not-a-time"]);
    expect(invalidTime.code).toBe(1);
    expect(invalidTime.stderr).toContain("--after must be an epoch-millisecond or ISO timestamp");
    const invalidPage = await runCommand(testHome, ["audit", "export", "--page-size", "501"]);
    expect(invalidPage.code).toBe(1);
    expect(invalidPage.stderr).toContain("--page-size must be an integer from 1 to 500");
    const invalidFormat = await runCommand(testHome, ["audit", "export", "--format", "xml"]);
    expect(invalidFormat.code).toBe(1);
    expect(invalidFormat.stderr).toContain("--format must be ndjson or csv");
    const invalidFilter = await runCommand(testHome, ["audit", "export", "--actor", ""]);
    expect(invalidFilter.code).toBe(1);
    expect(invalidFilter.stderr).toContain("--actor must contain 1 to 256 UTF-8 bytes");
    const multibyteFilter = await runCommand(testHome, ["audit", "export", "--event", "é".repeat(129)]);
    expect(multibyteFilter.code).toBe(1);
    expect(multibyteFilter.stderr).toContain("--event must contain 1 to 256 UTF-8 bytes");
  });

  it("does not print a final checkpoint when a paged snapshot becomes incomplete", async () => {
    const relay = await startRelay((url) => url.includes("page_token=next")
      ? { status: 409, body: { error: "audit snapshot changed; restart export" } }
      : { status: 200, body: {
        events: [{
          ledger: "org", id: 1, event: "org.invite.issue", action_type: "C", roster_id: null,
          actor: "ken", actor_type: "handle", target_type: "invite", target_id: "target",
          target_role: "member", actor_ip: null, actor_country: null, description: "event", at: 1,
        }],
        checkpoint: { org_event_id: 2, org_event_count: 2, roster_event_id: 0, roster_event_count: 0 },
        next_page_token: "next",
        completion_receipt: null,
        acknowledged_checkpoint: null,
      } });
    const testHome = home();
    seedConfig(testHome, relay);
    const out = await runCommand(testHome, ["audit", "export", "--page-size", "1"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('"target_id":"target"');
    expect(out.stderr).toContain("Discard the partial output and retry");
    expect(out.stderr).not.toContain("Checkpoint org=");
  });

  it("captures Commander validation failures without exiting the process", async () => {
    const out = await runCommand(home(), ["roster", "join", A]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/required option.*--key/i);
  });

  it("exposes policy assertion failures through agentcall lint", async () => {
    const testHome = home();
    const paths = getLinePaths(getMachinePaths(testHome), "claude");
    saveLineConfig(paths, { org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude" });
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
    const paths = getLinePaths(getMachinePaths(testHome), "claude");
    saveLineConfig(paths, {
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
    expect(out.stdout).toContain("does not restrict them to an AgentCall domain allowlist");
    expect(out.stdout).toMatch(new RegExp(`Everyone registered[\\s\\S]*ask — Ask a question[\\s\\S]*Working directory: ${paths.shareDir}`));
    expect(out.stdout).toMatch(/Named caller rule: alice \(before roster grants\)[\s\S]*deploy — Deploy production[\s\S]*exec — run shell commands/);
    expect(out.stdout).toContain("WARNING: exec can read, change, and send data outside this working directory");
    expect(out.stdout).toMatch(/Named caller rule: blocked-bot \(before roster grants\)[\s\S]*BLOCKED — no task can run/);
  });

  it("rejects a CLI policy edit that would break an assertion and preserves the file", async () => {
    const testHome = home();
    const paths = getLinePaths(getMachinePaths(testHome), "claude");
    saveLineConfig(paths, { org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude" });
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
    saveMembership(getLinePaths(getMachinePaths(testHome), "claude"), { name: "roster", relay, roster_id: A });

    const out = await runCommand(testHome, ["roster", "create"]);

    expect(creates).toBe(1);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(B);
    expect(out.stdout).toContain(JOIN_KEY);
    expect(out.stdout).toContain("admin-once");
    expect(out.stderr).toMatch(/roster was created.*not saved locally/is);
    expect(out.stderr).toContain(`agentcall roster join ${B}`);
    expect(loadMemberships(getLinePaths(getMachinePaths(testHome), "claude"))).toEqual([{ name: "roster", relay, roster_id: A }]);
  });

  it("persists a roster only after the relay accepts the join", async () => {
    let seen: { url?: string; method?: string; body?: string } = {};
    const relay = await startRelay((url, method, body) => {
      seen = { url, method, body };
      return { status: 200 };
    });
    const testHome = home();
    const paths = seedConfig(testHome, relay);

    const out = await runCommand(testHome, ["roster", "join", A, "--key", JOIN_KEY, "--as", "acme"]);

    expect(out.code).toBe(0);
    expect(seen).toEqual({ url: `/v1/roster/${A}/join`, method: "POST", body: JSON.stringify({ join_key: JOIN_KEY }) });
    expect(loadMemberships(paths)).toEqual([{ name: "acme", relay, roster_id: A }]);
  });

  it("preserves an existing local membership when a successful relay join collides", async () => {
    let joins = 0;
    const relay = await startRelay(() => {
      joins += 1;
      return { status: 200 };
    });
    const testHome = home();
    const paths = seedConfig(testHome, relay);
    saveMembership(paths, { name: "acme", relay, roster_id: A });

    const out = await runCommand(testHome, ["roster", "join", B, "--key", JOIN_KEY, "--as", "acme"]);

    expect(joins).toBe(1); // Relay membership happened; there is no rollback operation.
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/joined.*not saved locally/is);
    expect(out.stderr).toContain(`agentcall roster join ${B}`);
    expect(loadMemberships(paths)).toEqual([{ name: "acme", relay, roster_id: A }]);
  });

  it("removes local membership only after the relay accepts leave", async () => {
    let seen = "";
    const relay = await startRelay((url) => {
      seen = url;
      return { status: 200 };
    });
    const testHome = home();
    const paths = seedConfig(testHome, relay);
    saveMembership(paths, { name: "acme", relay, roster_id: A });

    const out = await runCommand(testHome, ["roster", "leave", "acme"]);

    expect(out.code).toBe(0);
    expect(seen).toBe(`/v1/roster/${A}/leave`);
    expect(loadMemberships(paths)).toEqual([]);
  });

  it("passes explicit confirmation for join-key-scoped eviction", async () => {
    let seen: { url?: string; body?: string } = {};
    const relay = await startRelay((url, _method, body) => {
      seen = { url, body };
      return { status: 200, body: { prefix: KEY_PREFIX, revoked_at: 3, evicted: 2 } };
    });
    const testHome = home();
    const paths = seedConfig(testHome, relay);
    saveMembership(paths, { name: "acme", relay, roster_id: A });

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
    saveMembership(getLinePaths(getMachinePaths(testHome), "claude"), { name: "acme", relay, roster_id: A });

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
    const paths = seedConfig(testHome, relay);
    saveMembership(paths, { name: "working", relay, roster_id: A });
    saveMembership(paths, { name: "broken", relay, roster_id: B });

    const out = await runCommand(testHome, ["search", "typescript", "--json"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toMatch(/broken:/);
    const json = JSON.parse(out.stdout);
    expect(json.results).toMatchObject([{ roster: "working", handle: "sota", task: "ask" }]);
  });

  it("returns failure when every roster refresh fails", async () => {
    const relay = await startRelay(() => ({ status: 500, body: { error: "down" } }));
    const testHome = home();
    const paths = seedConfig(testHome, relay);
    saveMembership(paths, { name: "one", relay, roster_id: A });
    saveMembership(paths, { name: "two", relay, roster_id: B });

    const out = await runCommand(testHome, ["search", "typescript", "--json"]);

    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout).results).toEqual([]);
  });

  it("does not resurrect a revoked roster in a later offline invocation", async () => {
    const relay = await startRelay(() => ({ status: 404, body: { error: "gone" } }));
    const testHome = home();
    const paths = seedConfig(testHome, relay);
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
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    seedConfig(testHome, callRelay.relay);

    const out = await runCommand(testHome, ["call", "local-sota", "follow up", "--continue"]);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/No open conversation/);
    expect(callRelay.connections()).toBe(0);
  });

  it("refuses an accidental nested call from an inbound answering process", async () => {
    const callRelay = await startCallRelay(() => {});
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    seedConfig(testHome, callRelay.relay);
    const previousCallId = process.env.AGENTCALL_CALL_ID;
    process.env.AGENTCALL_CALL_ID = "inbound-call";
    try {
      const out = await runCommand(testHome, ["call", "local-sota", "delegate this"]);

      expect(out.code).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toMatch(/nested agentcall calls are disabled/i);
      expect(out.stderr).toMatch(/per-run credential/i);
      expect(callRelay.connections()).toBe(0);
    } finally {
      if (previousCallId === undefined) delete process.env.AGENTCALL_CALL_ID;
      else process.env.AGENTCALL_CALL_ID = previousCallId;
    }
  });

  it("rejects --continue with --context before opening a WebSocket", async () => {
    const callRelay = await startCallRelay(() => {});
    routing.host = new URL(callRelay.relay).host;
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
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    const paths = seedConfig(testHome, callRelay.relay);
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
    const callRelay = await startCallRelay(async (frame, reply) => {
      frames.push(frame);
      await reply({ kind: "reply", text: `reply-${frames.length}`, task: "resolved-task", context_id: contextId });
    });
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    const paths = seedConfig(testHome, callRelay.relay);

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

  it("neutralizes terminal controls and bidi overrides in displayed reply text", async () => {
    const hostile = "line one\n\tline two\u001b[2J\rFAKE\u009b31m\u202espoof";
    const callRelay = await startCallRelay(async (_frame, reply) => {
      await reply({ kind: "reply", text: hostile });
    });
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    seedConfig(testHome, callRelay.relay);

    const out = await runCommand(testHome, ["call", "local-sota", "hello"]);

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("line one\n\tline two");
    expect(out.stdout).toContain("FAKE");
    expect(out.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("preserves the exact reply payload under --json", async () => {
    const hostile = "line one\n\u001b[2J\rFAKE\u009b31m\u202espoof";
    const callRelay = await startCallRelay(async (_frame, reply) => {
      await reply({ kind: "reply", text: hostile });
    });
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    seedConfig(testHome, callRelay.relay);

    const out = await runCommand(testHome, ["call", "local-sota", "hello", "--json"]);

    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).text).toBe(hostile);
    expect(out.stdout).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("neutralizes terminal controls in peer-authored card text", async () => {
    const relay = await startRelay((url, method) => ({
      status: url === "/v1/card/sota" && method === "GET" ? 200 : 404,
      body: {
        handle: "sota", agent_kind: "claude", description: "safe\u001b[2J\u202espoof",
        tasks: [{
          id: "ask", name: "Ask", description: "answer\rFAKE",
          examples: ["normal\u009b31mexample"], keywords: [],
        }],
        updated_at: 1,
      },
    }));
    const testHome = home();
    seedConfig(testHome, relay);

    const out = await runCommand(testHome, ["card", "local-sota"]);

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("spoof");
    expect(out.stdout).toContain("FAKE");
    expect(out.stdout).toContain("example");
    expect(out.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });
});

describe("published CLI entry", () => {
  it("runs the built bin shim", () => {
    const bin = join(process.cwd(), "bin", "agentcall.js");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe("0.4.0");
  });
});
