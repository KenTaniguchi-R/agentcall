import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createProgram, runCli } from "../src/index.js";
import { getPaths, type Paths } from "../src/paths.js";
import { saveConfig } from "../src/config.js";
import { loadOutbound, rememberOutbound } from "../src/contexts-out.js";
import { loadKnownPeers, verifyAndPinPeer } from "../src/known-peers.js";
import { writeJsonAtomic } from "../src/json-store.js";
import {
  encryptionKeyTranscript, exportPublicKey, fingerprint, generateEncryptionKeyPair, identityTranscript,
  generateIdentityKeyPair, HPKE_SUITE, keyIdFor, RELAY_CALL_TIMEOUT_MS, requestTranscript,
  signTranscript, transcriptHash, type E2EEOutcomeType, type E2EEResponsePayloadType,
  type OrgInviteMetadataType,
} from "@benree/agentcall-shared";
import { openE2EERequest, sealE2EEResponse } from "../src/e2ee.js";
import type { StoredKeys } from "../src/keys.js";
import { tempDir } from "./helpers.js";

// The "local-sota" contact stands in for a colleague in the caller's own
// organization. pickOutboundLine (src/outbound.ts) matches the destination's
// ORG against a LINE's configured org — it used to match relay hosts, which is
// why this stub used to carry one. routing.org lets a test point the mocked
// resolution at whatever org it seeded; vi.hoisted keeps the mutable ref safe
// against vi.mock's hoisting to the top of the module.
const routing = vi.hoisted(() => ({ host: "local.test", org: "acme" }));
vi.mock("../src/contacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/contacts.js")>();
  return {
    ...actual,
    resolveAddress: (...args: Parameters<typeof actual.resolveAddress>) =>
      args[1] === "local-sota"
        ? { ok: true as const, org: routing.org, handle: "sota", address: `@${routing.org}/sota` }
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
  const previousUserHome = process.env.HOME;
  const previousRelay = process.env.AGENTCALL_RELAY;
  process.env.AGENTCALL_HOME = home;
  process.env.HOME = home;
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
    if (previousUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousUserHome;
    if (previousRelay === undefined) delete process.env.AGENTCALL_RELAY;
    else process.env.AGENTCALL_RELAY = previousRelay;
  }
}

function home(): string {
  return tempDir("agentcall-cli-");
}

describe("cross-platform listener CLI", () => {
  it("describes the platform-neutral service opt-out during setup", () => {
    const setup = createProgram().commands.find((command) => command.name() === "setup");
    const options = setup?.options.map((option) => option.long);

    expect(options).toContain("--skip-service");
    expect(options).not.toContain("--skip-launchd");
  });

});

describe("trust CLI", () => {
  it("removes exactly one full-address pin only through --reset", async () => {
    const testHome = home();
    const machine = getPaths(testHome, testHome);
    writeJsonAtomic(machine.knownPeersFile, { peers: [{
      relay_origin: "relay.example",
      address: "@acme/peer", identity_pub: "abc",
      fingerprint: "SHA256:0123456789abcdef0123456789abcdef",
      first_seen_at: 1, highest_encryption_epoch: 1, call_count: 1,
    }] });
    const result = await runCommand(testHome, ["trust", "--reset", "@acme/peer"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed the identity pin for @acme/peer");
    expect(loadKnownPeers(machine)).toEqual([]);
  });

  it("prints a peer-verifiable fingerprint and exits nonzero on a later pin change", async () => {
    const identityBundle = async (address: string) => {
      const identity = await generateIdentityKeyPair();
      const identityPub = await exportPublicKey(identity.publicKey);
      const encryption = await generateEncryptionKeyPair();
      const pub = await exportPublicKey(encryption.publicKey);
      const record = {
        v: 1 as const, relay_origin: "relay.test",
        address, key_id: await keyIdFor(pub), suite: HPKE_SUITE, pub,
        epoch: 1, not_before: Date.now() - 1_000, not_after: Date.now() + 60_000, prev: null,
      };
      const identityRecord = {
        v: 1 as const, relay_origin: "relay.test",
        address, identity_pub: identityPub,
      };
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
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes("/v1/card/")
        ? { handle: "sota", description: "", agent_kind: "claude", tasks: [], updated_at: 1 }
        : response;
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const address = "@acme/sota";
    const firstIdentity = await identityBundle(address);
    response = firstIdentity.response;
    const testHome = home();
    seedConfig(testHome, relay);

    const first = await runCommand(testHome, ["inspect", "local-sota", "--json"]);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      address,
      availability: { state: "undisclosed" },
      identity: { state: "unseen", served_fingerprint: firstIdentity.expected },
      card: { state: "available", value: { handle: "sota" } },
    });
    expect(loadKnownPeers(getPaths(testHome))).toEqual([]);

    await verifyAndPinPeer(getPaths(testHome), address, firstIdentity.response);

    const replacement = await identityBundle(address);
    response = replacement.response;
    const changed = await runCommand(testHome, ["inspect", "local-sota"]);
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain(firstIdentity.expected);
    expect(changed.stdout).toContain(replacement.expected);
    expect(loadKnownPeers(getPaths(testHome))[0]?.fingerprint).toBe(firstIdentity.expected);
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
  const remoteAddress = "@acme/sota";
  const identity = {
    v: 1 as const, relay_origin: relayOrigin,
    address: remoteAddress, identity_pub: remote.identity_pub,
  };
  const record = {
    v: 1 as const, relay_origin: relayOrigin,
    address: remoteAddress, key_id: await keyIdFor(remote.encryption_pub),
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
            relay_origin: relayOrigin, from: "@acme/ken", to: remoteAddress,
            key_id: record.key_id, epoch: record.epoch,
          },
        );
        const reply = async (outcome: E2EEOutcomeType) => {
          const issuedAt = Date.now();
          const response: E2EEResponsePayloadType = {
            v: 1, direction: "response", relay_origin: relayOrigin,
            from: remoteAddress, to: "@acme/ken", request_id: request.request_id,
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

function seedConfig(testHome: string, relay: string): Paths {
  const paths = getPaths(testHome, testHome);
  saveConfig(paths, { org: "acme", handle: "ken", token: "tok", relay });
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

  it("requires setup before inspecting another agent", async () => {
    const out = await runCommand(home(), ["inspect", "@acme/ken"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/agentcall setup/);
  });

  it("creates, inventories, and revokes organization invites without reprinting secrets", async () => {
    const id = "d".repeat(64);
    const secret = "i".repeat(43);
    const metadata = {
      id, description: "contractor", created_by: "ken", created_at: 1,
      expires_at: 2_000_000_000_000, used_at: null, used_by: null, revoked_at: null,
      role: "admin" as const,
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
    // #313 flipped `invite list`'s default from JSON to a table, so the
    // machine-readable shape now lives behind --json like every other list
    // verb. The relay request assertions below are unchanged by that.
    const listed = await runCommand(testHome, ["invite", "list", "--json"]);
    const revoked = await runCommand(testHome, ["invite", "revoke", id]);

    expect(created).toMatchObject({ code: 0, stdout: secret });
    expect(created.stderr).toContain(`ID ${id}`);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([metadata]);
    // Compact, like `contacts list --json` and `line list --json`: pretty
    // printing is for reading, and reading is what the table is for now.
    expect(listed.stdout.trim()).not.toContain("\n");
    expect(listed.stdout).not.toContain(secret);
    expect(revoked).toMatchObject({ code: 0, stdout: expect.stringContaining(`Revoked ${id}`) });
    expect(requests).toEqual([
      { url: "/v1/invites", body: JSON.stringify({ description: "contractor", expires_in_days: 30, role: "admin" }) },
      { url: "/v1/invites/list", body: "" },
      { url: `/v1/invites/${id}/revoke`, body: "" },
    ]);
  });

  // #313. The real task at this inventory is "which of these do I revoke?",
  // which the raw JSON dump answered by making the admin read four nullable
  // timestamps off a wall of objects. State is derived here, not stored.
  describe("invite list", () => {
    const ACTIVE = Date.UTC(2033, 4, 18); // far future, so the date renders stably
    const PAST = Date.UTC(2020, 0, 15);
    const invite = (over: Partial<OrgInviteMetadataType> & { id: string }): OrgInviteMetadataType => ({
      description: "", created_by: "ken", created_at: 1, expires_at: ACTIVE,
      used_at: null, used_by: null, revoked_at: null, role: "member", ...over,
    });

    async function list(invites: OrgInviteMetadataType[], args: string[] = []) {
      const relay = await startRelay(() => ({ status: 200, body: { invites } }));
      const testHome = home();
      seedConfig(testHome, relay);
      return await runCommand(testHome, ["invite", "list", ...args]);
    }

    it("renders a row per invite carrying role, description, and expiry", async () => {
      const id = "a".repeat(64);
      const out = await list([invite({ id, description: "contractor", role: "member" })]);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/member/);
      expect(out.stdout).toContain("contractor");
      expect(out.stdout).toContain("2033-05-18");
    });

    // The whole point of showing the ID: `invite revoke` takes the full
    // 64-char value (ORG_INVITE_ID_RE), so a truncated one would force the
    // second lookup this issue exists to remove.
    it("prints the full revoke ID so revoking is a copy, not another command", async () => {
      const id = "b".repeat(64);
      const out = await list([invite({ id })]);
      expect(out.stdout).toContain(id);
    });

    it("derives state from the nullable timestamps rather than printing them", async () => {
      const [a, b, c, d] = ["1", "2", "3", "4"].map((n) => n.repeat(64));
      const out = await list([
        invite({ id: a }),
        invite({ id: b, expires_at: PAST }),
        invite({ id: c, used_at: 5, used_by: "sota" }),
        invite({ id: d, revoked_at: 6 }),
      ]);
      expect(out.stdout).toMatch(/active/);
      expect(out.stdout).toMatch(/expired/);
      expect(out.stdout).toMatch(/used by sota/);
      expect(out.stdout).toMatch(/revoked/);
      // Raw epoch timestamps are what the JSON dump made the admin read.
      expect(out.stdout).not.toContain("used_at");
      expect(out.stdout).not.toContain("revoked_at");
    });

    // Same reasoning as #304's admin call-out: an admin invite can itself
    // issue invites and export the audit log, so "did I issue any admin
    // invites?" must be answerable at a glance.
    it("makes an admin invite stand out from a member invite", async () => {
      const out = await list([
        invite({ id: "c".repeat(64), role: "admin" }),
        invite({ id: "d".repeat(64), role: "member" }),
      ]);
      expect(out.stdout).toMatch(/ADMIN/);
    });

    it("prints a next step rather than an empty array when there are none", async () => {
      const out = await list([]);
      expect(out.code).toBe(0);
      expect(out.stdout).not.toContain("[]");
      expect(out.stdout).toContain("agentcall invite create");
    });

    // A description is caller-supplied free text: MAX_ORG_INVITE_DESCRIPTION
    // bounds its length and nothing bounds its character set
    // (packages/shared/src/invite.ts). The pretty-printed JSON this listing
    // replaced escaped control characters for free; an aligned row does not,
    // so the row an operator most needs to see - an admin grant - is exactly
    // the one an erase sequence can hide.
    it("neutralizes terminal escapes in a caller-supplied description", async () => {
      const out = await list([invite({
        id: "f".repeat(64),
        description: "\u001b[2K\rinnocent",
      })]);
      expect(out.stdout).not.toContain("\u001b");
      expect(out.stdout).not.toContain("\r");
      expect(out.stdout).toContain("innocent");
    });

    it("does not let a description forge an extra row", async () => {
      const out = await list([invite({
        id: "0".repeat(64),
        description: "ok\nactive  ADMIN  2099-01-01  forged",
      })]);
      expect(out.stdout.trim().split("\n")).toHaveLength(1);
      expect(out.stdout).toContain("forged");
    });

    // stringifyTerminalSafeJson, not bare JSON.stringify: JSON escapes C0 but
    // permits C1 and bidi through as literal characters, so `--json` piped to
    // a pager is still a terminal write.
    it("escapes C1 and bidi in --json, which JSON.stringify leaves literal", async () => {
      const out = await list([invite({
        id: "9".repeat(64),
        description: "a\u009b31mb\u202ec",
      })], ["--json"]);
      expect(out.stdout).not.toContain("\u009b");
      expect(out.stdout).not.toContain("\u202e");
      expect(JSON.parse(out.stdout)[0].description).toContain("31m");
    });

    it("still emits the raw array under --json", async () => {
      const rows = [invite({ id: "e".repeat(64) })];
      const out = await list(rows, ["--json"]);
      expect(JSON.parse(out.stdout)).toEqual(rows);
      // Compact like the sibling list verbs, not the old `null, 2`. Asserted
      // as "one line" rather than against JSON.stringify of the fixture: the
      // response is re-serialized through the zod schema on the way back, so
      // key order is the schema's, not this object literal's.
      expect(out.stdout.trim()).not.toContain("\n");
    });
  });

  // #304. On a terminal the admin's next move is "send this to someone", not
  // "read a 43-char base64url string" — but the bare-token stdout is a piping
  // contract (`agentcall invite create > token.txt`), so the human block is
  // gated on isTTY and the test above pins the piped shape.
  describe("invite create on a terminal", () => {
    const id = "d".repeat(64);
    const secret = "i".repeat(43);
    const meta = (role: "admin" | "member") => ({
      id, description: "", created_by: "ken", created_at: 1,
      // Fixed, far-future instant so the rendered calendar date is stable.
      expires_at: Date.UTC(2033, 4, 18), used_at: null, used_by: null, revoked_at: null, role,
    });

    async function createOnTty(role: "admin" | "member") {
      const relay = await startRelay(() => ({ status: 200, body: { invite: secret, metadata: meta(role) } }));
      const testHome = home();
      seedConfig(testHome, relay);
      const previous = process.stdout.isTTY;
      process.stdout.isTTY = true;
      try {
        return await runCommand(testHome, ["invite", "create", "--role", role]);
      } finally {
        process.stdout.isTTY = previous;
      }
    }

    it("prints a paste-ready install block instead of a bare token", async () => {
      const out = await createOnTty("member");
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("npm install -g @benree/agentcall");
      expect(out.stdout).toContain(`agentcall setup --invite ${secret}`);
    });

    it("shows the granted role and a human expiry", async () => {
      const out = await createOnTty("member");
      expect(out.stdout).toMatch(/member/);
      expect(out.stdout).toContain("2033-05-18");
      expect(out.stdout).toMatch(/expires in \d+ days/);
    });

    // The one flag with real consequences had no feedback at all: an admin
    // invite can itself issue invites, revoke invites, and export the org
    // audit log, and its output was shape-identical to a member invite.
    it("calls out an admin invite and what it grants", async () => {
      const out = await createOnTty("admin");
      expect(out.stdout).toMatch(/ADMIN/);
      expect(out.stdout).toMatch(/audit log/i);
    });

    it("says nothing about admin powers for a member invite", async () => {
      const out = await createOnTty("member");
      expect(out.stdout).not.toMatch(/audit log/i);
    });

    // The ID is sha256(token), so the holder can already compute it — keeping
    // it visible costs nothing and saves a second `invite list` call when an
    // admin needs to cancel one they mis-sent.
    it("keeps the revoke ID in reach", async () => {
      const out = await createOnTty("member");
      expect(out.stdout).toContain(id);
      expect(out.stdout).toMatch(/revoke/i);
    });
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

  it("exposes policy assertion failures through agentcall lint", async () => {
    const testHome = home();
    const paths = getPaths(testHome, testHome);
    saveConfig(paths, { org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude" });
    mkdirSync(join(testHome, ".agentcall"), { recursive: true });
    writeFileSync(paths.policyFile, JSON.stringify({
      tests: [{ caller: "mia", expect_access: "blocked" }],
    }));

    const out = await runCommand(testHome, ["lint"]);

    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/assertion 1.*expected blocked.*got allowed/i);
  });

  it("renders the effective policy as a per-caller access report", async () => {
    const testHome = home();
    const paths = getPaths(testHome, testHome);
    saveConfig(paths, {
      org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude",
    });
    mkdirSync(join(paths.tasksDir, "deploy"), { recursive: true });
    writeFileSync(join(paths.tasksDir, "deploy", "SKILL.md"), [
      "---",
      "name: Deploy production",
      "description: Build and deploy the service.",
      "---",
      "Deploy carefully.",
    ].join("\n"));
    writeFileSync(paths.policyFile, JSON.stringify({
      default_access: "allowed", callers: {
        alice: { access: "allowed" },
        "blocked-bot": { access: "blocked" },
      },
    }));

    const out = await runCommand(testHome, ["policy"]);

    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("Effective access policy");
    expect(out.stdout).toMatch(new RegExp(`Tasks — every caller who is not blocked[\\s\\S]*ask — Ask a question[\\s\\S]*Working directory: ${paths.shareDir}`));
    expect(out.stdout).toMatch(/deploy — Deploy production[\s\S]*inspect files — answers are read-only/);
    // The exec warning is gone with the capability that caused it (#372).
    expect(out.stdout).not.toContain("WARNING: exec");
    expect(out.stdout).toMatch(/Named caller rule: alice \(overrides the base rule\)[\s\S]*ANSWERED — calls from this audience are admitted/);
    expect(out.stdout).toMatch(/Named caller rule: blocked-bot \(overrides the base rule\)[\s\S]*BLOCKED — no call is answered at all/);
  });

  it("rejects a CLI policy edit that would break an assertion and preserves the file", async () => {
    const testHome = home();
    const paths = getPaths(testHome, testHome);
    saveConfig(paths, { org: "acme", handle: "ken", token: "tok", relay: "https://relay.test", agent_kind: "claude" });
    mkdirSync(join(testHome, ".agentcall"), { recursive: true });
    const original = {
      tests: [{ caller: "mia", expect_access: "allowed" }],
    };
    writeFileSync(paths.policyFile, JSON.stringify(original));

    // The edit is legal on its own — lowering the default — but it drops mia
    // below what an assertion pins, so it must be refused and the last
    // known-good file left exactly as it was.
    const out = await runCommand(testHome, ["access", "--default", "blocked"]);

    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/assertion 1.*expected allowed.*got blocked/i);
    expect(JSON.parse(readFileSync(paths.policyFile, "utf8"))).toEqual(original);
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
    // The store keys by task now, so there may be several open conversations
    // and "that conversation is on X, not Y" can no longer name them. Listing
    // the open tasks keeps the information the old message carried.
    expect(out.stderr).toMatch(/No open conversation with local-sota on task "other-task"/);
    expect(out.stderr).toMatch(/Open: resolved-task/);
    expect(callRelay.connections()).toBe(0);
  });

  it("keeps one conversation per task and refuses to guess between them", async () => {
    const callRelay = await startCallRelay(() => {});
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    const paths = seedConfig(testHome, callRelay.relay);
    rememberOutbound(paths, {
      relay: callRelay.relay, from: "ken", to: "sota", task: "review",
      context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA", at: 1,
    });
    rememberOutbound(paths, {
      relay: callRelay.relay, from: "ken", to: "sota", task: "triage",
      context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2,
    });

    // Keyed on the callee alone, the second call silently discarded the first.
    expect(loadOutbound(paths)).toHaveLength(2);

    const out = await runCommand(testHome, ["call", "local-sota", "follow up", "--continue"]);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/Several open conversations/i);
    expect(out.stderr).toContain("review");
    expect(out.stderr).toContain("triage");
    expect(callRelay.connections()).toBe(0);
  });

  it("resumes the conversation --task names when several are open", async () => {
    const frames: Record<string, unknown>[] = [];
    const callRelay = await startCallRelay(async (frame, reply) => {
      frames.push(frame);
      await reply({ kind: "reply", text: "ok", task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB" });
    });
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    const paths = seedConfig(testHome, callRelay.relay);
    rememberOutbound(paths, {
      relay: callRelay.relay, from: "ken", to: "sota", task: "review",
      context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA", at: 1,
    });
    rememberOutbound(paths, {
      relay: callRelay.relay, from: "ken", to: "sota", task: "triage",
      context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2,
    });

    const out = await runCommand(testHome, ["call", "local-sota", "follow up", "--continue", "--task", "triage"]);

    expect(out.code).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB" });
    // The other conversation is untouched, not replaced by this turn.
    expect(loadOutbound(paths).map((e) => e.task).sort()).toEqual(["review", "triage"]);
  });

  // The callee ends a conversation on its own schedule -- the turn cap, the
  // TTL, or a session its agent CLI has dropped -- and says so only ever as
  // context_unknown. rememberOutbound runs on the success path alone, so
  // without forgetOutbound the caller's half outlived the callee's binding and
  // every later --continue re-sent the same dead context id, failing
  // identically forever.
  it("clears the stored conversation when the callee reports context_unknown", async () => {
    const callRelay = await startCallRelay(async (_frame, reply) => {
      await reply({ kind: "failure", code: "context_unknown" });
    });
    routing.host = new URL(callRelay.relay).host;
    const testHome = home();
    const paths = seedConfig(testHome, callRelay.relay);
    rememberOutbound(paths, {
      relay: callRelay.relay, from: "ken", to: "sota", task: "resolved-task",
      context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA", at: 1,
    });

    const out = await runCommand(testHome, ["call", "local-sota", "follow up", "--continue"]);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/has ended/i);
    expect(out.stderr).toMatch(/without --continue/);
    expect(loadOutbound(paths)).toEqual([]);

    // And the follow-up after that is the "start one" message rather than the
    // same failure against an id the callee has already forgotten.
    const again = await runCommand(testHome, ["call", "local-sota", "again", "--continue"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/No open conversation/);
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

    const out = await runCommand(testHome, ["inspect", "local-sota"]);

    expect(out.code).toBe(1); // card is available, but the fixture intentionally has no identity keys
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
