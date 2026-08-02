import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_ROSTER_AUDIT_EVENTS } from "../src/events.js";
import app from "../src/index.js";
import { registerHandle, wsAuth } from "./helpers.js";

async function create(handle: string, ip = handle, country = "US") {
  const token = await registerHandle(handle);
  const res = await SELF.fetch(new Request("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": ip, ...wsAuth(handle, token) },
    cf: { country },
  }));
  return { token, ...(await res.json<{ roster_id: string; join_secret: string; admin_secret: string }>()) };
}

async function mutate(
  id: string, op: string, handle: string, token: string, body: unknown,
  ip = `${op}-${handle}`, country = "US",
) {
  return SELF.fetch(new Request(`https://relay.test/v1/roster/${id}/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...wsAuth(handle, token) },
    body: JSON.stringify(body),
    cf: { country },
  }));
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
      "SELECT 1 FROM roster_events WHERE roster_id = ? AND event = 'roster.leave' AND actor = 'leave1'",
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
    const events = await env.DB.prepare("SELECT event FROM roster_events WHERE roster_id = ? ORDER BY id").bind(r.roster_id).all<{ event: string }>();
    expect(events.results.map((event) => event.event)).toContain("roster.evict_all");
  });

  it("does not return a secret or audit a rotation that loses a delete race", async () => {
    const r = await create("rotate-race");
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ?").bind(r.roster_id),
          env.DB.prepare("DELETE FROM rosters WHERE id = ?").bind(r.roster_id),
        ]);
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;

    const response = await app.request(`https://relay.test/v1/roster/${r.roster_id}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...wsAuth("rotate-race", r.token) },
      body: JSON.stringify({ admin_secret: r.admin_secret }),
    }, { ...env, DB: db });
    expect([response.status, await response.json()]).toEqual([404, { error: "not found" }]);
    expect(await env.DB.prepare(
      "SELECT 1 FROM roster_events WHERE roster_id = ? AND event = 'roster.rotate'",
    ).bind(r.roster_id).first()).toBeNull();
  });

  it("persistently bounds membership audit events and records exhaustion once", async () => {
    const r = await create("budget-owner");
    const memberToken = await registerHandle("budget-member");
    const waitingToken = await registerHandle("budget-waiting");
    expect((await join(r.roster_id, "budget-member", memberToken, r.join_secret)).status).toBe(200);
    await env.DB.prepare("UPDATE rosters SET audit_budget_used = ? WHERE id = ?")
      .bind(MAX_ROSTER_AUDIT_EVENTS, r.roster_id).run();

    expect((await join(r.roster_id, "budget-member", memberToken, r.join_secret)).status).toBe(200);
    expect((await join(r.roster_id, "budget-waiting", waitingToken, r.join_secret)).status).toBe(409);
    expect((await join(r.roster_id, "budget-waiting", waitingToken, r.join_secret)).status).toBe(409);
    expect((await mutate(r.roster_id, "leave", "budget-owner", r.token, {})).status).toBe(409);
    expect(await isMember(r.roster_id, "budget-owner")).toBe(true);
    expect(await isMember(r.roster_id, "budget-waiting")).toBe(false);

    const exhausted = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_events " +
        "WHERE roster_id = ? AND event = 'roster.audit_budget_exhausted'",
    ).bind(r.roster_id).first<{ n: number }>();
    expect(exhausted?.n).toBe(1);

    expect((await mutate(r.roster_id, "expel", "budget-owner", r.token, {
      admin_secret: r.admin_secret, handle: "budget-member",
    })).status).toBe(200);
    expect((await mutate(r.roster_id, "rotate", "budget-owner", r.token, {
      admin_secret: r.admin_secret,
    })).status).toBe(200);
    expect((await mutate(r.roster_id, "delete", "budget-owner", r.token, {
      admin_secret: r.admin_secret,
    })).status).toBe(200);
  });

  it("deletes live state but retains append-only audit events", async () => {
    const r = await create("delete1");
    expect((await mutate(r.roster_id, "delete", "delete1", r.token, { admin_secret: r.admin_secret })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM rosters WHERE id = ?").bind(r.roster_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM roster_members WHERE roster_id = ?").bind(r.roster_id).first()).toBeNull();
    const events = await env.DB.prepare("SELECT event FROM roster_events WHERE roster_id = ? ORDER BY id").bind(r.roster_id).all<{ event: string }>();
    expect(events.results.map((event) => event.event)).toEqual(["roster.create", "roster.delete"]);
  });

  it("records complete, namespaced audit evidence for every mutation", async () => {
    const r = await create("audit-owner", "192.0.2.10", "JP");
    const memberToken = await registerHandle("audit-member");
    expect((await mutate(
      r.roster_id, "join", "audit-member", memberToken, { join_secret: r.join_secret }, "192.0.2.11", "CA",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "leave", "audit-member", memberToken, {}, "192.0.2.15", "AU",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "join", "audit-member", memberToken, { join_secret: r.join_secret }, "192.0.2.16", "NZ",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "expel", "audit-owner", r.token,
      { admin_secret: r.admin_secret, handle: "audit-member" }, "192.0.2.12", "DE",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "rotate", "audit-owner", r.token,
      { admin_secret: r.admin_secret, evict: true }, "192.0.2.13", "FR",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "delete", "audit-owner", r.token,
      { admin_secret: r.admin_secret }, "192.0.2.14", "GB",
    )).status).toBe(200);

    type AuditRow = {
      event: string; action_type: string; actor: string; actor_type: string;
      target_type: string | null; target_id: string | null;
      actor_ip: string | null; actor_country: string | null; description: string; org: string; at: number;
    };
    const { results } = await env.DB.prepare(
      "SELECT event, action_type, actor, actor_type, target_type, target_id, " +
        "actor_ip, actor_country, description, org, at FROM roster_events WHERE roster_id = ? ORDER BY id",
    ).bind(r.roster_id).all<AuditRow>();

    expect(results.map((row) => row.event)).toEqual([
      "roster.create", "roster.join", "roster.leave", "roster.join", "roster.expel",
      "roster.rotate", "roster.evict_all", "roster.delete",
    ]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "roster.create", action_type: "C", actor: "audit-owner", actor_type: "handle",
        target_type: "roster", target_id: null, actor_ip: "192.0.2.10", actor_country: "JP",
      }),
      expect.objectContaining({
        event: "roster.join", action_type: "C", actor: "audit-member", actor_type: "handle",
        target_type: "handle", target_id: "audit-member", actor_ip: "192.0.2.11", actor_country: "CA",
      }),
      expect.objectContaining({
        event: "roster.leave", action_type: "D", actor: "audit-member", actor_type: "handle",
        target_type: "handle", target_id: "audit-member", actor_ip: "192.0.2.15", actor_country: "AU",
      }),
      expect.objectContaining({
        event: "roster.expel", action_type: "D", actor: "audit-owner", actor_type: "admin_secret",
        target_type: "handle", target_id: "audit-member", actor_ip: "192.0.2.12", actor_country: "DE",
      }),
      expect.objectContaining({
        event: "roster.rotate", action_type: "U", actor_type: "admin_secret",
        target_type: "join_key", actor_ip: "192.0.2.13", actor_country: "FR",
      }),
      expect.objectContaining({
        event: "roster.evict_all", action_type: "D", actor_type: "admin_secret",
        target_type: "roster", actor_ip: "192.0.2.13", actor_country: "FR",
      }),
      expect.objectContaining({
        event: "roster.delete", action_type: "D", actor_type: "admin_secret",
        target_type: "roster", actor_ip: "192.0.2.14", actor_country: "GB",
      }),
    ]));
    expect(results.every((row) => row.description.length > 0)).toBe(true);
    expect(results.every((row) => row.org === "acme" && Number.isInteger(row.at))).toBe(true);
  });
});
