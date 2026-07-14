import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerHandle, getStatus } from "../src/api.js";

let server: Server;
afterEach(() => server?.close());

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

describe("api client", () => {
  it("registers", async () => {
    const relay = await serve(200, { token: "tok", address: "ken@agentcall.benree.tech" });
    expect(await registerHandle(relay, "ken", "claude")).toEqual({ token: "tok", address: "ken@agentcall.benree.tech" });
  });
  it("maps 409 to handle_taken", async () => {
    const relay = await serve(409, { error: "handle taken" });
    await expect(registerHandle(relay, "ken", "claude")).rejects.toMatchObject({ code: "handle_taken" });
  });
  it("gets status and maps 404", async () => {
    const relay = await serve(200, { online: true });
    expect(await getStatus(relay, "ken")).toEqual({ online: true });
    const relay2 = await serve(404, { error: "unknown handle" });
    await expect(getStatus(relay2, "ghost")).rejects.toMatchObject({ code: "unknown_handle" });
  });
});
