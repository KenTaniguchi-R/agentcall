import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth, openWs, closed } from "./helpers.js";

describe("listener attach + status", () => {
  it("401s a listener with a bad token", async () => {
    await registerHandle("bob");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=listen", {
      headers: { Upgrade: "websocket", ...wsAuth("bob", "wrong-token") },
    });
    expect(res.status).toBe(401);
  });

  it("status flips online when a listener attaches", async () => {
    const token = await registerHandle("carol");
    let status = await SELF.fetch("https://relay.test/v1/status/carol");
    expect((await status.json<{ online: boolean }>()).online).toBe(false);

    await openWs("/v1/ws?role=listen", wsAuth("carol", token));
    status = await SELF.fetch("https://relay.test/v1/status/carol");
    expect((await status.json<{ online: boolean }>()).online).toBe(true);
  });

  it("404s status for unknown handle", async () => {
    const res = await SELF.fetch("https://relay.test/v1/status/nobody");
    expect(res.status).toBe(404);
  });

  it("replaces an existing listener (old socket closed with 4000)", async () => {
    const token = await registerHandle("dave");
    const first = await openWs("/v1/ws?role=listen", wsAuth("dave", token));
    const firstClosed = closed(first);
    await openWs("/v1/ws?role=listen", wsAuth("dave", token));
    expect((await firstClosed).code).toBe(4000);
  });

  it("404s a call to an unregistered target", async () => {
    const token = await registerHandle("erin");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=call&to=ghost", {
      headers: { Upgrade: "websocket", ...wsAuth("erin", token) },
    });
    expect(res.status).toBe(404);
  });

  it("426s a websocket request without the Upgrade header", async () => {
    const token = await registerHandle("frank");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=listen", { headers: wsAuth("frank", token) });
    expect(res.status).toBe(426);
  });

  it("400s a bogus role", async () => {
    const token = await registerHandle("gina");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=bogus", {
      headers: { Upgrade: "websocket", ...wsAuth("gina", token) },
    });
    expect(res.status).toBe(400);
  });
});
