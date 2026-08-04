import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { fixedRateLimit, registerHandle, wsAuth } from "./helpers.js";

const UPLOAD = {
  description: "Ken's public agent",
  agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [], keywords: [] },
    { id: "schedule-meeting", name: "Schedule", description: "Book a time.", examples: [], keywords: [] },
  ],
  default_offer: ["ask"],
  grants: { mia: ["schedule-meeting"] },
  group_grants: {},
  blocked: [],
};
const ORG_HEADERS = { "X-AgentCall-Org": "acme" };

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
    const res = await SELF.fetch("https://relay.test/v1/card/ken4", { headers: wsAuth("ken4", token) });
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
  it("404s for an authenticated tenant member when no card was pushed", async () => {
    await registerHandle("nocard");
    const viewer = await registerHandle("nocard-viewer");
    expect((await SELF.fetch("https://relay.test/v1/card/nocard", { headers: wsAuth("nocard-viewer", viewer) })).status).toBe(404);
  });
  it("treats malformed stored JSON as a missing card and logs safe metadata", async () => {
    await registerHandle("corrupt-card");
    const viewer = await registerHandle("corrupt-card-viewer");
    await env.DB.prepare("INSERT INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?)")
      .bind("acme", "corrupt-card", "{not json", 1).run();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invalid = await SELF.fetch("https://relay.test/v1/card/corrupt-card", {
        headers: wsAuth("corrupt-card-viewer", viewer),
      });
      const missing = await SELF.fetch("https://relay.test/v1/card/no-card-here", {
        headers: wsAuth("corrupt-card-viewer", viewer),
      });
      expect(invalid.status).toBe(missing.status);
      expect(invalid.headers.get("content-type")).toBe(missing.headers.get("content-type"));
      expect(await invalid.text()).toBe(await missing.text());
      expect(log).toHaveBeenCalledWith("invalid stored card", {
        org: "acme", handle: "corrupt-card", error: "SyntaxError",
      });
    } finally {
      log.mockRestore();
    }
  });
  it("401s an anonymous card read", async () => {
    const token = await registerHandle("private-card");
    await putCard("private-card", token);
    expect((await SELF.fetch("https://relay.test/v1/card/private-card", { headers: ORG_HEADERS })).status).toBe(401);
  });
  it("an authenticated tenant member sees default_offer tasks", async () => {
    const token = await registerHandle("pub");
    await putCard("pub", token);
    const viewer = await registerHandle("pub-viewer");
    const res = await SELF.fetch("https://relay.test/v1/card/pub", { headers: wsAuth("pub-viewer", viewer) });
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
  it("projects relay-attested group grants and lets an individual block override them", async () => {
    const target = await registerHandle("group-card");
    const created = await (await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST", headers: wsAuth("group-card", target),
    })).json<{ roster_id: string; join_key: string }>();
    const viewer = await registerHandle("group-viewer");
    await SELF.fetch(`https://relay.test/v1/roster/${created.roster_id}/join`, {
      method: "POST", headers: { "content-type": "application/json", ...wsAuth("group-viewer", viewer) },
      body: JSON.stringify({ join_key: created.join_key }),
    });
    const grouped = {
      ...UPLOAD, grants: {}, group_grants: { [created.roster_id]: ["schedule-meeting"] }, blocked: [],
    };
    await putCard("group-card", target, grouped);
    let res = await SELF.fetch("https://relay.test/v1/card/group-card", { headers: wsAuth("group-viewer", viewer) });
    expect((await res.json<{ tasks: { id: string }[] }>()).tasks.map((task) => task.id).sort())
      .toEqual(["ask", "schedule-meeting"]);
    await putCard("group-card", target, { ...grouped, blocked: ["group-viewer"] });
    res = await SELF.fetch("https://relay.test/v1/card/group-card", { headers: wsAuth("group-viewer", viewer) });
    expect((await res.json<{ tasks: { id: string }[] }>()).tasks).toEqual([]);
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

  it("throttles authenticated card reads from one source past the burst limit", async () => {
    const token = await registerHandle("rlcard");
    await putCard("rlcard", token);
    const viewer = await registerHandle("rlcard-viewer");
    const headers = { "cf-connecting-ip": "203.0.113.10", ...wsAuth("rlcard-viewer", viewer) };
    const limiter = fixedRateLimit(60);
    for (let i = 0; i < 60; i++) {
      expect((await app.request("https://relay.test/v1/card/rlcard", { headers }, { ...env, READ_RL: limiter })).status).toBe(200);
    }
    expect((await app.request("https://relay.test/v1/card/rlcard", { headers }, { ...env, READ_RL: limiter })).status).toBe(429);
  });

  it("401s when auth headers are present but invalid", async () => {
    const token = await registerHandle("ext3");
    await putCard("ext3", token);
    const res = await SELF.fetch("https://relay.test/v1/card/ext3", { headers: wsAuth("mia", "bad") });
    expect(res.status).toBe(401);
  });

  it("does not let credentials from another tenant select this tenant", async () => {
    const token = await registerHandle("tenant-card");
    await putCard("tenant-card", token);
    const outsider = await registerHandle("outsider", "claude", "beta");
    const headers = wsAuth("outsider", outsider, "beta");
    headers["X-AgentCall-Org"] = "acme";
    const known = await SELF.fetch("https://relay.test/v1/card/tenant-card", { headers });
    const unknown = await SELF.fetch("https://relay.test/v1/card/nobody-here", { headers });
    expect(known.status).toBe(401);
    expect(await known.text()).toBe(await unknown.text());
  });
});
