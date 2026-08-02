import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerHandle, getStatus, fetchCard, pushCard, rotateToken, createInvite, createRoster, joinRoster, fetchRosterBundle } from "../src/api.js";

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
  it("gets status and maps 404", async () => {
    const relay = await serve(200, { online: true });
    expect(await getStatus(relay, "ken", { org: "acme", handle: "me", token: "tok" })).toEqual({ online: true });
    const relay2 = await serve(404, { error: "unknown handle" });
    await expect(getStatus(relay2, "ghost", { org: "acme", handle: "me", token: "tok" })).rejects.toMatchObject({ code: "unknown_handle" });
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
    let headers: IncomingMessage["headers"] | undefined;
    const relay = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        headers = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ invite: "i".repeat(43), expires_at: Date.now() + 60_000 }));
      });
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    expect((await createInvite(relay, { org: "acme", handle: "ken", token: "tok" })).invite).toHaveLength(43);
    expect(headers?.authorization).toBe("Bearer tok");
    expect(headers?.["x-agentcall-org"]).toBe("acme");
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
      default_offer: ["ask"], grants: {},
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
  it("creates a roster and returns the secret once", async () => {
    const relay = await serve(200, { roster_id: "a".repeat(22), secret: "s3cret-value-long" });
    const r = await createRoster(relay, { org: "acme", handle: "ken", token: "t" });
    expect(r).toEqual({ roster_id: "a".repeat(22), secret: "s3cret-value-long" });
  });

  // The relay deliberately returns byte-identical 404s for "no such roster"
  // and "wrong secret", so the client message must not distinguish them
  // either — otherwise a garbage-secret probe would make roster ids
  // enumerable, defeating the relay-side protection.
  it("maps a 404 join to a message that does not distinguish the two causes", async () => {
    const relay = await serve(404, { error: "not found" });
    await expect(joinRoster(relay, { org: "acme", handle: "ken", token: "t" }, "a".repeat(22), "wrong"))
      .rejects.toThrow(/no such roster, or the secret is wrong/i);
  });

  it("maps a 409 join to a roster-full message", async () => {
    const relay = await serve(409, { error: "roster full" });
    await expect(joinRoster(relay, { org: "acme", handle: "ken", token: "t" }, "a".repeat(22), "s"))
      .rejects.toThrow(/full/i);
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
