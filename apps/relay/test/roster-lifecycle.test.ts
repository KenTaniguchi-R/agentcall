import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { MAX_ROSTER_AUDIT_EVENTS } from "../src/events.js";
import { registerHandle, wsAuth } from "./helpers.js";

async function create(handle: string, ip = handle, country = "US") {
  const token = await registerHandle(handle);
  const res = await SELF.fetch(new Request("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": ip, ...wsAuth(handle, token) },
    cf: { country },
  }));
  return { token, ...(await res.json<{ roster_id: string; join_key: string; admin_secret: string }>()) };
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

async function join(id: string, handle: string, token: string, join_key: string) {
  return mutate(id, "join", handle, token, { join_key });
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
      ["join", { join_key: "wrong" }],
      ["expel", {}],
      ["keys/list", {}],
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

  it("requires the separate admin secret to expel and allows rejoin with an unchanged reusable key", async () => {
    const r = await create("expel1");
    const memberToken = await registerHandle("expel2");
    expect((await join(r.roster_id, "expel2", memberToken, r.join_key)).status).toBe(200);
    const denied = await mutate(r.roster_id, "expel", "expel1", r.token, { admin_secret: r.join_key, handle: "expel2" });
    const missing = await mutate("A".repeat(22), "expel", "expel1", r.token, { admin_secret: r.join_key, handle: "expel2" });
    expect(Object.fromEntries(denied.headers)).toEqual(Object.fromEntries(missing.headers));
    expect([denied.status, await denied.text()]).toEqual([missing.status, await missing.text()]);
    expect((await mutate(r.roster_id, "expel", "expel1", r.token, {
      admin_secret: r.admin_secret, handle: "expel2",
    })).status).toBe(200);
    expect(await isMember(r.roster_id, "expel2")).toBe(false);
    expect((await join(r.roster_id, "expel2", memberToken, r.join_key)).status).toBe(200);
  });

  it("makes non-membership indistinguishable from an unknown roster", async () => {
    const r = await create("hidden1");
    const token = await registerHandle("hidden2");
    const nonmember = await mutate(r.roster_id, "leave", "hidden2", token, {});
    const missing = await mutate("B".repeat(22), "leave", "hidden2", token, {});
    expect(Object.fromEntries(nonmember.headers)).toEqual(Object.fromEntries(missing.headers));
    expect([nonmember.status, await nonmember.text()]).toEqual([missing.status, await missing.text()]);
  });

  it("issues one-off keys and lists only stable metadata", async () => {
    const r = await create("key-owner");
    const issued = await mutate(r.roster_id, "keys", "key-owner", r.token, {
      admin_secret: r.admin_secret, description: "contractor",
    });
    expect(issued.status).toBe(200);
    const out = await issued.json<{ join_key: string; key: { prefix: string; reusable: boolean } }>();
    expect(out.join_key).toMatch(new RegExp(`^agjk_${out.key.prefix}_`));
    expect(out.key.reusable).toBe(false);

    const listed = await mutate(r.roster_id, "keys/list", "key-owner", r.token, {
      admin_secret: r.admin_secret,
    });
    const body = await listed.json<{ keys: Record<string, unknown>[] }>();
    expect(body.keys).toHaveLength(2);
    expect(body.keys.find((key) => key.prefix === out.key.prefix)).toMatchObject({
      description: "contractor", created_by: "key-owner",
    });
    expect(body.keys.every((key) => !("join_key" in key) && !("secret_hash" in key))).toBe(true);

    const [tokenA, tokenB] = await Promise.all([registerHandle("key-a"), registerHandle("key-b")]);
    const [a, b] = await Promise.all([
      join(r.roster_id, "key-a", tokenA, out.join_key),
      join(r.roster_id, "key-b", tokenB, out.join_key),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await env.DB.prepare(
      "SELECT used FROM roster_join_keys WHERE prefix = ?",
    ).bind(out.key.prefix).first()).toEqual({ used: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_members WHERE roster_id = ? AND joined_via_prefix = ?",
    ).bind(r.roster_id, out.key.prefix).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_events WHERE roster_id = ? AND event = 'roster.join' " +
        "AND target_id IN ('key-a', 'key-b')",
    ).bind(r.roster_id).first()).toEqual({ n: 1 });
  });

  it("expires credentials at their absolute deadline", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const r = await create("expiry-owner");
      const issued = await mutate(r.roster_id, "keys", "expiry-owner", r.token, {
        admin_secret: r.admin_secret, expires_in_days: 1,
      });
      const { join_key } = await issued.json<{ join_key: string }>();
      clock.mockReturnValue(1_000_000 + 86_400_000);
      const token = await registerHandle("expiry-member");
      expect((await join(r.roster_id, "expiry-member", token, join_key)).status).toBe(404);
    } finally {
      clock.mockRestore();
    }
  });

  it("revokes without eviction by default and can evict only members admitted by that key", async () => {
    const r = await create("evict-owner");
    const issued = await mutate(r.roster_id, "keys", "evict-owner", r.token, {
      admin_secret: r.admin_secret, reusable: true,
    });
    const { join_key, key } = await issued.json<{ join_key: string; key: { prefix: string } }>();
    const [targetToken, retainedToken, lateToken] = await Promise.all([
      registerHandle("evict-target"), registerHandle("evict-retained"), registerHandle("evict-late"),
    ]);
    expect((await join(r.roster_id, "evict-target", targetToken, join_key)).status).toBe(200);
    expect((await join(r.roster_id, "evict-retained", retainedToken, r.join_key)).status).toBe(200);

    const revoked = await mutate(r.roster_id, `keys/${key.prefix}/revoke`, "evict-owner", r.token, {
      admin_secret: r.admin_secret,
    });
    expect(await revoked.json()).toMatchObject({ prefix: key.prefix, evicted: 0 });
    expect(await isMember(r.roster_id, "evict-target")).toBe(true);
    expect((await join(r.roster_id, "evict-late", lateToken, join_key)).status).toBe(404);

    const evicted = await mutate(r.roster_id, `keys/${key.prefix}/revoke`, "evict-owner", r.token, {
      admin_secret: r.admin_secret, evict: true,
    });
    expect(await evicted.json()).toMatchObject({ prefix: key.prefix, evicted: 1 });
    expect(await isMember(r.roster_id, "evict-target")).toBe(false);
    expect(await isMember(r.roster_id, "evict-retained")).toBe(true);
    expect(await isMember(r.roster_id, "evict-owner")).toBe(true);
  });

  it("persistently bounds membership audit events and records exhaustion once", async () => {
    const r = await create("budget-owner");
    const memberToken = await registerHandle("budget-member");
    const waitingToken = await registerHandle("budget-waiting");
    expect((await join(r.roster_id, "budget-member", memberToken, r.join_key)).status).toBe(200);
    await env.DB.prepare("UPDATE rosters SET audit_budget_used = ? WHERE id = ?")
      .bind(MAX_ROSTER_AUDIT_EVENTS, r.roster_id).run();

    expect((await join(r.roster_id, "budget-member", memberToken, r.join_key)).status).toBe(200);
    expect((await join(r.roster_id, "budget-waiting", waitingToken, r.join_key)).status).toBe(409);
    expect((await join(r.roster_id, "budget-waiting", waitingToken, r.join_key)).status).toBe(409);
    expect((await mutate(r.roster_id, "leave", "budget-owner", r.token, {})).status).toBe(200);
    expect(await isMember(r.roster_id, "budget-owner")).toBe(false);
    expect(await isMember(r.roster_id, "budget-waiting")).toBe(false);

    const exhausted = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_events " +
        "WHERE roster_id = ? AND event = 'roster.audit_budget_exhausted'",
    ).bind(r.roster_id).first<{ n: number }>();
    expect(exhausted?.n).toBe(1);

    expect((await mutate(r.roster_id, "expel", "budget-owner", r.token, {
      admin_secret: r.admin_secret, handle: "budget-member",
    })).status).toBe(200);
    expect((await mutate(r.roster_id, "keys", "budget-owner", r.token, {
      admin_secret: r.admin_secret,
    })).status).toBe(200);
    expect((await mutate(r.roster_id, "delete", "budget-owner", r.token, {
      admin_secret: r.admin_secret,
    })).status).toBe(200);
  });

  it("lets an administrator auditably reset an exhausted membership audit budget", async () => {
    const r = await create("reset-owner");
    const waitingToken = await registerHandle("reset-waiting");
    await env.DB.prepare("UPDATE rosters SET audit_budget_used = ? WHERE id = ?")
      .bind(MAX_ROSTER_AUDIT_EVENTS, r.roster_id).run();

    const blocked = await join(r.roster_id, "reset-waiting", waitingToken, r.join_key);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: "roster event budget exhausted",
      recovery: "ask a roster administrator to reset the audit budget",
    });

    const denied = await mutate(r.roster_id, "audit-budget/reset", "reset-owner", r.token, {
      admin_secret: r.join_key,
    });
    const missing = await mutate("C".repeat(22), "audit-budget/reset", "reset-owner", r.token, {
      admin_secret: r.join_key,
    });
    expect(Object.fromEntries(denied.headers)).toEqual(Object.fromEntries(missing.headers));
    expect([denied.status, await denied.text()]).toEqual([missing.status, await missing.text()]);

    const reset = await mutate(r.roster_id, "audit-budget/reset", "reset-owner", r.token, {
      admin_secret: r.admin_secret,
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true, reset: true, audit_budget_used: 0 });
    expect((await join(r.roster_id, "reset-waiting", waitingToken, r.join_key)).status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT audit_budget_used, audit_budget_exhausted_at FROM rosters WHERE id = ?",
    ).bind(r.roster_id).first()).toEqual({ audit_budget_used: 1, audit_budget_exhausted_at: null });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_events WHERE roster_id = ? AND event = 'roster.audit_budget_reset'",
    ).bind(r.roster_id).first()).toEqual({ n: 1 });

    const noOp = await mutate(r.roster_id, "audit-budget/reset", "reset-owner", r.token, {
      admin_secret: r.admin_secret,
    });
    expect(await noOp.json()).toEqual({ ok: true, reset: false, audit_budget_used: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_events WHERE roster_id = ? AND event = 'roster.audit_budget_reset'",
    ).bind(r.roster_id).first()).toEqual({ n: 1 });
  });

  it("deletes live state but retains append-only audit events", async () => {
    const r = await create("delete1");
    expect((await mutate(r.roster_id, "delete", "delete1", r.token, { admin_secret: r.admin_secret })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM rosters WHERE id = ?").bind(r.roster_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM roster_members WHERE roster_id = ?").bind(r.roster_id).first()).toBeNull();
    const events = await env.DB.prepare("SELECT event FROM roster_events WHERE roster_id = ? ORDER BY id").bind(r.roster_id).all<{ event: string }>();
    expect(events.results.map((event) => event.event)).toEqual([
      "roster.create", "roster.join_key.issue", "roster.delete",
    ]);
  });

  it("records complete, namespaced audit evidence for every mutation", async () => {
    const r = await create("audit-owner", "192.0.2.10", "JP");
    const memberToken = await registerHandle("audit-member");
    expect((await mutate(
      r.roster_id, "join", "audit-member", memberToken, { join_key: r.join_key }, "192.0.2.11", "CA",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "leave", "audit-member", memberToken, {}, "192.0.2.15", "AU",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "join", "audit-member", memberToken, { join_key: r.join_key }, "192.0.2.16", "NZ",
    )).status).toBe(200);
    expect((await mutate(
      r.roster_id, "expel", "audit-owner", r.token,
      { admin_secret: r.admin_secret, handle: "audit-member" }, "192.0.2.12", "DE",
    )).status).toBe(200);
    const keyResponse = await mutate(
      r.roster_id, "keys", "audit-owner", r.token,
      { admin_secret: r.admin_secret, reusable: true }, "192.0.2.13", "FR",
    );
    const issued = await keyResponse.json<{ join_key: string; key: { prefix: string } }>();
    const keyedMemberToken = await registerHandle("audit-key-member");
    expect((await join(r.roster_id, "audit-key-member", keyedMemberToken, issued.join_key)).status).toBe(200);
    expect((await mutate(
      r.roster_id, `keys/${issued.key.prefix}/revoke`, "audit-owner", r.token,
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
      "roster.create", "roster.join_key.issue", "roster.join", "roster.leave", "roster.join", "roster.expel",
      "roster.join_key.issue", "roster.join", "roster.join_key.revoke", "roster.join_key.evict", "roster.delete",
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
        event: "roster.join_key.issue", action_type: "C", actor_type: "admin_secret",
        target_type: "join_key", actor_ip: "192.0.2.13", actor_country: "FR",
      }),
      expect.objectContaining({
        event: "roster.join_key.revoke", action_type: "U", actor_type: "admin_secret",
        target_type: "join_key", actor_ip: "192.0.2.13", actor_country: "FR",
      }),
      expect.objectContaining({
        event: "roster.join_key.evict", action_type: "D", actor_type: "admin_secret",
        target_type: "join_key", actor_ip: "192.0.2.13", actor_country: "FR",
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
