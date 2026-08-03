import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHandle, getStatus, fetchCard, pushCard, rotateToken, createInvite, listInvites, revokeInvite,
  createRoster, joinRoster, fetchAuditExportPage,
  fetchRosterBundle, issueRosterJoinKey, listRosterJoinKeys, revokeRosterJoinKey } from "../src/api.js";
import {
  generateIdentityKeys, loadKeys, loadPendingEncryptionPublication, rotateEncryptionKey,
  type StoredKeys,
} from "../src/keys.js";
import { fetchKeys, publishEncryptionKey, publishIdentityKey } from "../src/api.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HPKE_SUITE, encryptionKeyTranscript, fromBase64Url, identityTranscript,
  importIdentityPublicKey, keyIdFor, signTranscript, verifyTranscript,
  type EncryptionKeyRecordType, type IdentityRecordType,
} from "@benree/agentcall-shared";

const JOIN_KEY = `agjk_${"a".repeat(12)}_${"s".repeat(32)}`;

let server: Server;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
});

// Accepts connections but never responds — simulates a black-holed relay.
function serveNever(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(() => {
      /* hold the request open forever */
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function serve(status: number, body: unknown): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function serveCapturing(status: number, body: unknown, captured: unknown[]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        captured.push(JSON.parse(raw));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe("api client", () => {
  it("registers", async () => {
    const relay = await serve(200, { org: "acme", token: "tok", address: "ken@acme.agentcall.benree.tech" });
    expect(await registerHandle(relay, "valid-invite", "ken", "claude")).toEqual({ org: "acme", token: "tok", address: "ken@acme.agentcall.benree.tech" });
  });
  it("rejects a malformed handle locally, without hitting the relay", async () => {
    // Point at a port nothing is listening on: if validation didn't run
    // before fetch, this would reject with code "network" instead.
    await expect(registerHandle("http://127.0.0.1:1", "valid-invite", "Not Valid!", "claude"))
      .rejects.toMatchObject({ code: "invalid" });
  });
  it("maps 409 to handle_taken", async () => {
    const relay = await serve(409, { error: "handle taken" });
    await expect(registerHandle(relay, "valid-invite", "ken", "claude")).rejects.toMatchObject({ code: "handle_taken" });
  });
  it("maps a temporarily unavailable registration service to a retryable network error", async () => {
    const relay = await serve(503, { error: "registration temporarily unavailable" });
    await expect(registerHandle(relay, "valid-invite", "ken", "claude")).rejects.toMatchObject({
      code: "network",
      message: expect.stringMatching(/temporarily unavailable.*try again/i),
    });
  });
  it("maps an invalid, expired, or consumed invite to invite_invalid", async () => {
    const relay = await serve(404, { error: "invalid invite" });
    await expect(registerHandle(relay, "invalid-invite", "ken", "claude"))
      .rejects.toMatchObject({ code: "invite_invalid", message: expect.stringMatching(/expired|already used/) });
  });
  it("register times out with a clear error when the relay never responds", async () => {
    const relay = await serveNever();
    await expect(registerHandle(relay, "valid-invite", "ken", "claude", { timeoutMs: 100 })).rejects.toMatchObject({
      code: "network",
      message: expect.stringMatching(/did not respond/),
    });
  });
  it("status times out with a clear error when the relay never responds", async () => {
    const relay = await serveNever();
    await expect(getStatus(relay, "ken", { org: "acme", handle: "me", token: "tok" }, { timeoutMs: 100 })).rejects.toMatchObject({
      code: "network",
      message: expect.stringMatching(/did not respond/),
    });
  });
  it("gets status and maps a non-enumerating 404 without claiming the target is unknown", async () => {
    const relay = await serve(200, { online: true });
    expect(await getStatus(relay, "ken", { org: "acme", handle: "me", token: "tok" })).toEqual({ online: true });
    const relay2 = await serve(404, { error: "unknown handle" });
    await expect(getStatus(relay2, "ghost", { org: "acme", handle: "me", token: "tok" })).rejects.toMatchObject({
      code: "status_unavailable",
      message: expect.stringMatching(/does not exist or does not share a roster/i),
    });
  });
  // The relay stopped serving presence anonymously (it was an enumeration and
  // "is this person at their desk" oracle), so every status check must carry
  // the caller's own credentials.
  it("sends caller credentials on a status check", async () => {
    let headers: IncomingMessage["headers"] | undefined;
    const relay = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        headers = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ online: true }));
      });
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    await getStatus(relay, "ken", { org: "acme", handle: "me", token: "tok" });
    expect(headers?.authorization).toBe("Bearer tok");
    expect(headers?.["x-agentcall-handle"]).toBe("me");
  });

  it("maps a rejected status check to a re-run-setup message", async () => {
    const relay = await serve(401, { error: "unauthorized" });
    await expect(getStatus(relay, "ken", { org: "acme", handle: "me", token: "bad" })).rejects.toMatchObject({
      message: expect.stringMatching(/agentcall setup/),
    });
  });

  it("maps a throttled status check to its own message rather than a generic failure", async () => {
    const relay = await serve(429, { error: "rate limited" });
    await expect(getStatus(relay, "ken", { org: "acme", handle: "me", token: "tok" })).rejects.toMatchObject({
      message: expect.stringMatching(/too many/i),
    });
  });

  it("rotates a token, sending the current credentials", async () => {
    let headers: IncomingMessage["headers"] | undefined;
    let method: string | undefined;
    const relay = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        headers = req.headers;
        method = req.method;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "fresh-token" }));
      });
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    expect(await rotateToken(relay, { org: "acme", handle: "me", token: "old" })).toEqual({ token: "fresh-token" });
    expect(method).toBe("POST");
    expect(headers?.authorization).toBe("Bearer old");
    expect(headers?.["x-agentcall-handle"]).toBe("me");
  });

  it("maps a rejected rotation to a re-run-setup message", async () => {
    const relay = await serve(401, { error: "unauthorized" });
    await expect(rotateToken(relay, { org: "acme", handle: "me", token: "bad" })).rejects.toMatchObject({
      message: expect.stringMatching(/agentcall setup/),
    });
  });

  it("maps a throttled rotation to its own message", async () => {
    const relay = await serve(429, { error: "rate limited" });
    await expect(rotateToken(relay, { org: "acme", handle: "me", token: "tok" })).rejects.toMatchObject({
      message: expect.stringMatching(/too many/i),
    });
  });

  it("registers caller-only: omits agent_kind from the request body entirely", async () => {
    const captured: unknown[] = [];
    const relay = await serveCapturing(200, { org: "acme", token: "tok", address: "solo@acme.agentcall.benree.tech" }, captured);
    expect(await registerHandle(relay, "valid-invite", "solo")).toEqual({ org: "acme", token: "tok", address: "solo@acme.agentcall.benree.tech" });
    expect(captured).toEqual([{ invite: "valid-invite", handle: "solo" }]);
  });
  it("creates an invite with tenant credentials", async () => {
    let seen: { path?: string; headers?: IncomingMessage["headers"]; body?: string } = {};
    const metadata = {
      id: "a".repeat(64), description: "vendor", created_by: "ken", created_at: 1,
      expires_at: 2, used_at: null, used_by: null, revoked_at: null,
    };
    const relay = await startServer((req, res, body) => {
        seen = { path: req.url, headers: req.headers, body };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ invite: "i".repeat(43), metadata }));
    });
    expect((await createInvite(
      relay, { org: "acme", handle: "ken", token: "tok" },
      { description: "vendor", expires_in_days: 30 },
    )).invite).toHaveLength(43);
    expect(seen.path).toBe("/v1/invites");
    expect(seen.headers?.authorization).toBe("Bearer tok");
    expect(seen.headers?.["x-agentcall-org"]).toBe("acme");
    expect(JSON.parse(seen.body ?? "")).toEqual({ description: "vendor", expires_in_days: 30 });
  });

  it("lists and revokes invites by public ID", async () => {
    const metadata = {
      id: "b".repeat(64), description: "", created_by: "ken", created_at: 1,
      expires_at: 2, used_at: null, used_by: null, revoked_at: null,
    };
    let requests: string[] = [];
    const relay = await startServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.endsWith("/list")
        ? { invites: [metadata] }
        : { id: metadata.id, revoked_at: 3 }));
    });
    const auth = { org: "acme", handle: "ken", token: "tok" };
    expect(await listInvites(relay, auth)).toEqual([metadata]);
    expect(await revokeInvite(relay, auth, metadata.id)).toEqual({ id: metadata.id, revoked_at: 3 });
    expect(requests).toEqual(["/v1/invites/list", `/v1/invites/${metadata.id}/revoke`]);
  });

  it("fetches a filtered audit export page with tenant credentials", async () => {
    let seen = "";
    const page = {
      events: [{
        ledger: "org", id: 1, event: "org.invite.issue", action_type: "C",
        roster_id: null, actor: "ken", actor_type: "handle", target_type: "invite",
        target_id: "abc", target_role: "member", actor_ip: null, actor_country: null, description: "issued", at: 100,
      }],
      checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 0, roster_event_count: 0 },
      next_page_token: "next",
      completion_receipt: null,
      acknowledged_checkpoint: null,
    };
    const relay = await startServer((req, res) => {
      seen = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page));
    });
    expect(await fetchAuditExportPage(
      relay, { org: "acme", handle: "ken", token: "tok" },
      {
        after: 10, before: 200, actor: "ken", event: "org.invite.issue",
        actor_ip: "203.0.113.10", page_size: 50, page_token: "cursor",
      },
    )).toEqual(page);
    expect(seen).toBe(
      "/v1/audit/events?after=10&before=200&actor=ken&event=org.invite.issue&actor_ip=203.0.113.10&page_size=50&page_token=cursor",
    );
  });

  it.each([
    [401, "credentials were rejected"],
    [403, "not an organization administrator"],
    [400, "cursor, filter, or time range is invalid"],
    [409, "snapshot changed during export"],
    [429, "Too many audit export requests"],
    [503, "Audit export failed (503)"],
  ])("maps audit export status %i to actionable CLI guidance", async (status, message) => {
    const relay = await serve(status, { error: "test" });
    await expect(fetchAuditExportPage(
      relay, { org: "acme", handle: "ken", token: "tok" },
    )).rejects.toThrow(message);
  });

  it("retries a bounded audit rate limit using Retry-After", async () => {
    let calls = 0;
    const page = {
      events: [],
      checkpoint: { org_event_id: 0, org_event_count: 0, roster_event_id: 0, roster_event_count: 0 },
      next_page_token: "",
      completion_receipt: "receipt",
      acknowledged_checkpoint: null,
    };
    const relay = await startServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page));
    });
    const sleeps: number[] = [];
    expect(await fetchAuditExportPage(
      relay, { org: "acme", handle: "ken", token: "tok" }, {},
      { retryRateLimit: true, sleep: async (ms) => { sleeps.push(ms); } },
    )).toEqual(page);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([0]);
  });
});

// Spins up a local server whose handler gets the collected request body
// alongside req/res, so tests can assert on method/url/headers/body without
// each handler re-implementing body collection.
function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe("pushCard / fetchCard", () => {
  it("PUTs the upload with bearer auth and succeeds on 200", async () => {
    let seen: { method?: string; url?: string; auth?: string; body?: string } = {};
    const relay = await startServer((req, res, body) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization as string, body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await pushCard(relay, { org: "acme", handle: "ken", token: "tok" }, {
      description: "", agent_kind: "claude",
      tasks: [{ id: "ask", name: "Ask", description: "d", examples: [], keywords: [] }],
      default_offer: ["ask"], grants: {}, group_grants: {}, blocked: [],
    });
    expect(seen.method).toBe("PUT");
    expect(seen.url).toBe("/v1/card");
    expect(seen.auth).toBe("Bearer tok");
    expect(JSON.parse(seen.body!)).toMatchObject({ default_offer: ["ask"] });
  });

  it("fetchCard parses and returns the card; 404 -> ApiError unknown_handle", async () => {
    const card = {
      handle: "ken", description: "", agent_kind: "claude",
      tasks: [{ id: "ask", name: "Ask", description: "d", examples: [], keywords: [] }], updated_at: 1,
    };
    const relay = await startServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer tok");
      expect(req.headers["x-agentcall-org"]).toBe("acme");
      expect(req.headers["x-agentcall-handle"]).toBe("viewer");
      if (req.url === "/v1/card/ken") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(card));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no card" }));
      }
    });
    const auth = { org: "acme", handle: "viewer", token: "tok" };
    expect(await fetchCard(relay, "ken", auth)).toMatchObject({ handle: "ken" });
    await expect(fetchCard(relay, "ghost", auth)).rejects.toMatchObject({ code: "unknown_handle" });
  });

  it("maps rejected card credentials to the setup recovery message", async () => {
    const relay = await serve(401, { error: "unauthorized" });
    await expect(fetchCard(relay, "ken", { org: "acme", handle: "viewer", token: "bad" }))
      .rejects.toMatchObject({ message: expect.stringMatching(/agentcall setup/) });
  });
});

describe("roster api", () => {
  it("creates a roster and returns the initial key once", async () => {
    const relay = await serve(200, { roster_id: "a".repeat(22), join_key: JOIN_KEY, admin_secret: "admin-value-long" });
    const r = await createRoster(relay, { org: "acme", handle: "ken", token: "t" });
    expect(r).toEqual({ roster_id: "a".repeat(22), join_key: JOIN_KEY, admin_secret: "admin-value-long" });
  });

  // The relay deliberately returns byte-identical 404s for "no such roster"
  // and "wrong secret", so the client message must not distinguish them
  // either — otherwise a garbage-secret probe would make roster ids
  // enumerable, defeating the relay-side protection.
  it("maps a 404 join to a message that does not distinguish the two causes", async () => {
    const relay = await serve(404, { error: "not found" });
    await expect(joinRoster(relay, { org: "acme", handle: "ken", token: "t" }, "a".repeat(22), "wrong"))
      .rejects.toThrow(/no such roster, or the join key is invalid/i);
  });

  it("maps a 409 join to a roster-full message", async () => {
    const relay = await serve(409, { error: "roster full" });
    await expect(joinRoster(relay, { org: "acme", handle: "ken", token: "t" }, "a".repeat(22), "s"))
      .rejects.toThrow(/full/i);
  });

  it("parses issue, list, and targeted revoke responses", async () => {
    const metadata = {
      prefix: "a".repeat(12), description: "contractor", created_by: "ken", created_at: 1, expires_at: 2,
      reusable: false, used: false, revoked_at: null,
    };
    let response: unknown = { join_key: JOIN_KEY, key: metadata };
    const relay = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    const auth = { org: "acme", handle: "ken", token: "t" };
    expect(await issueRosterJoinKey(relay, auth, "a".repeat(22), "admin")).toEqual({ join_key: JOIN_KEY, key: metadata });
    response = { keys: [metadata] };
    expect(await listRosterJoinKeys(relay, auth, "a".repeat(22), "admin")).toEqual([metadata]);
    response = { prefix: "a".repeat(12), revoked_at: 3, evicted: 1 };
    expect(await revokeRosterJoinKey(relay, auth, "a".repeat(22), "a".repeat(12), "admin", true))
      .toEqual({ prefix: "a".repeat(12), revoked_at: 3, evicted: 1 });
  });

  it("returns the parsed bundle and its ETag", async () => {
    const relay = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", ETag: '"etag-1"' });
      res.end(JSON.stringify({ roster_id: "a".repeat(22), entries: [], skipped: 0 }));
    });
    const out = await fetchRosterBundle(relay, { org: "acme", handle: "ken", token: "t" }, "a".repeat(22));
    expect(out).not.toBe("not-modified");
    expect((out as { etag?: string }).etag).toBe('"etag-1"');
  });

  // Must not attempt to parse a 304's (empty) body as a bundle: the caller
  // is expected to keep serving its cached entries in that case.
  it("reports not-modified on a 304 instead of parsing an empty body", async () => {
    const relay = await startServer((_req, res) => {
      res.writeHead(304);
      res.end();
    });
    const out = await fetchRosterBundle(relay, { org: "acme", handle: "ken", token: "t" }, "a".repeat(22), '"etag-1"');
    expect(out).toBe("not-modified");
  });
});

// Test-only re-derivation of the private-key import api.ts keeps unexported:
// building a genuinely valid, schema-passing fixture requires signing with the
// same identity key the relay would verify against, not a hand-typed signature.
async function importIdentityPrivateKeyForTest(pkcs8B64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", fromBase64Url(pkcs8B64url) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

async function previousTranscriptHash(record: EncryptionKeyRecordType): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", encryptionKeyTranscript(record) as BufferSource,
  );
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function buildValidKeysResponse(
  keys: StoredKeys, address: string,
): Promise<{ identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } }> {
  const identity: IdentityRecordType = { v: 1, address, identity_pub: keys.identity_pub };
  const now = 1_754_000_000_000;
  const record: EncryptionKeyRecordType = {
    v: 1,
    address,
    key_id: await keyIdFor(keys.encryption_pub),
    suite: HPKE_SUITE,
    pub: keys.encryption_pub,
    epoch: keys.epoch,
    not_before: now,
    not_after: now + 1_000_000,
    prev: null,
  };
  const signature = await signTranscript(
    await importIdentityPrivateKeyForTest(keys.identity_pkcs8),
    encryptionKeyTranscript(record),
  );
  return { identity, encryption: { record, signature } };
}

// The identity key is line-scoped, so every case here works through a line.
function linePaths(root: string) { return getLinePaths(getMachinePaths(root, root), "claude"); }

describe("key publication", () => {
  const auth = { org: "acme", handle: "ken", token: "t0ken" };

  it("PUTs an identity record whose address carries the relay host", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      let seen: { url: string; body: string } | undefined;
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        seen = { url, body: String(init.body) };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await publishIdentityKey("https://relay.test", auth, keys, "relay.test");

      expect(seen?.url).toBe("https://relay.test/v1/keys/identity");
      const body = JSON.parse(seen!.body) as { record: IdentityRecordType; signature: string };
      expect(body.record.address).toBe("ken@relay.test");
      expect(body.record.identity_pub).toBe(keys.identity_pub);

      // The record must be self-signed by the very key it publishes — that is
      // the only thing the relay can check. Verifying the actual bytes, not
      // just the signature's shape: signing the wrong transcript would look
      // identical to a shape assertion and be rejected by the relay forever.
      expect(await verifyTranscript(
        await importIdentityPublicKey(body.record.identity_pub),
        identityTranscript(body.record),
        body.signature,
      )).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("PUTs an encryption record with a signature the relay can verify", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      let seen: string | undefined;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        seen = String(init.body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }));

      await publishEncryptionKey("https://relay.test", auth, linePaths(home), "relay.test", 1_754_000_000_000);

      const body = JSON.parse(seen!) as { record: EncryptionKeyRecordType; signature: string };
      expect(body.record.epoch).toBe(keys.epoch);
      expect(body.record.not_before).toBe(1_754_000_000_000);
      expect(body.record.not_after - body.record.not_before).toBeLessThanOrEqual(2_592_000_000);

      // Verify the signature, not its shape: a shape check passes just as
      // happily when the wrong bytes were signed, and the relay would then
      // reject every publish this CLI ever makes.
      expect(await verifyTranscript(
        await importIdentityPublicKey(keys.identity_pub),
        encryptionKeyTranscript(body.record),
        body.signature,
      )).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("chains three locally rotated encryption-key transcripts", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-chain-"));
    try {
      const paths = linePaths(home);
      let keys = await generateIdentityKeys(paths);
      const publications: Array<{ record: EncryptionKeyRecordType; signature: string }> = [];
      const requests: Array<{ url: string; method: string | undefined }> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method });
        publications.push(JSON.parse(String(init.body)) as {
          record: EncryptionKeyRecordType; signature: string;
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }));

      await publishEncryptionKey("https://relay.test", auth, paths, "relay.test", 1_754_000_000_000);
      keys = await rotateEncryptionKey(paths);
      await publishEncryptionKey("https://relay.test", auth, paths, "relay.test", 1_754_001_000_000);
      keys = await rotateEncryptionKey(paths);
      await publishEncryptionKey("https://relay.test", auth, paths, "relay.test", 1_754_002_000_000);

      const records = publications.map(({ record }) => record);
      expect(records.map((record) => record.epoch)).toEqual([1, 2, 3]);
      expect(records[0]!.prev).toBeNull();
      expect(records[1]!.prev).toBe(await previousTranscriptHash(records[0]!));
      expect(records[1]!.prev).not.toBeNull();
      expect(records[2]!.prev).toBe(await previousTranscriptHash(records[1]!));
      const identityKey = await importIdentityPublicKey(keys.identity_pub);
      for (const publication of publications) {
        expect(await verifyTranscript(
          identityKey, encryptionKeyTranscript(publication.record), publication.signature,
        )).toBe(true);
      }
      expect(requests).toEqual(Array.from({ length: 3 }, () => ({
        url: "https://relay.test/v1/keys/encryption", method: "PUT",
      })));
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not make a failed publication the basis of a future rotation", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-chain-fail-"));
    try {
      const paths = linePaths(home);
      await generateIdentityKeys(paths);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
      await expect(publishEncryptionKey(
        "https://relay.test", auth, paths, "relay.test", 1_754_000_000_000,
      )).rejects.toThrow(/could not publish/i);
      await expect(rotateEncryptionKey(paths)).rejects.toThrow(/not been published/i);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("retries the exact signed epoch after commit succeeds but the response is lost", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-chain-retry-"));
    try {
      const paths = linePaths(home);
      await generateIdentityKeys(paths);
      const bodies: string[] = [];
      let attempt = 0;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        if (attempt++ === 0) throw new TypeError("response lost after commit");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }));

      await expect(publishEncryptionKey(
        "https://relay.test", auth, paths, "relay.test", 1_754_000_000_000,
      )).rejects.toMatchObject({ code: "network" });
      expect(loadPendingEncryptionPublication(paths)).toBeDefined();

      // A different `now` proves retry reuses persisted signed bytes rather
      // than constructing a conflicting record at the same epoch.
      await publishEncryptionKey(
        "https://relay.test", auth, paths, "relay.test", 1_755_000_000_000,
      );
      expect(bodies[1]).toBe(bodies[0]);
      expect(loadPendingEncryptionPublication(paths)).toBeDefined();
      expect(loadKeys(paths).published_encryption_transcript_hash).toMatch(/^[0-9a-f]{32}$/);
      expect((await rotateEncryptionKey(paths)).epoch).toBe(2);
      expect(loadPendingEncryptionPublication(paths)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes concurrent publishers onto the response-loss-recoverable pending body", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-chain-concurrent-"));
    try {
      const paths = linePaths(home);
      await generateIdentityKeys(paths);
      const bodies: string[] = [];
      let releaseBoth!: () => void;
      const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
      let attempt = 0;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        const thisAttempt = attempt++;
        bodies.push(String(init.body));
        if (bodies.length === 2) releaseBoth();
        await bothStarted;
        // The first request committed but its response vanished. The second
        // exact retry is the acknowledgement that lets local state advance.
        if (thisAttempt === 0) throw new TypeError("response lost after commit");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }));

      const results = await Promise.allSettled([
        publishEncryptionKey("https://relay.test", auth, paths, "relay.test", 1_754_000_000_000),
        publishEncryptionKey("https://relay.test", auth, paths, "relay.test", 1_755_000_000_000),
      ]);

      expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      const stored = loadKeys(paths);
      expect(loadPendingEncryptionPublication(paths, stored)).toBeDefined();
      expect(stored.published_encryption_transcript_hash).toMatch(/^[0-9a-f]{32}$/);
      expect((await rotateEncryptionKey(paths)).epoch).toBe(2);
      expect(loadPendingEncryptionPublication(paths)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not let a paused old publisher roll local state back after later rotations", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-chain-paused-publisher-"));
    try {
      const paths = linePaths(home);
      await generateIdentityKeys(paths);
      let firstStarted!: () => void;
      let releaseFirst!: () => void;
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let request = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        const current = request++;
        if (current === 0) {
          firstStarted();
          await release;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }));

      const oldPublisher = publishEncryptionKey(
        "https://relay.test", auth, paths, "relay.test", 1_754_000_000_000,
      );
      await started;
      // An exact concurrent publisher receives the acknowledgement and records
      // epoch 1 while the first process remains paused after its PUT.
      await publishEncryptionKey(
        "https://relay.test", auth, paths, "relay.test", 1_755_000_000_000,
      );
      const second = await rotateEncryptionKey(paths);
      await publishEncryptionKey(
        "https://relay.test", auth, paths, "relay.test", 1_756_000_000_000,
      );
      const third = await rotateEncryptionKey(paths);
      expect(second.epoch).toBe(2);
      expect(third.epoch).toBe(3);

      releaseFirst();
      await oldPublisher;
      expect(loadKeys(paths).epoch).toBe(3);
      expect(loadKeys(paths).encryption_pub).toBe(third.encryption_pub);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws a clear error when a handle has no published keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    try {
      await expect(fetchKeys("https://relay.test", auth, "nobody")).rejects.toThrow(/no published key/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips a well-formed 200 response into the typed identity and encryption records", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      const response = await buildValidKeysResponse(keys, "ken@relay.test");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));

      const result = await fetchKeys("https://relay.test", auth, "ken");

      expect(result.identity).toEqual(response.identity);
      expect(result.encryption.record).toEqual(response.encryption.record);
      expect(result.encryption.signature).toBe(response.encryption.signature);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a 200 response whose identity record is missing a required field", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      const response = await buildValidKeysResponse(keys, "ken@relay.test");
      const brokenIdentity: Record<string, unknown> = { ...response.identity };
      delete brokenIdentity.identity_pub;
      const malformed = { ...response, identity: brokenIdentity };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(malformed), { status: 200 })));

      await expect(fetchKeys("https://relay.test", auth, "ken")).rejects.toMatchObject({ code: "invalid" });
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a 200 response whose encryption record has an invalid key_id", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      const response = await buildValidKeysResponse(keys, "ken@relay.test");
      const malformed = {
        ...response,
        encryption: { ...response.encryption, record: { ...response.encryption.record, key_id: "not-32-hex-chars" } },
      };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(malformed), { status: 200 })));

      await expect(fetchKeys("https://relay.test", auth, "ken")).rejects.toMatchObject({ code: "invalid" });
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a 200 response whose records are for a different handle", async () => {
    // The attack this binds against: ask the relay for ken, get Sarah's
    // records back. They parse cleanly and Sarah really did sign them, so
    // nothing else in fetchKeys notices — and the caller then encrypts to
    // Sarah while believing it is talking to ken.
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      const response = await buildValidKeysResponse(keys, "sarah@relay.test");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));

      await expect(fetchKeys("https://relay.test", auth, "ken")).rejects.toMatchObject({ code: "invalid" });
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a 200 response whose two records name different addresses", async () => {
    // Half-swapped: the identity record is ken's, the encryption record is
    // someone else's. Pinning one address while encrypting to another is the
    // same failure with an extra step.
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      const response = await buildValidKeysResponse(keys, "ken@relay.test");
      const other = await buildValidKeysResponse(keys, "sarah@relay.test");
      const mixed = { identity: response.identity, encryption: other.encryption };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(mixed), { status: 200 })));

      await expect(fetchKeys("https://relay.test", auth, "ken")).rejects.toMatchObject({ code: "invalid" });
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a 200 response whose encryption signature is not a string", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateIdentityKeys(linePaths(home));
      const response = await buildValidKeysResponse(keys, "ken@relay.test");
      const malformed = { ...response, encryption: { ...response.encryption, signature: 12345 } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(malformed), { status: 200 })));

      await expect(fetchKeys("https://relay.test", auth, "ken")).rejects.toMatchObject({ code: "invalid" });
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
