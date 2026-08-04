import type { Context, Hono } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "./index.js";
import { constantTimeEqual, generateToken, sha256Hex } from "./auth.js";
import {
  AdminSecretRequest, DEFAULT_ROSTER_JOIN_KEY_EXPIRY_DAYS, ExpelRosterRequest,
  IssueRosterJoinKeyRequest, JoinRosterRequest, MAX_ACTIVE_ROSTER_JOIN_KEYS,
  MAX_BUNDLE_TASKS_PER_CARD, MAX_CALLER_GROUPS, MAX_LISTED_ROSTER_JOIN_KEYS, MAX_ROSTER_MEMBERS,
  RevokeRosterJoinKeyRequest, ROSTER_ID_RE, visibleTasks,
} from "@benree/agentcall-shared";
import { authenticateRequest } from "./tenant.js";
import { checkLimit, NATIVE_ROSTER_READ, REGISTER, ROSTER_WRITE } from "./ratelimit/index.js";
import { parseStoredCard } from "./stored-card.js";
import { MAX_ROSTER_AUDIT_EVENTS, rosterAuditStatement } from "./events.js";

// 16 random bytes, base64url — 22 chars, inside ROSTER_ID_RE's 16..64 window.
// Unguessable but not secret: it travels in URL paths and will be logged.
function generateRosterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function generateJoinKey(): { joinKey: string; prefix: string; secret: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const prefix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const secret = generateToken();
  return { joinKey: `agjk_${prefix}_${secret}`, prefix, secret };
}

function joinKeyParts(joinKey: string): { prefix: string; secret: string } {
  return { prefix: joinKey.slice(5, 17), secret: joinKey.slice(18) };
}

type JoinKeyRow = {
  prefix: string;
  description: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  reusable: number;
  used: number;
  revoked_at: number | null;
};

function publicJoinKey(row: JoinKeyRow) {
  return {
    prefix: row.prefix,
    description: row.description,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    reusable: row.reusable === 1,
    used: row.used === 1,
    revoked_at: row.revoked_at,
  };
}

export function mountRoster(app: Hono<{ Bindings: Env }>): void {
  app.post("/v1/roster", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle } = identity;
    // Creating rosters uses the tighter registration policy so it cannot be
    // used to cheaply fill D1 with rows.
    if (!(await checkLimit(c.env, `roster:${org}:${handle}`, REGISTER))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const roster_id = generateRosterId();
    const { joinKey, prefix, secret } = generateJoinKey();
    const admin_secret = generateToken();
    const now = Date.now();
    const expiresAt = now + DEFAULT_ROSTER_JOIN_KEY_EXPIRY_DAYS * 86_400_000;
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO rosters (id, org, admin_secret_hash, created_at, audit_budget_used) VALUES (?, ?, ?, ?, 1)",
      ).bind(roster_id, org, await sha256Hex(admin_secret), now),
      c.env.DB.prepare(
        "INSERT INTO roster_join_keys " +
          "(prefix, roster_id, org, secret_hash, description, created_by, created_at, expires_at, reusable) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      ).bind(prefix, roster_id, org, await sha256Hex(secret), "initial", handle, now, expiresAt),
      c.env.DB.prepare(
        "INSERT INTO roster_members (roster_id, org, handle, joined_at, joined_via_prefix) VALUES (?, ?, ?, ?, NULL)",
      ).bind(roster_id, org, handle, now),
      rosterAuditStatement(c, {
        event: "roster.create", action: "C", rosterId: roster_id, org, actor: handle, actorType: "handle",
        targetType: "roster", targetId: null, description: `${handle} created roster ${roster_id}`, at: now,
      }, "previous-change"),
      rosterAuditStatement(c, {
        event: "roster.join_key.issue", action: "C", rosterId: roster_id, org,
        actor: handle, actorType: "handle", targetType: "join_key", targetId: prefix,
        description: `${handle} issued initial join key ${prefix} for roster ${roster_id}`, at: now,
      }, "roster-exists"),
    ]);
    // Both credentials are returned exactly once and only their digests persist.
    return c.json({ roster_id, join_key: joinKey, admin_secret });
  });

  // One shared body for "unknown roster" and "wrong secret". They MUST be
  // byte-identical: a distinct response for either one turns roster ids into
  // an enumerable namespace. Declared once so the two call sites cannot drift.
  const NOT_FOUND = { error: "not found" } as const;

  app.post("/v1/roster/:id/join", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle } = identity;

    const id = c.req.param("id");
    // Shape-check before touching D1: a malformed id can never match a row,
    // and rejecting it here keeps junk out of the query path.
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

    if (!(await checkLimit(c.env, `${org}:${id}`, ROSTER_WRITE))) {
      return c.json({ error: "rate limited" }, 429);
    }

    const body = JoinRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);

    const { prefix, secret } = joinKeyParts(body.data.join_key);
    const supplied = await sha256Hex(secret);
    // Authorization and capacity are evaluated by SQLite at INSERT time, not
    // by Worker reads that concurrent joins or a key revocation can straddle.
    // Comparing secret_hash in SQL is deliberately acceptable here: both
    // operands are fixed-length SHA-256 digests of an unguessable 32-byte
    // token, so SQLite's byte-wise early exit reveals no usable secret prefix.
    const now = Date.now();
    const [inserted] = await c.env.DB.batch([
      c.env.DB.prepare(
      "INSERT OR IGNORE INTO roster_members (roster_id, org, handle, joined_at, joined_via_prefix) " +
        "SELECT r.id, r.org, ?, ?, k.prefix FROM rosters r " +
        "JOIN roster_join_keys k ON k.roster_id = r.id AND k.org = r.org " +
        "WHERE r.id = ? AND r.org = ? AND k.prefix = ? AND k.secret_hash = ? " +
        "AND k.revoked_at IS NULL AND k.expires_at > ? AND (k.reusable = 1 OR k.used = 0) " +
        "AND r.audit_budget_used < ? " +
        "AND (SELECT COUNT(*) FROM roster_members WHERE roster_id = r.id) < ?",
      ).bind(handle, now, id, org, prefix, supplied, now, MAX_ROSTER_AUDIT_EVENTS, MAX_ROSTER_MEMBERS),
      c.env.DB.prepare(
        "UPDATE roster_join_keys SET used = CASE WHEN reusable = 0 THEN 1 ELSE used END " +
          "WHERE prefix = ? AND roster_id = ? AND org = ? AND changes() = 1",
      ).bind(prefix, id, org),
      c.env.DB.prepare(
        "UPDATE rosters SET audit_budget_used = audit_budget_used + 1 " +
          "WHERE id = ? AND org = ? AND changes() = 1",
      ).bind(id, org),
      rosterAuditStatement(c, {
        event: "roster.join", action: "C", rosterId: id, org, actor: handle, actorType: "handle",
        targetType: "handle", targetId: handle, description: `${handle} joined roster ${id}`, at: now,
      }, "previous-change"),
    ]);
    if ((inserted.meta.changes ?? 0) === 1) return c.json({ ok: true });

    // Zero changes has three meanings. This read chooses the response only;
    // it cannot authorize a write, so racing it cannot bypass the atomic gate.
    const state = await c.env.DB.prepare(
      "SELECT k.secret_hash, k.expires_at, k.revoked_at, k.reusable, k.used, r.audit_budget_used, " +
        "EXISTS(SELECT 1 FROM roster_members m " +
          "WHERE m.roster_id = r.id AND m.org = r.org AND m.handle = ?) AS member " +
        "FROM rosters r JOIN roster_join_keys k ON k.roster_id = r.id AND k.org = r.org " +
        "WHERE r.id = ? AND r.org = ? AND k.prefix = ?",
    ).bind(handle, id, org, prefix).first<{
      secret_hash: string; expires_at: number; revoked_at: number | null; reusable: number;
      used: number; audit_budget_used: number; member: number;
    }>();
    if (!state || !constantTimeEqual(state.secret_hash, supplied)) return c.json(NOT_FOUND, 404);
    if (state.revoked_at !== null || state.expires_at <= now) return c.json(NOT_FOUND, 404);
    if (state.member === 1) return c.json({ ok: true });
    if (state.reusable === 0 && state.used === 1) return c.json(NOT_FOUND, 404);
    if (state.audit_budget_used >= MAX_ROSTER_AUDIT_EVENTS) {
      await recordAuditBudgetExhaustion(c, id, org, handle, "handle");
      return c.json({
        error: "roster event budget exhausted",
        recovery: "ask a roster administrator to reset the audit budget",
      }, 409);
    }
    return c.json({ error: "roster full" }, 409);
  });

  async function recordAuditBudgetExhaustion(
    c: Context<{ Bindings: Env }>, id: string, org: string, actor: string,
    actorType: "handle" | "admin_secret",
  ) {
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE rosters SET audit_budget_exhausted_at = ? " +
          "WHERE id = ? AND org = ? AND audit_budget_exhausted_at IS NULL",
      ).bind(now, id, org),
      rosterAuditStatement(c, {
        event: "roster.audit_budget_exhausted", action: "U", rosterId: id, org, actor, actorType,
        targetType: "roster", targetId: null,
        description: `Roster ${id} exhausted its membership audit event budget`, at: now,
      }, "previous-change"),
    ]);
  }

  async function adminRoster(c: Context<{ Bindings: Env }>, id: string, supplied: string) {
    const row = await c.env.DB.prepare(
      "SELECT org, admin_secret_hash FROM rosters WHERE id = ?",
    ).bind(id).first<{ org: string; admin_secret_hash: string }>();
    const digest = await sha256Hex(supplied);
    // Always perform the fixed-length comparison, including for a missing
    // roster, so absence does not skip work that a wrong secret performs.
    const matches = constantTimeEqual(row?.admin_secret_hash ?? "0".repeat(64), digest);
    if (!row || !matches) return null;
    return row;
  }

  app.post("/v1/roster/:id/leave", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) return c.json({ error: "rate limited" }, 429);
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?",
    ).bind(id, identity.org, identity.handle).first();
    if (!member) return c.json(NOT_FOUND, 404);
    const now = Date.now();
    const [deleted] = await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?",
      ).bind(id, identity.org, identity.handle),
      rosterAuditStatement(c, {
        event: "roster.leave", action: "D", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "handle", targetType: "handle", targetId: identity.handle,
        description: `${identity.handle} left roster ${id}`, at: now,
      }, "previous-change"),
    ]);
    if ((deleted.meta.changes ?? 0) !== 1) return c.json(NOT_FOUND, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/roster/:id/audit-budget/reset", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const body = AdminSecretRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);

    const now = Date.now();
    const [updated] = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE rosters SET audit_budget_used = 0, audit_budget_exhausted_at = NULL " +
          "WHERE id = ? AND org = ? AND audit_budget_used >= ?",
      ).bind(id, identity.org, MAX_ROSTER_AUDIT_EVENTS),
      rosterAuditStatement(c, {
        event: "roster.audit_budget_reset", action: "U", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "admin_secret", targetType: "roster", targetId: null,
        description: `${identity.handle} reset the membership audit event budget for roster ${id}`,
        at: now,
      }, "previous-change"),
    ]);
    const reset = (updated.meta.changes ?? 0) === 1;
    const state = reset ? { audit_budget_used: 0 } : await c.env.DB.prepare(
      "SELECT audit_budget_used FROM rosters WHERE id = ? AND org = ?",
    ).bind(id, identity.org).first<{ audit_budget_used: number }>();
    return c.json({ ok: true, reset, audit_budget_used: state?.audit_budget_used ?? 0 });
  });

  app.post("/v1/roster/:id/expel", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) return c.json({ error: "rate limited" }, 429);
    const body = ExpelRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?",
    ).bind(id, identity.org, body.data.handle).first();
    if (!member) return c.json({ error: "member not found" }, 404);
    const now = Date.now();
    const [deleted] = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?")
        .bind(id, identity.org, body.data.handle),
      rosterAuditStatement(c, {
        event: "roster.expel", action: "D", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "admin_secret", targetType: "handle", targetId: body.data.handle,
        description: `${identity.handle} expelled ${body.data.handle} from roster ${id}`, at: now,
      }, "previous-change"),
    ]);
    if ((deleted.meta.changes ?? 0) !== 1) return c.json({ error: "member not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/roster/:id/keys", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) return c.json({ error: "rate limited" }, 429);
    const body = IssueRosterJoinKeyRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const { joinKey, prefix, secret } = generateJoinKey();
    const now = Date.now();
    const expiresAt = now + body.data.expires_in_days * 86_400_000;
    const [inserted] = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO roster_join_keys " +
          "(prefix, roster_id, org, secret_hash, description, created_by, created_at, expires_at, reusable) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " +
          "EXISTS (SELECT 1 FROM rosters WHERE id = ? AND org = ?) AND " +
          "(SELECT COUNT(*) FROM roster_join_keys WHERE roster_id = ? AND org = ? " +
            "AND revoked_at IS NULL AND expires_at > ? AND (reusable = 1 OR used = 0)) < ?",
      ).bind(
        prefix, id, identity.org, await sha256Hex(secret), body.data.description, identity.handle,
        now, expiresAt, body.data.reusable ? 1 : 0,
        id, identity.org, id, identity.org, now, MAX_ACTIVE_ROSTER_JOIN_KEYS,
      ),
      rosterAuditStatement(c, {
        event: "roster.join_key.issue", action: "C", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "admin_secret", targetType: "join_key", targetId: prefix,
        description: `${identity.handle} issued join key ${prefix} for roster ${id}`, at: now,
      }, "previous-change"),
    ]);
    if ((inserted.meta.changes ?? 0) !== 1) {
      const stillExists = await c.env.DB.prepare("SELECT 1 FROM rosters WHERE id = ? AND org = ?")
        .bind(id, identity.org).first();
      return stillExists ? c.json({ error: "active join key limit reached" }, 409) : c.json(NOT_FOUND, 404);
    }
    return c.json({ join_key: joinKey, key: publicJoinKey({
      prefix, description: body.data.description, created_at: now, expires_at: expiresAt,
      created_by: identity.handle,
      reusable: body.data.reusable ? 1 : 0, used: 0, revoked_at: null,
    }) });
  });

  app.post("/v1/roster/:id/keys/list", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) return c.json({ error: "rate limited" }, 429);
    const body = AdminSecretRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const { results } = await c.env.DB.prepare(
      "SELECT prefix, description, created_by, created_at, expires_at, reusable, used, revoked_at " +
        "FROM roster_join_keys WHERE roster_id = ? AND org = ? ORDER BY created_at DESC LIMIT ?",
    ).bind(id, identity.org, MAX_LISTED_ROSTER_JOIN_KEYS).all<JoinKeyRow>();
    return c.json({ keys: (results ?? []).map(publicJoinKey) });
  });

  app.post("/v1/roster/:id/keys/:prefix/revoke", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) return c.json({ error: "rate limited" }, 429);
    const raw = await c.req.json().catch(() => null);
    const body = RevokeRosterJoinKeyRequest.safeParse({ ...(typeof raw === "object" && raw ? raw : {}), prefix: c.req.param("prefix") });
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const key = await c.env.DB.prepare(
      "SELECT revoked_at FROM roster_join_keys WHERE prefix = ? AND roster_id = ? AND org = ?",
    ).bind(body.data.prefix, id, identity.org).first<{ revoked_at: number | null }>();
    if (!key) return c.json(NOT_FOUND, 404);
    const now = Date.now();
    const statements = [
      c.env.DB.prepare(
        "UPDATE roster_join_keys SET revoked_at = ? WHERE prefix = ? AND roster_id = ? AND org = ? AND revoked_at IS NULL",
      ).bind(now, body.data.prefix, id, identity.org),
      rosterAuditStatement(c, {
        event: "roster.join_key.revoke", action: "U", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "admin_secret", targetType: "join_key", targetId: body.data.prefix,
        description: `${identity.handle} revoked join key ${body.data.prefix} for roster ${id}`, at: now,
      }, "previous-change"),
    ];
    if (body.data.evict) statements.push(
      c.env.DB.prepare(
        "DELETE FROM roster_members WHERE roster_id = ? AND org = ? AND joined_via_prefix = ?",
      ).bind(id, identity.org, body.data.prefix),
      rosterAuditStatement(c, {
        event: "roster.join_key.evict", action: "D", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "admin_secret", targetType: "join_key", targetId: body.data.prefix,
        description: `${identity.handle} evicted members admitted by join key ${body.data.prefix}`, at: now,
      }, "previous-change"),
    );
    const results = await c.env.DB.batch(statements);
    const evicted = body.data.evict ? (results[2]?.meta.changes ?? 0) : 0;
    const persisted = await c.env.DB.prepare(
      "SELECT revoked_at FROM roster_join_keys WHERE prefix = ? AND roster_id = ? AND org = ?",
    ).bind(body.data.prefix, id, identity.org).first<{ revoked_at: number | null }>();
    if (persisted?.revoked_at == null) return c.json(NOT_FOUND, 404);
    return c.json({ prefix: body.data.prefix, revoked_at: persisted.revoked_at, evicted });
  });

  app.post("/v1/roster/:id/delete", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    if (!(await checkLimit(c.env, `${identity.org}:${id}`, ROSTER_WRITE))) return c.json({ error: "rate limited" }, 429);
    const body = AdminSecretRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const now = Date.now();
    const [, , deleted] = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM roster_join_keys WHERE roster_id = ? AND org = ?").bind(id, identity.org),
      c.env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ? AND org = ?").bind(id, identity.org),
      c.env.DB.prepare("DELETE FROM rosters WHERE id = ? AND org = ?").bind(id, identity.org),
      rosterAuditStatement(c, {
        event: "roster.delete", action: "D", rosterId: id, org: identity.org,
        actor: identity.handle, actorType: "admin_secret", targetType: "roster", targetId: null,
        description: `${identity.handle} deleted roster ${id}`, at: now,
      }, "previous-change"),
    ]);
    if ((deleted.meta.changes ?? 0) !== 1) return c.json(NOT_FOUND, 404);
    return c.json({ ok: true });
  });

  app.get("/v1/roster/:id/bundle", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle: viewer } = identity;

    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await checkLimit(c.env, `${ip}:${id}`, NATIVE_ROSTER_READ))) {
      return c.json({ error: "rate limited" }, 429);
    }

    // Membership is the real authorization. Possession of a handle token is
    // not a gate: registration is open. Checked BEFORE anything reveals that
    // the roster exists, and a non-member gets the same NOT_FOUND an unknown
    // roster gets.
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?",
    ).bind(id, org, viewer).first();
    if (!member) return c.json(NOT_FOUND, 404);

    // One query, never one shared-group query per member. ranked_shared mirrors
    // sharedRosterIds exactly: roster_id ascending, first MAX_CALLER_GROUPS.
    // ROW_NUMBER applies the cap independently for each target before
    // GROUP_CONCAT, so discovery cannot attest a group call admission omits.
    const { results } = await c.env.DB.prepare(
      "WITH target_handles AS (" +
        "SELECT handle, org FROM roster_members WHERE roster_id = ? AND org = ?" +
      "), ranked_shared AS (" +
        "SELECT target.handle, viewer_membership.roster_id, " +
          "ROW_NUMBER() OVER (PARTITION BY target.handle ORDER BY viewer_membership.roster_id) AS group_rank " +
        "FROM target_handles target " +
        "JOIN roster_members shared ON shared.org = target.org AND shared.handle = target.handle " +
        "JOIN roster_members viewer_membership ON viewer_membership.org = shared.org " +
          "AND viewer_membership.roster_id = shared.roster_id AND viewer_membership.handle = ?" +
      "), capped_shared AS (" +
        "SELECT handle, GROUP_CONCAT(roster_id) AS shared_rosters FROM ranked_shared " +
        "WHERE group_rank <= ? GROUP BY handle" +
      ") " +
      "SELECT c.handle, c.card_json, c.updated_at, capped_shared.shared_rosters " +
        "FROM target_handles target " +
        "JOIN cards c ON c.org = target.org AND c.handle = target.handle " +
        "LEFT JOIN capped_shared ON capped_shared.handle = target.handle " +
        "ORDER BY c.handle",
    ).bind(id, org, viewer, MAX_CALLER_GROUPS).all<{
      handle: string; card_json: string; updated_at: number; shared_rosters: string | null;
    }>();

    const entries = [];
    let skipped = 0;
    for (const row of results ?? []) {
      const upload = parseStoredCard(row.card_json, org, row.handle);
      if (!upload) {
        // One invalid stored card must not 500 the bundle for everyone else.
        skipped++;
        continue;
      }
      const visible = visibleTasks(upload, viewer, row.shared_rosters?.split(",") ?? []);
      // Zero visible tasks means omitted entirely, not an empty entry: an
      // entry carrying a handle would disclose membership. This endpoint is
      // a search index, not an org directory.
      if (visible.length === 0) continue;
      entries.push({
        handle: row.handle,
        agent_kind: upload.agent_kind,
        // `examples` are deliberately dropped — see BundleTask in
        // packages/shared/src/roster.ts.
        tasks: visible.slice(0, MAX_BUNDLE_TASKS_PER_CARD).map((t) => ({
          id: t.id, name: t.name, description: t.description, keywords: t.keywords,
        })),
        updated_at: row.updated_at,
        truncated: visible.length > MAX_BUNDLE_TASKS_PER_CARD,
      });
    }

    const payload = { roster_id: id, entries, skipped };
    const serialized = JSON.stringify(payload);
    // Membership changes can alter group-granted tasks without touching the
    // card timestamp or entry count. Hash the actual projection plus viewer
    // identity so a conditional request cannot retain stale authorization.
    const etag = `"${await sha256Hex(`${org}\0${viewer}\0${serialized}`)}"`;
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
    }
    return new Response(serialized, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        ETag: etag,
        "Cache-Control": "private, no-store",
      },
    });
  });
}
