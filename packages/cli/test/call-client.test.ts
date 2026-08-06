import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORRELATION_ID_RE, HPKE_SUITE, MAX_E2EE_WIRE_BYTES, RELAY_CALL_TIMEOUT_MS,
  keyIdFor, requestTranscript, transcriptHash,
  type E2EEOutcomeType, type E2EEResponsePayloadType, type EncryptionKeyRecordType,
} from "@benree/agentcall-shared";
import { callAgent, callStatusMessage, CallError, type CallOpts } from "../src/call-client.js";
import { ApiError } from "../src/api.js";
import { openE2EERequest, sealE2EEResponse } from "../src/e2ee.js";
import { generateIdentityKeys, type StoredKeys } from "../src/keys.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";

let httpServer: Server | undefined;
const roots: string[] = [];
afterEach(() => new Promise<void>((resolve) => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  const server = httpServer;
  httpServer = undefined;
  if (!server) return resolve();
  server.close(() => resolve());
}));

type Script = (ws: import("ws").WebSocket, req: import("node:http").IncomingMessage) => void;

function fakeRelay(script: Script): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_q, s) => { s.writeHead(404); s.end(); });
    httpServer = server;
    const wss = new WebSocketServer({ server, path: "/v1/ws" });
    wss.on("connection", script);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function rejectingRelay(status: number): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer();
    httpServer = server;
    server.on("upgrade", (_request, socket) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function malformedKeyRelay(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
    });
    httpServer = server;
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function identity(name: string): Promise<{ keys: StoredKeys; paths: ReturnType<typeof getLinePaths> }> {
  const root = mkdtempSync(join(tmpdir(), `agentcall-call-client-${name}-`));
  roots.push(root);
  const paths = getLinePaths(getMachinePaths(root, root), name);
  return { keys: await generateIdentityKeys(paths), paths };
}

async function encryptionRecord(address: string, keys: StoredKeys): Promise<EncryptionKeyRecordType> {
  return {
    v: 1, relay_origin: "relay.test",
    address, key_id: await keyIdFor(keys.encryption_pub), suite: HPKE_SUITE,
    pub: keys.encryption_pub, epoch: keys.epoch, not_before: 1, not_after: Date.now() + 1_000_000,
    prev: null,
  };
}

async function fixture(relay: string, overrides: Partial<CallOpts> = {}) {
  const sender = await identity("sender");
  const recipient = await identity("recipient");
  const origin = new URL(relay).hostname;
  const from = overrides.from ?? "me";
  const to = overrides.to ?? "ken";
  const fromAddress = `@acme/${from}`;
  const toAddress = `@acme/${to}`;
  const recipientRecord = await encryptionRecord(toAddress, recipient.keys);
  const opts: CallOpts = {
    relay, org: "acme", from, token: "tok", to, message: "hi", paths: sender.paths,
    ...overrides,
    keyDeps: {
      fetchKeys: async () => ({
        identity: {
          v: 1, relay_origin: origin,
          address: toAddress, identity_pub: recipient.keys.identity_pub,
        },
        encryption: { record: recipientRecord, signature: "unused" },
      }),
      verifyAndPinPeer: async () => ({
        relay_origin: origin,
        address: toAddress, identity_pub: recipient.keys.identity_pub,
        fingerprint: `SHA256:${"a".repeat(32)}`, first_seen_at: 1,
        highest_encryption_epoch: recipient.keys.epoch, call_count: 1,
      }),
      loadKeys: () => sender.keys,
    },
  };

  const outcomeFrame = async (outer: any, outcome: E2EEOutcomeType) => {
    const request = await openE2EERequest(
      outer.envelope, recipient.keys.encryption_pkcs8, sender.keys.identity_pub,
      {
        relay_origin: origin, from: fromAddress, to: toAddress,
        key_id: recipientRecord.key_id, epoch: recipient.keys.epoch,
      },
    );
    const issuedAt = Date.now();
    const payload: E2EEResponsePayloadType = {
      v: 1, direction: "response", relay_origin: origin, from: toAddress, to: fromAddress,
      request_id: request.request_id,
      sender_identity_key_id: await keyIdFor(recipient.keys.identity_pub),
      recipient_encryption_key_id: await keyIdFor(sender.keys.encryption_pub),
      recipient_epoch: sender.keys.epoch, issued_at: issuedAt,
      expires_at: Math.min(request.expires_at, issuedAt + RELAY_CALL_TIMEOUT_MS),
      request_transcript_hash: await transcriptHash(requestTranscript(request)), outcome,
    };
    const envelope = await sealE2EEResponse(payload, recipient.keys, {
      pub: sender.keys.encryption_pub,
      key_id: payload.recipient_encryption_key_id,
      epoch: sender.keys.epoch,
    });
    return { type: "call_outcome", call_id: "c1", terminal: outcome.kind === "reply" ? "completed" : "failed", envelope };
  };
  return { opts, outcomeFrame };
}

describe("callAgent", () => {
  it("gives each relay status a distinct progress message", () => {
    expect(callStatusMessage("ringing")).toBe("ringing...");
    expect(callStatusMessage("answered")).toBe("answered...");
    expect(callStatusMessage("working")).toBe("agent working...");
  });

  it("sends no plaintext content and decrypts an authenticated reply", async () => {
    let fx!: Awaited<ReturnType<typeof fixture>>;
    const states: string[] = [];
    const privateMessage = "request-content-must-not-appear-on-wire";
    const privateReply = "response-content-must-not-appear-on-wire";
    const relay = await fakeRelay((ws, req) => {
      expect(req.headers.authorization).toBe("Bearer tok");
      expect(req.headers["sec-websocket-extensions"]).toBeUndefined();
      ws.on("message", async (raw) => {
        if (String(raw) === "ping") return;
        const wire = String(raw);
        expect(wire).not.toContain(privateMessage);
        const frame = JSON.parse(wire);
        expect(frame).toMatchObject({ type: "call_request" });
        expect(frame).not.toHaveProperty("message");
        expect(frame.correlation_id).toMatch(CORRELATION_ID_RE);
        for (const state of ["ringing", "answered", "working"]) {
          ws.send(JSON.stringify({ type: "call_status", state, call_id: "c1", correlation_id: frame.correlation_id }));
        }
        const outcome = await fx.outcomeFrame(frame, {
          kind: "reply", text: privateReply, context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA",
        });
        expect(JSON.stringify(outcome)).not.toContain(privateReply);
        ws.send(JSON.stringify(outcome));
      });
    });
    fx = await fixture(relay, { message: privateMessage, onStatus: (state) => states.push(state) });
    const reply = await callAgent(fx.opts);
    expect(reply).toMatchObject({ text: privateReply, context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA" });
    expect(states).toEqual(["ringing", "answered", "working"]);
  });

  it("carries task and trace context only in their intended visibility zones", async () => {
    const correlationId = "a".repeat(32);
    const traceparent = `00-${correlationId}-${"b".repeat(16)}-01`;
    let fx!: Awaited<ReturnType<typeof fixture>>;
    let captured: any;
    const relay = await fakeRelay((ws) => ws.on("message", async (raw) => {
      if (String(raw) === "ping") return;
      captured = JSON.parse(String(raw));
      expect(JSON.stringify(captured)).not.toContain("schedule-meeting");
      ws.send(JSON.stringify(await fx.outcomeFrame(captured, {
        kind: "reply", text: "ok", task: "schedule-meeting",
      })));
    }));
    fx = await fixture(relay, { correlationId, traceparent, task: "schedule-meeting" });
    const reply = await callAgent(fx.opts);
    expect(captured).toMatchObject({ correlation_id: correlationId, traceparent });
    expect(reply.task).toBe("schedule-meeting");
  });

  it("labels relay errors as unauthenticated operational claims", async () => {
    const relay = await fakeRelay((ws) => ws.on("message", () => ws.send(JSON.stringify({
      type: "call_error", origin: "relay", code: "offline",
    }))));
    const fx = await fixture(relay);
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "offline", origin: "relay", message: expect.stringMatching(/Unauthenticated relay status/),
    });
  });

  it("labels preflight key API failures as unauthenticated relay claims", async () => {
    const fx = await fixture("https://relay.example");
    fx.opts.keyDeps!.fetchKeys = async () => {
      throw new ApiError("The relay returned a malformed key record.", "invalid");
    };
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "protocol_error",
      origin: "relay",
      message: expect.stringMatching(/^Unauthenticated relay status:/),
    });
  });

  it("keeps preflight reachability failures in the transport trust domain", async () => {
    const fx = await fixture("https://relay.example");
    fx.opts.keyDeps!.fetchKeys = async () => {
      throw new ApiError("Cannot reach relay: TLS handshake failed.", "network");
    };
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "connection_failed",
      origin: "transport",
      message: expect.stringMatching(/^Connection failed:/),
    });
  });

  it("keeps local destination validation out of the relay trust domain", async () => {
    const fx = await fixture("https://relay.example");
    fx.opts.to = "INVALID";
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "protocol_error",
      origin: "transport",
      message: expect.stringMatching(/^Invalid call target:/),
    });
  });

  it("labels malformed JSON from a real key response as an unauthenticated relay claim", async () => {
    const relay = await malformedKeyRelay();
    const fx = await fixture(relay);
    delete fx.opts.keyDeps!.fetchKeys;
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "protocol_error",
      origin: "relay",
      message: expect.stringMatching(/^Unauthenticated relay status:/),
    });
  });

  it("labels HTTP upgrade rejection as an unauthenticated relay claim", async () => {
    const relay = await rejectingRelay(401);
    const fx = await fixture(relay);
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "unauthorized",
      origin: "relay",
      message: expect.stringMatching(/^Unauthenticated relay status:/),
    });
  });

  it("labels decrypted failures as authenticated peer outcomes and sanitizes detail", async () => {
    let fx!: Awaited<ReturnType<typeof fixture>>;
    const relay = await fakeRelay((ws) => ws.on("message", async (raw) => {
      if (String(raw) === "ping") return;
      ws.send(JSON.stringify(await fx.outcomeFrame(JSON.parse(String(raw)), {
        kind: "failure", code: "task_unknown",
        detail: "\u001b[2Jchoose another", offered: ["ask", "owner-introduction"],
      })));
    }));
    fx = await fixture(relay, { task: "deploy" });
    const error = await callAgent(fx.opts).then(() => null, (caught) => caught as CallError);
    expect(error).toMatchObject({ code: "task_unknown", origin: "peer", offered: ["ask", "owner-introduction"] });
    expect(error?.message).toContain("Authenticated peer response");
    expect(error?.message).not.toContain("\u001b");
  });

  it("rejects tampered encrypted outcomes as untrusted wire failures", async () => {
    let fx!: Awaited<ReturnType<typeof fixture>>;
    const relay = await fakeRelay((ws) => ws.on("message", async (raw) => {
      if (String(raw) === "ping") return;
      const outcome = await fx.outcomeFrame(JSON.parse(String(raw)), { kind: "reply", text: "ok" });
      outcome.envelope.ct = `${outcome.envelope.ct[0] === "A" ? "B" : "A"}${outcome.envelope.ct.slice(1)}`;
      ws.send(JSON.stringify(outcome));
    }));
    fx = await fixture(relay);
    await expect(callAgent(fx.opts)).rejects.toMatchObject({ code: "protocol_error", origin: "transport" });
  });

  it("rejects a relay-visible terminal state that contradicts the authenticated outcome", async () => {
    let fx!: Awaited<ReturnType<typeof fixture>>;
    const relay = await fakeRelay((ws) => ws.on("message", async (raw) => {
      if (String(raw) === "ping") return;
      const outcome = await fx.outcomeFrame(JSON.parse(String(raw)), { kind: "reply", text: "ok" });
      outcome.terminal = "failed";
      ws.send(JSON.stringify(outcome));
    }));
    fx = await fixture(relay);
    await expect(callAgent(fx.opts)).rejects.toMatchObject({ code: "protocol_error", origin: "transport" });
  });

  it("rejects when the socket closes before an outcome", async () => {
    const relay = await fakeRelay((ws) => { ws.on("message", () => ws.close(1011)); });
    const fx = await fixture(relay);
    await expect(callAgent(fx.opts)).rejects.toBeInstanceOf(CallError);
  });

  it("rejects an oversized relay frame at the WebSocket boundary", async () => {
    const relay = await fakeRelay((ws) => ws.on("message", () => {
      ws.send(Buffer.alloc(MAX_E2EE_WIRE_BYTES + 1));
    }));
    const fx = await fixture(relay, { timeoutMs: 2_000 });
    await expect(callAgent(fx.opts)).rejects.toMatchObject({
      code: "connection_failed", origin: "transport",
    });
  });

  it("times out client-side", async () => {
    const relay = await fakeRelay(() => { /* say nothing */ });
    const fx = await fixture(relay, { timeoutMs: 200 });
    await expect(callAgent(fx.opts)).rejects.toMatchObject({ code: "timeout" });
  });

  it("sends keepalive pings and ignores pong replies", async () => {
    let fx!: Awaited<ReturnType<typeof fixture>>;
    const pings: string[] = [];
    const relay = await fakeRelay((ws) => ws.on("message", async (raw) => {
      const value = String(raw);
      if (value === "ping") { pings.push(value); return; }
      ws.send("pong");
      setTimeout(async () => ws.send(JSON.stringify(
        await fx.outcomeFrame(JSON.parse(value), { kind: "reply", text: "yo" }),
      )), 60);
    }));
    fx = await fixture(relay, { pingIntervalMs: 20 });
    expect((await callAgent(fx.opts)).text).toBe("yo");
    expect(pings.length).toBeGreaterThan(0);
  });
});
