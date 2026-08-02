import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const card = (tasks: unknown[], defaultOffer: string[], grants: Record<string, string[]> = {}) => ({
  description: "d", agent_kind: "claude", tasks, default_offer: defaultOffer, grants,
});
const task = (id: string, keywords: string[] = []) =>
  ({ id, name: id.toUpperCase(), description: `About ${id}.`, examples: [], keywords });

async function setup(prefix: string) {
  const ownerToken = await registerHandle(`${prefix}own`);
  const created = await (await SELF.fetch("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": `test-${prefix}`, ...wsAuth(`${prefix}own`, ownerToken) },
  })).json<{ roster_id: string; secret: string }>();
  return { ownerToken, ...created };
}

async function joinAs(id: string, handle: string, secret: string) {
  const token = await registerHandle(handle);
  await SELF.fetch(`https://relay.test/v1/roster/${id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
    body: JSON.stringify({ secret }),
  });
  return token;
}

async function putCard(handle: string, token: string, body: unknown) {
  return SELF.fetch("https://relay.test/v1/card", {
    method: "PUT",
    headers: { "content-type": "application/json", ...wsAuth(handle, token) },
    body: JSON.stringify(body),
  });
}

const getBundle = (id: string, handle: string, token: string, extra: Record<string, string> = {}) =>
  SELF.fetch(`https://relay.test/v1/roster/${id}/bundle`, {
    headers: { "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token), ...extra },
  });

describe("GET /v1/roster/:id/bundle", () => {
  it("returns members' publicly offered tasks to a member", async () => {
    const r = await setup("b1");
    const tanaka = await joinAs(r.roster_id, "b1tanaka", r.secret);
    await putCard("b1tanaka", tanaka, card([task("adr", ["auth"])], ["adr"]));
    const body = await (await getBundle(r.roster_id, "b1own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).toEqual(["b1tanaka"]);
    expect(body.entries[0].tasks[0].keywords).toEqual(["auth"]);
  });

  it("shows a privately granted task only to its grantee", async () => {
    const r = await setup("b2");
    const tanaka = await joinAs(r.roster_id, "b2tanaka", r.secret);
    const mia = await joinAs(r.roster_id, "b2mia", r.secret);
    await putCard("b2tanaka", tanaka, card([task("ask"), task("payroll")], ["ask"], { b2mia: ["payroll"] }));
    const forMia = await (await getBundle(r.roster_id, "b2mia", mia)).json<any>();
    const forOwner = await (await getBundle(r.roster_id, "b2own", r.ownerToken)).json<any>();
    const ids = (b: any, h: string) => b.entries.find((e: any) => e.handle === h).tasks.map((t: any) => t.id);
    expect(ids(forMia, "b2tanaka").sort()).toEqual(["ask", "payroll"]);
    expect(ids(forOwner, "b2tanaka")).toEqual(["ask"]);
  });

  // The claim the first design draft got wrong: an entry carrying a handle
  // still discloses membership even with zero tasks. Omission is what makes
  // a member invisible. This endpoint is a search index, not a directory.
  it("omits a member with no visible tasks entirely", async () => {
    const r = await setup("b3");
    const quiet = await joinAs(r.roster_id, "b3quiet", r.secret);
    await putCard("b3quiet", quiet, card([task("payroll")], [], { someone_else: ["payroll"] }));
    const body = await (await getBundle(r.roster_id, "b3own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).not.toContain("b3quiet");
  });

  it("omits a member who has published no card at all", async () => {
    const r = await setup("b4");
    await joinAs(r.roster_id, "b4nocard", r.secret);
    const body = await (await getBundle(r.roster_id, "b4own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).not.toContain("b4nocard");
  });

  it("makes a non-member byte-identical to an unknown roster", async () => {
    const r = await setup("b5");
    const outsider = await registerHandle("b5out");
    const denied = await getBundle(r.roster_id, "b5out", outsider);
    const missing = await getBundle("A".repeat(22), "b5out", outsider);
    expect(denied.status).toBe(missing.status);
    expect(await denied.text()).toBe(await missing.text());
    expect(denied.status).toBe(404);
  });

  it("401s without credentials", async () => {
    const r = await setup("b6");
    expect((await SELF.fetch(`https://relay.test/v1/roster/${r.roster_id}/bundle`)).status).toBe(401);
  });

  it("caps tasks per member and flags the entry as truncated", async () => {
    const r = await setup("b7");
    const many = await joinAs(r.roster_id, "b7many", r.secret);
    const ids = Array.from({ length: 15 }, (_, i) => `t${i}`);
    await putCard("b7many", many, card(ids.map((id) => task(id)), ids));
    const body = await (await getBundle(r.roster_id, "b7own", r.ownerToken)).json<any>();
    const entry = body.entries.find((e: any) => e.handle === "b7many");
    expect(entry.tasks).toHaveLength(10);
    expect(entry.truncated).toBe(true);
  });

  it("skips a malformed stored card without 500ing the whole bundle", async () => {
    const r = await setup("b8");
    const good = await joinAs(r.roster_id, "b8good", r.secret);
    await joinAs(r.roster_id, "b8bad", r.secret);
    await putCard("b8good", good, card([task("adr")], ["adr"]));
    const db = (await import("cloudflare:test")).env.DB;
    await db.prepare("INSERT INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?)")
      .bind("acme", "b8bad", "{not json", Date.now()).run();
    const res = await getBundle(r.roster_id, "b8own", r.ownerToken);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.entries.map((e: any) => e.handle)).toEqual(["b8good"]);
    expect(body.skipped).toBe(1);
  });

  it("304s an unchanged bundle and forbids shared caching", async () => {
    const r = await setup("b9");
    const t = await joinAs(r.roster_id, "b9t", r.secret);
    await putCard("b9t", t, card([task("adr")], ["adr"]));
    const first = await getBundle(r.roster_id, "b9own", r.ownerToken);
    expect(first.headers.get("Cache-Control")).toContain("private");
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const second = await getBundle(r.roster_id, "b9own", r.ownerToken, { "If-None-Match": etag });
    expect(second.status).toBe(304);
  });

  it("gives two different callers different ETags", async () => {
    const r = await setup("b10");
    const t = await joinAs(r.roster_id, "b10t", r.secret);
    const mia = await joinAs(r.roster_id, "b10mia", r.secret);
    await putCard("b10t", t, card([task("ask")], ["ask"]));
    const a = await getBundle(r.roster_id, "b10own", r.ownerToken);
    const b = await getBundle(r.roster_id, "b10mia", mia);
    expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
  });
});
