import type { Context, Hono } from "hono";
import {
  BootstrapOrgInviteRequest, CreateOrgInviteRequest, MAX_ACTIVE_ORG_INVITES,
  MAX_LISTED_ORG_INVITES, ORG_INVITE_ID_RE, type OrgInviteMetadataType, type OrgRoleType,
} from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { constantTimeEqual, generateToken, sha256Hex } from "./auth.js";
import { orgAuditStatement, orgAuditTrimStatement, type OrgAuditActor } from "./events.js";
import { checkLimit, REGISTER, ROSTER_WRITE } from "./ratelimit/index.js";
import { authenticateRequest, requireOrgAdmin } from "./tenant.js";

const INVITE_RETENTION_MS = 30 * 86_400_000;

type InviteRow = {
  token_hash: string;
  description: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
  revoked_at: number | null;
  org_role: OrgRoleType;
};

function publicInvite(row: InviteRow): OrgInviteMetadataType {
  return {
    id: row.token_hash,
    description: row.description,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
    used_by: row.used_by,
    revoked_at: row.revoked_at,
    role: row.org_role,
  };
}

export function expiredInviteCleanupStatement(
  db: D1Database, org: string, now: number,
): D1PreparedStatement {
  const cutoff = now - INVITE_RETENTION_MS;
  return db.prepare(
    "DELETE FROM invites WHERE org = ? AND (" +
      "CASE WHEN used_at IS NOT NULL THEN used_at " +
      "WHEN revoked_at IS NOT NULL THEN revoked_at ELSE expires_at END) < ?",
  ).bind(org, cutoff);
}

async function createInvite(
  c: Context<{ Bindings: Env }>, org: string, createdBy: string | null,
  actor: string, actorType: OrgAuditActor, description: string, expiresInDays: number,
  role: OrgRoleType,
) {
  const invite = generateToken();
  const id = await sha256Hex(invite);
  const now = Date.now();
  const expiresAt = now + expiresInDays * 86_400_000;
  const results = await c.env.DB.batch([
    expiredInviteCleanupStatement(c.env.DB, org, now),
    c.env.DB.prepare(
      "INSERT INTO invites " +
        "(token_hash, org, created_by, created_at, expires_at, description, org_role) " +
        "SELECT ?, ?, ?, ?, ?, ?, ? WHERE (" +
        "SELECT COUNT(*) FROM invites WHERE org = ? AND used_at IS NULL " +
        "AND revoked_at IS NULL AND expires_at > ?) < ?",
    ).bind(id, org, createdBy, now, expiresAt, description, role, org, now, MAX_ACTIVE_ORG_INVITES),
    orgAuditStatement(c, {
      event: "org.invite.issue", action: "C", org, actor, actorType,
      targetType: "invite", targetId: id,
      targetRole: role,
      description: `${actor} issued ${role} organization invite ${id}`, at: now,
    }, "previous-change"),
    orgAuditTrimStatement(c.env.DB, org),
  ]);
  if ((results[1].meta.changes ?? 0) !== 1) return c.json({ error: "active invite limit reached" }, 409);
  return c.json({ invite, metadata: publicInvite({
    token_hash: id, description, created_by: createdBy, created_at: now,
    expires_at: expiresAt, used_at: null, used_by: null, revoked_at: null, org_role: role,
  }) });
}

export function mountInvites(app: Hono<{ Bindings: Env }>): void {
  app.post("/v1/admin/invite", async (c) => {
    const configured = c.env.BOOTSTRAP_TOKEN;
    if (!configured) return c.notFound();
    const supplied = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const [expectedHash, suppliedHash] = await Promise.all([sha256Hex(configured), sha256Hex(supplied)]);
    if (!constantTimeEqual(expectedHash, suppliedHash)) return c.json({ error: "unauthorized" }, 401);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await checkLimit(c.env, `bootstrap:${ip}`, REGISTER))) return c.json({ error: "rate limited" }, 429);
    const body = BootstrapOrgInviteRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    return createInvite(
      c, body.data.org, null, "relay-operator", "bootstrap",
      body.data.description, body.data.expires_in_days, "admin",
    );
  });

  app.post("/v1/invites", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (!requireOrgAdmin(identity)) return c.json({ error: "administrator role required" }, 403);
    if (!(await checkLimit(c.env, `invite:${identity.org}:${identity.handle}`, REGISTER))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const body = CreateOrgInviteRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    return createInvite(
      c, identity.org, identity.handle, identity.handle, "handle",
      body.data.description, body.data.expires_in_days, body.data.role,
    );
  });

  app.post("/v1/invites/list", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (!requireOrgAdmin(identity)) return c.json({ error: "administrator role required" }, 403);
    if (!(await checkLimit(c.env, `invite-list:${identity.org}:${identity.handle}`, ROSTER_WRITE))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const { results } = await c.env.DB.prepare(
      "SELECT token_hash, description, created_by, created_at, expires_at, used_at, used_by, revoked_at, org_role " +
        "FROM invites WHERE org = ? ORDER BY " +
        "CASE WHEN used_at IS NULL AND revoked_at IS NULL AND expires_at > ? THEN 0 ELSE 1 END, " +
        "created_at DESC, token_hash DESC LIMIT ?",
    ).bind(identity.org, Date.now(), MAX_LISTED_ORG_INVITES).all<InviteRow>();
    return c.json({ invites: (results ?? []).map(publicInvite) });
  });

  app.post("/v1/invites/:id/revoke", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (!requireOrgAdmin(identity)) return c.json({ error: "administrator role required" }, 403);
    const id = c.req.param("id");
    if (!ORG_INVITE_ID_RE.test(id)) return c.json({ error: "invalid invite id" }, 400);
    if (!(await checkLimit(c.env, `invite-revoke:${identity.org}:${identity.handle}`, ROSTER_WRITE))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const existing = await c.env.DB.prepare(
      "SELECT revoked_at, org_role FROM invites WHERE token_hash = ? AND org = ?",
    ).bind(id, identity.org).first<{ revoked_at: number | null; org_role: OrgRoleType }>();
    if (!existing) return c.json({ error: "not found" }, 404);
    if (existing.revoked_at !== null) return c.json({ id, revoked_at: existing.revoked_at });

    const now = Date.now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE invites SET revoked_at = ? WHERE token_hash = ? AND org = ? " +
          "AND revoked_at IS NULL AND used_at IS NULL",
      ).bind(now, id, identity.org),
      orgAuditStatement(c, {
        event: "org.invite.revoke", action: "U", org: identity.org,
        actor: identity.handle, actorType: "handle", targetType: "invite", targetId: id,
        targetRole: existing.org_role,
        description: `${identity.handle} revoked organization invite ${id}`, at: now,
      }, "previous-change"),
      orgAuditTrimStatement(c.env.DB, identity.org),
      expiredInviteCleanupStatement(c.env.DB, identity.org, now),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      const raced = await c.env.DB.prepare(
        "SELECT revoked_at FROM invites WHERE token_hash = ? AND org = ?",
      ).bind(id, identity.org).first<{ revoked_at: number | null }>();
      if (raced?.revoked_at !== null && raced?.revoked_at !== undefined) {
        return c.json({ id, revoked_at: raced.revoked_at });
      }
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ id, revoked_at: now });
  });
}
