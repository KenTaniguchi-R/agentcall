import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const UPLOAD = {
  description: "Ken's public agent",
  agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [], tier: "T1" },
    { id: "schedule-meeting", name: "Schedule", description: "Book a time.", examples: [], tier: "T2" },
  ],
  default_offer: ["ask"],
  grants: { mia: ["schedule-meeting"] },
};

async function putCard(handle: string, token: string, body: unknown = UPLOAD) {
  return SELF.fetch("https://relay.test/v1/card", {
    method: "PUT",
    headers: { "content-type": "application/json", ...wsAuth(handle, token) },
    body: JSON.stringify(body),
  });
}

describe("PUT /v1/card", () => {
  it("stores a card for an authenticated handle", async () => {
    const token = await registerHandle("ken");
    expect((await putCard("ken", token)).status).toBe(200);
  });
  it("401s on a bad token", async () => {
    await registerHandle("ken2");
    expect((await putCard("ken2", "wrong-token")).status).toBe(401);
  });
  it("400s on an invalid card body", async () => {
    const token = await registerHandle("ken3");
    expect((await putCard("ken3", token, { agent_kind: "vim", tasks: [], default_offer: [] })).status).toBe(400);
  });
  it("upserts: a second push replaces the first", async () => {
    const token = await registerHandle("ken4");
    await putCard("ken4", token);
    await putCard("ken4", token, { ...UPLOAD, description: "updated" });
    const res = await SELF.fetch("https://relay.test/v1/card/ken4");
    expect((await res.json<{ description: string }>()).description).toBe("updated");
  });

  it("rate limits card pushes for a single handle past the configured burst limit", async () => {
    const token = await registerHandle("cardrl");
    for (let i = 0; i < 20; i++) {
      expect((await putCard("cardrl", token)).status).toBe(200);
    }
    expect((await putCard("cardrl", token)).status).toBe(429);
  });

  it("does not rate limit an invalid token before it 401s", async () => {
    await registerHandle("cardrl2");
    for (let i = 0; i < 25; i++) {
      expect((await putCard("cardrl2", "wrong-token")).status).toBe(401);
    }
  });
});

describe("GET /v1/card/:handle", () => {
  it("404s when no card was pushed", async () => {
    await registerHandle("nocard");
    expect((await SELF.fetch("https://relay.test/v1/card/nocard")).status).toBe(404);
  });
  it("public view shows only default_offer tasks", async () => {
    const token = await registerHandle("pub");
    await putCard("pub", token);
    const res = await SELF.fetch("https://relay.test/v1/card/pub");
    expect(res.status).toBe(200);
    const card = await res.json<{ handle: string; tasks: { id: string }[] }>();
    expect(card.handle).toBe("pub");
    expect(card.tasks.map((t) => t.id)).toEqual(["ask"]);
  });
  it("extended view adds the viewer's granted tasks", async () => {
    const token = await registerHandle("ext");
    await putCard("ext", token);
    const miaToken = await registerHandle("mia");
    const res = await SELF.fetch("https://relay.test/v1/card/ext", { headers: wsAuth("mia", miaToken) });
    const card = await res.json<{ tasks: { id: string }[] }>();
    expect(card.tasks.map((t) => t.id).sort()).toEqual(["ask", "schedule-meeting"]);
  });
  it("a different authenticated viewer does NOT see another caller's grants", async () => {
    const token = await registerHandle("ext2");
    await putCard("ext2", token);
    const otherToken = await registerHandle("other");
    const res = await SELF.fetch("https://relay.test/v1/card/ext2", { headers: wsAuth("other", otherToken) });
    const card = await res.json<{ tasks: { id: string }[] }>();
    expect(card.tasks.map((t) => t.id)).toEqual(["ask"]);
  });
  // HANDLE_RE accepts "constructor", and the parsed card's `grants` object
  // inherits Object.prototype — so an unguarded `grants[viewer]` lookup yields
  // the Object constructor, which is not iterable and 500s the whole endpoint
  // for that viewer against every callee.
  it("serves the public view to a viewer whose handle is an Object.prototype key", async () => {
    const token = await registerHandle("ext4");
    await putCard("ext4", token);
    const ctorToken = await registerHandle("constructor");
    const res = await SELF.fetch("https://relay.test/v1/card/ext4", { headers: wsAuth("constructor", ctorToken) });
    expect(res.status).toBe(200);
    const card = await res.json<{ tasks: { id: string }[] }>();
    expect(card.tasks.map((t) => t.id)).toEqual(["ask"]);
  });

  it("401s when auth headers are present but invalid", async () => {
    const token = await registerHandle("ext3");
    await putCard("ext3", token);
    const res = await SELF.fetch("https://relay.test/v1/card/ext3", { headers: wsAuth("mia", "bad") });
    expect(res.status).toBe(401);
  });
});
