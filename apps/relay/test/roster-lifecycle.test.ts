import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

async function create(handle: string) {
  const token = await registerHandle(handle);
  const res = await SELF.fetch("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": handle, ...wsAuth(handle, token) },
  });
  return { token, ...(await res.json<{ roster_id: string; join_secret: string; admin_secret: string }>()) };
}

async function mutate(id: string, op: string, handle: string, token: string, body: unknown, ip = `${op}-${handle}`) {
  return SELF.fetch(`https://relay.test/v1/roster/${id}/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...wsAuth(handle, token) },
    body: JSON.stringify(body),
  });
}

async function join(id: string, handle: string, token: string, join_secret: string) {
  return mutate(id, "join", handle, token, { join_secret });
}

async function isMember(id: string, handle: string) {
  return Boolean(await env.DB.prepare(
    "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
  ).bind(id, handle).first());
}

describe("roster lifecycle", () => {
  it("shares one budget across alternating write operations and source IPs", async () => {
    const r = await create("alternating-limit");
    const attempts = [
      ["join", { join_secret: "wrong" }],
      ["expel", {}],
      ["rotate", {}],
      ["delete", {}],
    ] as const;
    for (let attempt = 0; attempt < 10; attempt++) {
      const [op, body] = attempts[attempt % attempts.length];
      expect((await mutate(
        r.roster_id, op, "alternating-limit", r.token, body, `192.0.2.${attempt + 1}`,
      )).status).toBe(404);
    }
    expect((await mutate(
      r.roster_id, "leave", "alternating-limit", r.token, {}, "198.51.100.200",
    )).status).toBe(429);
    expect(await isMember(r.roster_id, "alternating-limit")).toBe(true);
  });

  it("lets a member leave, preserves evidence, and keeps the empty roster", async () => {
    const r = await create("leave1");
    expect((await mutate(r.roster_id, "leave", "leave1", r.token, {})).status).toBe(200);
    expect(await isMember(r.roster_id, "leave1")).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM rosters WHERE id = ?").bind(r.roster_id).first()).toBeTruthy();
    expect(await env.DB.prepare(
      "SELECT 1 FROM roster_events WHERE roster_id = ? AND kind = 'leave' AND actor = 'leave1'",
    ).bind(r.roster_id).first()).toBeTruthy();
  });

  it("requires the separate admin secret to expel and allows rejoin with an unchanged join secret", async () => {
    const r = await create("expel1");
    const memberToken = await registerHandle("expel2");
    expect((await join(r.roster_id, "expel2", memberToken, r.join_secret)).status).toBe(200);
    const denied = await mutate(r.roster_id, "expel", "expel1", r.token, { admin_secret: r.join_secret, handle: "expel2" });
    const missing = await mutate("A".repeat(22), "expel", "expel1", r.token, { admin_secret: r.join_secret, handle: "expel2" });
    expect(Object.fromEntries(denied.headers)).toEqual(Object.fromEntries(missing.headers));
    expect([denied.status, await denied.text()]).toEqual([missing.status, await missing.text()]);
    expect((await mutate(r.roster_id, "expel", "expel1", r.token, {
      admin_secret: r.admin_secret, handle: "expel2",
    })).status).toBe(200);
    expect(await isMember(r.roster_id, "expel2")).toBe(false);
    expect((await join(r.roster_id, "expel2", memberToken, r.join_secret)).status).toBe(200);
  });

  it("makes non-membership indistinguishable from an unknown roster", async () => {
    const r = await create("hidden1");
    const token = await registerHandle("hidden2");
    const nonmember = await mutate(r.roster_id, "leave", "hidden2", token, {});
    const missing = await mutate("B".repeat(22), "leave", "hidden2", token, {});
    expect(Object.fromEntries(nonmember.headers)).toEqual(Object.fromEntries(missing.headers));
    expect([nonmember.status, await nonmember.text()]).toEqual([missing.status, await missing.text()]);
  });

  it("rotates the join secret without touching members by default", async () => {
    const r = await create("rotate1");
    const res = await mutate(r.roster_id, "rotate", "rotate1", r.token, { admin_secret: r.admin_secret });
    expect(res.status).toBe(200);
    const { join_secret } = await res.json<{ join_secret: string }>();
    expect(await isMember(r.roster_id, "rotate1")).toBe(true);
    const newcomer = await registerHandle("rotate2");
    expect((await join(r.roster_id, "rotate2", newcomer, r.join_secret)).status).toBe(404);
    expect((await join(r.roster_id, "rotate2", newcomer, join_secret)).status).toBe(200);
  });

  it("rotate with eviction clears every member while preserving roster and admin authority", async () => {
    const r = await create("evict1");
    const memberToken = await registerHandle("evict2");
    await join(r.roster_id, "evict2", memberToken, r.join_secret);
    const rotated = await mutate(r.roster_id, "rotate", "evict1", r.token, {
      admin_secret: r.admin_secret, evict: true,
    });
    expect(rotated.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM roster_members WHERE roster_id = ?").bind(r.roster_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM rosters WHERE id = ?").bind(r.roster_id).first()).toBeTruthy();
    expect((await mutate(r.roster_id, "rotate", "evict1", r.token, { admin_secret: r.admin_secret })).status).toBe(200);
    const events = await env.DB.prepare("SELECT kind FROM roster_events WHERE roster_id = ? ORDER BY id").bind(r.roster_id).all<{ kind: string }>();
    expect(events.results.map((event) => event.kind)).toContain("evict_all");
  });

  it("deletes live state but retains append-only audit events", async () => {
    const r = await create("delete1");
    expect((await mutate(r.roster_id, "delete", "delete1", r.token, { admin_secret: r.admin_secret })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM rosters WHERE id = ?").bind(r.roster_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM roster_members WHERE roster_id = ?").bind(r.roster_id).first()).toBeNull();
    const events = await env.DB.prepare("SELECT kind FROM roster_events WHERE roster_id = ? ORDER BY id").bind(r.roster_id).all<{ kind: string }>();
    expect(events.results.map((event) => event.kind)).toEqual(["create", "delete"]);
  });
});
