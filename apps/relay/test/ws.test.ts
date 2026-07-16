import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth, openWs, closed, nextFrame } from "./helpers.js";

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

  it("a caller-only handle can authenticate and place a call", async () => {
    // Callee: a normal, callable registration with a listener attached.
    const hostToken = await registerHandle("host1");
    const listener = await openWs("/v1/ws?role=listen", wsAuth("host1", hostToken));
    const incoming = nextFrame(listener);

    // Caller: registered with no agent_kind at all.
    const res = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "solo2" }),
    });
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();

    const caller = await openWs("/v1/ws?role=call&to=host1", wsAuth("solo2", token));
    caller.send(JSON.stringify({ type: "call_request", to: "host1", message: "hi" }));
    const frame = await incoming;
    expect(frame.type).toBe("incoming_call");
    expect(frame.from).toBe("solo2");
  });
});
