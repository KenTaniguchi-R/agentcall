import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_ACTIVE_ORG_INVITES } from "@benree/agentcall-shared";
import { registerHandle, wsAuth } from "./helpers.js";

async function create(org: string, handle: string, token: string, body: unknown = {}) {
  return SELF.fetch("https://relay.test/v1/invites", {
    method: "POST",
    headers: { ...wsAuth(handle, token, org), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("organization invite lifecycle", () => {
  it("creates, lists, revokes, and audits an invite without returning its secret again", async () => {
    const token = await registerHandle("inviter", "claude", "tenant-a");
    const issued = await create("tenant-a", "inviter", token, {
      description: "contractor onboarding", expires_in_days: 30,
    });
    expect(issued.status).toBe(200);
    const created = await issued.json<{
      invite: string; metadata: { id: string; expires_at: number; role: string };
    }>();
    expect(created.invite).toHaveLength(43);
    expect(created.metadata.id).toMatch(/^[a-f0-9]{64}$/);
    expect(created.metadata.role).toBe("member");

    const listed = await SELF.fetch("https://relay.test/v1/invites/list", {
      method: "POST", headers: wsAuth("inviter", token, "tenant-a"),
    });
    const inventory = await listed.json();
    expect(inventory).toMatchObject({ invites: expect.arrayContaining([expect.objectContaining({
      id: created.metadata.id, description: "contractor onboarding", created_by: "inviter",
      used_at: null, used_by: null, revoked_at: null,
    })]) });
    expect(JSON.stringify(inventory)).not.toContain(created.invite);

    const revoked = await SELF.fetch(`https://relay.test/v1/invites/${created.metadata.id}/revoke`, {
      method: "POST", headers: wsAuth("inviter", token, "tenant-a"),
    });
    expect(revoked.status).toBe(200);
    const receipt = await revoked.json<{ revoked_at: number }>();
    expect(receipt).toMatchObject({ id: created.metadata.id, revoked_at: expect.any(Number) });

    const retry = await SELF.fetch(`https://relay.test/v1/invites/${created.metadata.id}/revoke`, {
      method: "POST", headers: wsAuth("inviter", token, "tenant-a"),
    });
    expect(await retry.json()).toEqual({ id: created.metadata.id, revoked_at: receipt.revoked_at });

    const events = await env.DB.prepare(
      "SELECT event, actor, actor_type, target_type, target_id, target_role FROM org_events " +
        "WHERE org = ? AND target_id = ? ORDER BY id",
    ).bind("tenant-a", created.metadata.id).all();
    expect(events.results).toEqual([
      { event: "org.invite.issue", actor: "inviter", actor_type: "handle", target_type: "invite", target_id: created.metadata.id, target_role: "member" },
      { event: "org.invite.revoke", actor: "inviter", actor_type: "handle", target_type: "invite", target_id: created.metadata.id, target_role: "member" },
    ]);
  });

  it("rejects revoked invites and atomically audits a successful redemption", async () => {
    const token = await registerHandle("issuer", "claude", "redemption-org");
    const first = await (await create("redemption-org", "issuer", token)).json<{
      invite: string; metadata: { id: string };
    }>();
    await SELF.fetch(`https://relay.test/v1/invites/${first.metadata.id}/revoke`, {
      method: "POST", headers: wsAuth("issuer", token, "redemption-org"),
    });
    expect((await SELF.fetch("https://relay.test/v1/register", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.211" },
      body: JSON.stringify({ invite: first.invite, handle: "blocked" }),
    })).status).toBe(404);

    const second = await (await create("redemption-org", "issuer", token)).json<{
      invite: string; metadata: { id: string };
    }>();
    expect((await SELF.fetch("https://relay.test/v1/register", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.212" },
      body: JSON.stringify({ invite: second.invite, handle: "new-member" }),
    })).status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT org_role FROM handles WHERE org = ? AND handle = ?",
    ).bind("redemption-org", "new-member").first()).toEqual({ org_role: "member" });
    expect(await env.DB.prepare(
      "SELECT event, actor, actor_type, target_type, target_id, target_role FROM org_events " +
        "WHERE event = 'org.invite.redeem' AND target_id = ?",
    ).bind("new-member").first()).toEqual({
      event: "org.invite.redeem", actor: second.metadata.id, actor_type: "invite",
      target_type: "handle", target_id: "new-member", target_role: "member",
    });
  });

  it("isolates inventory and revocation by tenant", async () => {
    const acmeToken = await registerHandle("same", "claude", "acme-invites");
    const betaToken = await registerHandle("same", "claude", "beta-invites");
    const issued = await (await create("acme-invites", "same", acmeToken)).json<{ metadata: { id: string } }>();

    const betaList = await SELF.fetch("https://relay.test/v1/invites/list", {
      method: "POST", headers: wsAuth("same", betaToken, "beta-invites"),
    });
    const betaInventory = await betaList.json<{ invites: Array<{ id: string }> }>();
    expect(betaInventory.invites.every((invite) => invite.id !== issued.metadata.id)).toBe(true);
    expect((await SELF.fetch(`https://relay.test/v1/invites/${issued.metadata.id}/revoke`, {
      method: "POST", headers: wsAuth("same", betaToken, "beta-invites"),
    })).status).toBe(404);
  });

  it("caps active invites and removes terminal rows after the retention window on write", async () => {
    const token = await registerHandle("bounded", "claude", "bounded-org");
    const now = Date.now();
    const statements = Array.from({ length: MAX_ACTIVE_ORG_INVITES }, (_, i) => env.DB.prepare(
      "INSERT INTO invites (token_hash, org, created_by, created_at, expires_at, description) VALUES (?, ?, ?, ?, ?, '')",
    ).bind(i.toString(16).padStart(64, "0"), "bounded-org", "bounded", now, now + 60_000));
    await env.DB.batch(statements);
    expect((await create("bounded-org", "bounded", token)).status).toBe(409);

    await env.DB.prepare(
      "UPDATE invites SET used_at = ?, used_by = 'old-user' WHERE org = ? AND token_hash = ?",
    ).bind(now - 31 * 86_400_000, "bounded-org", "0".repeat(64)).run();
    expect((await create("bounded-org", "bounded", token)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM invites WHERE token_hash = ?")
      .bind("0".repeat(64)).first()).toBeNull();
  });

  it("always lists active authority before newer terminal history", async () => {
    const token = await registerHandle("inventory", "claude", "inventory-org");
    const now = Date.now();
    const activeId = "f".repeat(64);
    await env.DB.prepare(
      "INSERT INTO invites " +
        "(token_hash, org, created_by, created_at, expires_at, description) VALUES (?, ?, ?, 0, ?, '')",
    ).bind(activeId, "inventory-org", "inventory", now + 60_000).run();
    await env.DB.prepare(
      "WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM seq WHERE x < 210) " +
        "INSERT INTO invites " +
        "(token_hash, org, created_by, created_at, expires_at, used_at, used_by, description) " +
        "SELECT printf('%064x', 1000000 + x), 'inventory-org', 'inventory', ?, ?, ?, 'past-member', '' FROM seq",
    ).bind(now, now + 60_000, now).run();

    const res = await SELF.fetch("https://relay.test/v1/invites/list", {
      method: "POST", headers: wsAuth("inventory", token, "inventory-org"),
    });
    const inventory = await res.json<{ invites: Array<{ id: string }> }>();
    expect(inventory.invites).toHaveLength(200);
    expect(inventory.invites[0]?.id).toBe(activeId);
  });

  it("retains a hard rolling maximum of 10,000 organization audit events", async () => {
    const token = await registerHandle("auditor", "claude", "audit-org");
    await env.DB.prepare("DELETE FROM org_events WHERE org = ?").bind("audit-org").run();
    await env.DB.prepare(
      "WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) " +
        "INSERT INTO org_events " +
        "(event, action_type, org, actor, actor_type, target_type, target_id, description, at) " +
        "SELECT 'org.invite.issue', 'C', 'audit-org', 'auditor', 'handle', 'invite', " +
        "printf('%064x', a.d * 1000 + b.d * 100 + c.d * 10 + d.d), 'seed', 1 " +
        "FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d",
    ).run();

    const issued = await create("audit-org", "auditor", token);
    expect(issued.status).toBe(200);
    const metadata = (await issued.json<{ metadata: { id: string } }>()).metadata;
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM org_events WHERE org = ?")
      .bind("audit-org").first()).toEqual({ n: 10_000 });
    expect(await env.DB.prepare("SELECT 1 AS found FROM org_events WHERE org = ? AND target_id = ?")
      .bind("audit-org", metadata.id).first()).toEqual({ found: 1 });
  });

  it("rejects anonymous lifecycle operations and malformed public ids", async () => {
    expect((await SELF.fetch("https://relay.test/v1/invites/list", { method: "POST" })).status).toBe(401);
    const token = await registerHandle("shape", "claude", "shape-org");
    expect((await SELF.fetch("https://relay.test/v1/invites/not-a-hash/revoke", {
      method: "POST", headers: wsAuth("shape", token, "shape-org"),
    })).status).toBe(400);
  });

  it("requires an administrator for organization-wide invite authority", async () => {
    const adminToken = await registerHandle("role-admin", "claude", "role-org", "admin");
    const invite = await (await create("role-org", "role-admin", adminToken)).json<{ metadata: { id: string } }>();
    const memberToken = await registerHandle("ordinary-member", "claude", "role-org", "member");
    expect((await create("role-org", "ordinary-member", memberToken)).status).toBe(403);
    expect((await SELF.fetch("https://relay.test/v1/invites/list", {
      method: "POST", headers: wsAuth("ordinary-member", memberToken, "role-org"),
    })).status).toBe(403);
    expect((await SELF.fetch(`https://relay.test/v1/invites/${invite.metadata.id}/revoke`, {
      method: "POST", headers: wsAuth("ordinary-member", memberToken, "role-org"),
    })).status).toBe(403);
  });

  it("delegates admin authority explicitly through an invite", async () => {
    const issuerToken = await registerHandle("delegating-admin", "claude", "delegation-org", "admin");
    const issued = await (await create("delegation-org", "delegating-admin", issuerToken, { role: "admin" }))
      .json<{ invite: string }>();
    const registered = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.220" },
      body: JSON.stringify({ invite: issued.invite, handle: "delegated-admin" }),
    });
    const delegatedToken = (await registered.json<{ token: string }>()).token;
    expect(registered.status).toBe(200);
    expect((await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: wsAuth("delegated-admin", delegatedToken, "delegation-org"),
    })).status).toBe(200);
  });

  it("always enrolls the operator-bootstrap invite as an administrator", async () => {
    const issued = await SELF.fetch("https://relay.test/v1/admin/invite", {
      method: "POST",
      headers: { Authorization: "Bearer test-bootstrap-token", "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.221" },
      body: JSON.stringify({ org: "bootstrap-role-org", role: "member" }),
    });
    expect(issued.status).toBe(200);
    const invite = (await issued.json<{ invite: string }>()).invite;
    const registered = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.222" },
      body: JSON.stringify({ invite, handle: "bootstrap-admin" }),
    });
    const token = (await registered.json<{ token: string }>()).token;
    expect(registered.status).toBe(200);
    expect((await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: wsAuth("bootstrap-admin", token, "bootstrap-role-org"),
    })).status).toBe(200);
  });
});
