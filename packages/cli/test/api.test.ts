import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerHandle, getStatus } from "../src/api.js";

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
    const relay = await serve(200, { token: "tok", address: "ken@agentcall.benree.tech" });
    expect(await registerHandle(relay, "ken", "claude")).toEqual({ token: "tok", address: "ken@agentcall.benree.tech" });
  });
  it("rejects a malformed handle locally, without hitting the relay", async () => {
    // Point at a port nothing is listening on: if validation didn't run
    // before fetch, this would reject with code "network" instead.
    await expect(registerHandle("http://127.0.0.1:1", "Not Valid!", "claude"))
      .rejects.toMatchObject({ code: "invalid" });
  });
  it("rejects a reserved handle locally, without hitting the relay", async () => {
    await expect(registerHandle("http://127.0.0.1:1", "admin", "claude"))
      .rejects.toMatchObject({ code: "invalid" });
  });
  it("maps 409 to handle_taken", async () => {
    const relay = await serve(409, { error: "handle taken" });
    await expect(registerHandle(relay, "ken", "claude")).rejects.toMatchObject({ code: "handle_taken" });
  });
  it("register times out with a clear error when the relay never responds", async () => {
    const relay = await serveNever();
    await expect(registerHandle(relay, "ken", "claude", { timeoutMs: 100 })).rejects.toMatchObject({
      code: "network",
      message: expect.stringMatching(/did not respond/),
    });
  });
  it("status times out with a clear error when the relay never responds", async () => {
    const relay = await serveNever();
    await expect(getStatus(relay, "ken", { timeoutMs: 100 })).rejects.toMatchObject({
      code: "network",
      message: expect.stringMatching(/did not respond/),
    });
  });
  it("gets status and maps 404", async () => {
    const relay = await serve(200, { online: true });
    expect(await getStatus(relay, "ken")).toEqual({ online: true });
    const relay2 = await serve(404, { error: "unknown handle" });
    await expect(getStatus(relay2, "ghost")).rejects.toMatchObject({ code: "unknown_handle" });
  });
  it("registers caller-only: omits agent_kind from the request body entirely", async () => {
    const captured: unknown[] = [];
    const relay = await serveCapturing(200, { token: "tok", address: "solo@agentcall.benree.tech" }, captured);
    expect(await registerHandle(relay, "solo")).toEqual({ token: "tok", address: "solo@agentcall.benree.tech" });
    expect(captured).toEqual([{ handle: "solo" }]);
  });
});
