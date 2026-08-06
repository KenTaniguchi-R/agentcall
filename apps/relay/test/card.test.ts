import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { fixedRateLimit, registerHandle, wsAuth, agentIdFor} from "./helpers.js";

const UPLOAD = {
  description: "Ken's public agent",
  agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [], keywords: [] },
    { id: "schedule-meeting", name: "Schedule", description: "Book a time.", examples: [], keywords: [] },
  ],
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
    expect((await putCard("ken3", token, { agent_kind: "vim", tasks: [] })).status).toBe(400);
  });
  // #379 deleted the per-caller menu from the card shape. A push still
  // carrying it must be refused, not accepted with the menu ignored: silently
  // dropping `grants` would publish every task to callers the owner believed
  // were restricted.
  it("400s on a card still carrying the deleted task menu", async () => {
    const token = await registerHandle("ken3-menu");
    expect((await putCard("ken3-menu", token, {
      ...UPLOAD, default_offer: ["ask"], grants: { mia: ["schedule-meeting"] }, group_grants: {},
    })).status).toBe(400);
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
  // #154 slice 5. A card belongs to the identity that published it, so the
  // row is not reachable by address alone -- which is what stops a future
  // reassigned handle from inheriting the previous owner's published tasks
  // and caller grants.
  it("stores a published card against the publisher's identity", async () => {
    const token = await registerHandle("owns-its-card");
    await SELF.fetch("https://relay.test/v1/card", {
      method: "PUT",
      headers: { "content-type": "application/json", ...wsAuth("owns-its-card", token) },
      body: JSON.stringify({
        description: "mine", agent_kind: "claude", tasks: [], blocked: [],
      }),
    });
    const agentId = await agentIdFor("owns-its-card");
    const byIdentity = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cards WHERE org = ? AND agent_id = ?",
    ).bind("acme", agentId).first<{ n: number }>();
    expect(byIdentity?.n).toBe(1);
    // The address is not part of the key at all, so a row cannot be addressed
    // by it even accidentally.
    const columns = await env.DB.prepare("SELECT * FROM cards LIMIT 1").first<Record<string, unknown>>();
    expect(Object.keys(columns ?? {})).not.toContain("handle");
  });

  it("treats malformed stored JSON as a missing card and logs safe metadata", async () => {
    await registerHandle("corrupt-card");
    const viewer = await registerHandle("corrupt-card-viewer");
    await env.DB.prepare("INSERT INTO cards (org, agent_id, card_json, updated_at) VALUES (?, ?, ?, ?)")
      .bind("acme", await agentIdFor("corrupt-card"), "{not json", 1).run();
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
  it("an authenticated tenant member sees the whole task list", async () => {
    const token = await registerHandle("pub");
    await putCard("pub", token);
    const viewer = await registerHandle("pub-viewer");
    const res = await SELF.fetch("https://relay.test/v1/card/pub", { headers: wsAuth("pub-viewer", viewer) });
    expect(res.status).toBe(200);
    const card = await res.json<{ handle: string; tasks: { id: string }[] }>();
    expect(card.handle).toBe("pub");
    expect(card.tasks.map((t) => t.id)).toEqual(["ask", "schedule-meeting"]);
  });
  // Replaces the three tests that pinned the per-caller extended view, the
  // grant-leak check between two viewers, and the roster-attested group
  // projection. #379 deleted all three mechanisms: every viewer now gets the
  // identical list, so the property worth pinning is that it does NOT vary by
  // viewer, roster membership, or anything else short of a block.
  it("serves the identical list to every viewer, regardless of roster membership", async () => {
    const target = await registerHandle("same-for-all");
    const created = await (await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST", headers: wsAuth("same-for-all", target),
    })).json<{ roster_id: string; join_key: string }>();
    const member = await registerHandle("roster-member");
    await SELF.fetch(`https://relay.test/v1/roster/${created.roster_id}/join`, {
      method: "POST", headers: { "content-type": "application/json", ...wsAuth("roster-member", member) },
      body: JSON.stringify({ join_key: created.join_key }),
    });
    await putCard("same-for-all", target);
    const stranger = await registerHandle("no-roster");
    for (const [handle, token] of [["roster-member", member], ["no-roster", stranger]] as const) {
      const res = await SELF.fetch("https://relay.test/v1/card/same-for-all", { headers: wsAuth(handle, token) });
      expect((await res.json<{ tasks: { id: string }[] }>()).tasks.map((t) => t.id))
        .toEqual(["ask", "schedule-meeting"]);
    }
  });
  // The surviving half of the old group-grant test. A block is the one rule
  // clearance cannot express as a level, and it is now the ONLY thing that
  // changes a card between viewers.
  it("gives a blocked viewer nothing, the only per-viewer difference left", async () => {
    const target = await registerHandle("blocks-one");
    const viewer = await registerHandle("gets-blocked");
    await putCard("blocks-one", target);
    let res = await SELF.fetch("https://relay.test/v1/card/blocks-one", { headers: wsAuth("gets-blocked", viewer) });
    expect((await res.json<{ tasks: { id: string }[] }>()).tasks.map((t) => t.id))
      .toEqual(["ask", "schedule-meeting"]);
    await putCard("blocks-one", target, { ...UPLOAD, blocked: ["gets-blocked"] });
    res = await SELF.fetch("https://relay.test/v1/card/blocks-one", { headers: wsAuth("gets-blocked", viewer) });
    expect((await res.json<{ tasks: { id: string }[] }>()).tasks).toEqual([]);
  });
  // HANDLE_RE accepts "constructor". The old `grants[viewer]` lookup yielded
  // the Object constructor for such a viewer — not iterable, 500ing the whole
  // endpoint against every callee. There is no record lookup left to trip on,
  // and this pins that such a viewer is served as an ordinary one.
  it("serves a viewer whose handle is an Object.prototype key as an ordinary viewer", async () => {
    const token = await registerHandle("ext4");
    await putCard("ext4", token);
    const ctorToken = await registerHandle("constructor");
    const res = await SELF.fetch("https://relay.test/v1/card/ext4", { headers: wsAuth("constructor", ctorToken) });
    expect(res.status).toBe(200);
    const card = await res.json<{ tasks: { id: string }[] }>();
    expect(card.tasks.map((t) => t.id)).toEqual(["ask", "schedule-meeting"]);
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
