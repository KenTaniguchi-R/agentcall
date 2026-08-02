import type { Context, Hono } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "./index.js";
import { constantTimeEqual, generateToken, sha256Hex } from "./auth.js";
import {
  AdminSecretRequest, CardUpload, ExpelRosterRequest, JoinRosterRequest, MAX_BUNDLE_TASKS_PER_CARD,
  MAX_ROSTER_MEMBERS, ROSTER_ID_RE, RotateRosterRequest, visibleTasks,
} from "@benree/agentcall-shared";
import { authenticateRequest } from "./tenant.js";

// 16 random bytes, base64url — 22 chars, inside ROSTER_ID_RE's 16..64 window.
// Unguessable but not secret: it travels in URL paths and will be logged.
function generateRosterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function mountRoster(app: Hono<{ Bindings: Env }>): void {
  app.post("/v1/roster", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle } = identity;
    // Reuses REGISTER_RL with a distinct key prefix, the same technique
    // /v1/token/rotate uses: creating rosters should cost what registering
    // handles costs, so it cannot be used to cheaply fill D1 with rows.
    if (!(await c.env.REGISTER_RL.limit({ key: `roster:${handle}` })).success) {
      return c.json({ error: "rate limited" }, 429);
    }
    const roster_id = generateRosterId();
    const join_secret = generateToken();
    const admin_secret = generateToken();
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO rosters (id, org, join_secret_hash, admin_secret_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(roster_id, org, await sha256Hex(join_secret), await sha256Hex(admin_secret), now),
      c.env.DB.prepare("INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, ?, ?, ?)")
        .bind(roster_id, org, handle, now),
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) VALUES (?, ?, 'create', ?, NULL, ?)",
      ).bind(roster_id, org, handle, now),
    ]);
    // Both secrets are returned exactly once and only their digests persist.
    return c.json({ roster_id, join_secret, admin_secret });
  });

  // One shared body for "unknown roster" and "wrong secret". They MUST be
  // byte-identical: a distinct response for either one turns roster ids into
  // an enumerable namespace. Declared once so the two call sites cannot drift.
  const NOT_FOUND = { error: "not found" } as const;

  app.post("/v1/roster/:id/join", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle } = identity;

    const id = c.req.param("id");
    // Shape-check before touching D1: a malformed id can never match a row,
    // and rejecting it here keeps junk out of the query path.
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `join:${ip}:${id}` })).success) {
      return c.json({ error: "rate limited" }, 429);
    }

    const body = JoinRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);

    const supplied = await sha256Hex(body.data.join_secret);
    // Authorization and capacity are evaluated by SQLite at INSERT time, not
    // by Worker reads that concurrent joins or a secret rotation can straddle.
    // Comparing secret_hash in SQL is deliberately acceptable here: both
    // operands are fixed-length SHA-256 digests of an unguessable 32-byte
    // token, so SQLite's byte-wise early exit reveals no usable secret prefix.
    const now = Date.now();
    const [inserted] = await c.env.DB.batch([
      c.env.DB.prepare(
      "INSERT OR IGNORE INTO roster_members (roster_id, org, handle, joined_at) " +
        "SELECT r.id, r.org, ?, ? FROM rosters r " +
        "WHERE r.id = ? AND r.org = ? AND r.join_secret_hash = ? " +
        "AND (SELECT COUNT(*) FROM roster_members WHERE roster_id = r.id) < ?",
      ).bind(handle, now, id, org, supplied, MAX_ROSTER_MEMBERS),
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) " +
          "SELECT ?, ?, 'join', ?, ?, ? WHERE EXISTS (" +
          "SELECT 1 FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ? AND joined_at = ?)",
      ).bind(id, org, handle, handle, now, id, org, handle, now),
    ]);
    if ((inserted.meta.changes ?? 0) === 1) return c.json({ ok: true });

    // Zero changes has three meanings. This read chooses the response only;
    // it cannot authorize a write, so racing it cannot bypass the atomic gate.
    const state = await c.env.DB.prepare(
      "SELECT r.join_secret_hash, EXISTS(" +
        "SELECT 1 FROM roster_members m WHERE m.roster_id = r.id AND m.org = r.org AND m.handle = ?" +
        ") AS member FROM rosters r WHERE r.id = ? AND r.org = ?",
    ).bind(handle, id, org).first<{ join_secret_hash: string; member: number }>();
    if (!state || !constantTimeEqual(state.join_secret_hash, supplied)) return c.json(NOT_FOUND, 404);
    if (state.member === 1) return c.json({ ok: true });
    return c.json({ error: "roster full" }, 409);
  });

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
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `leave:${ip}:${id}` })).success) return c.json({ error: "rate limited" }, 429);
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?",
    ).bind(id, identity.org, identity.handle).first();
    if (!member) return c.json(NOT_FOUND, 404);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?")
        .bind(id, identity.org, identity.handle),
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) VALUES (?, ?, 'leave', ?, ?, ?)",
      ).bind(id, identity.org, identity.handle, identity.handle, now),
    ]);
    return c.json({ ok: true });
  });

  app.post("/v1/roster/:id/expel", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `expel:${ip}:${id}` })).success) return c.json({ error: "rate limited" }, 429);
    const body = ExpelRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?",
    ).bind(id, identity.org, body.data.handle).first();
    if (!member) return c.json({ error: "member not found" }, 404);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ? AND org = ? AND handle = ?")
        .bind(id, identity.org, body.data.handle),
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) VALUES (?, ?, 'expel', ?, ?, ?)",
      ).bind(id, identity.org, identity.handle, body.data.handle, now),
    ]);
    return c.json({ ok: true });
  });

  app.post("/v1/roster/:id/rotate", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `rotate:${ip}:${id}` })).success) return c.json({ error: "rate limited" }, 429);
    const body = RotateRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const join_secret = generateToken();
    const now = Date.now();
    const statements = [
      c.env.DB.prepare("UPDATE rosters SET join_secret_hash = ? WHERE id = ? AND org = ?")
        .bind(await sha256Hex(join_secret), id, identity.org),
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) VALUES (?, ?, 'rotate', ?, NULL, ?)",
      ).bind(id, identity.org, identity.handle, now),
    ];
    if (body.data.evict) statements.push(
      c.env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ? AND org = ?").bind(id, identity.org),
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) VALUES (?, ?, 'evict_all', ?, NULL, ?)",
      ).bind(id, identity.org, identity.handle, now),
    );
    await c.env.DB.batch(statements);
    return c.json({ join_secret });
  });

  app.post("/v1/roster/:id/delete", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `delete:${ip}:${id}` })).success) return c.json({ error: "rate limited" }, 429);
    const body = AdminSecretRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);
    const roster = await adminRoster(c, id, body.data.admin_secret);
    if (!roster || roster.org !== identity.org) return c.json(NOT_FOUND, 404);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) VALUES (?, ?, 'delete', ?, NULL, ?)",
      ).bind(id, identity.org, identity.handle, now),
      c.env.DB.prepare("DELETE FROM roster_members WHERE roster_id = ? AND org = ?").bind(id, identity.org),
      c.env.DB.prepare("DELETE FROM rosters WHERE id = ? AND org = ?").bind(id, identity.org),
    ]);
    return c.json({ ok: true });
  });

  app.get("/v1/roster/:id/bundle", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const { org, handle: viewer } = identity;

    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `bundle:${ip}:${id}` })).success) {
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

    // One bounded join, never N queries. Bounded by MAX_ROSTER_MEMBERS,
    // which join enforces.
    const { results } = await c.env.DB.prepare(
      "SELECT c.handle, c.card_json, c.updated_at FROM roster_members m " +
        "JOIN cards c ON c.org = m.org AND c.handle = m.handle " +
        "WHERE m.roster_id = ? AND m.org = ? ORDER BY c.handle",
    ).bind(id, org).all<{ handle: string; card_json: string; updated_at: number }>();

    const entries = [];
    let skipped = 0;
    let newest = 0;
    for (const row of results ?? []) {
      let upload;
      try {
        upload = CardUpload.parse(JSON.parse(row.card_json));
      } catch {
        // One bad legacy card must not 500 the bundle for everyone else.
        skipped++;
        continue;
      }
      const visible = visibleTasks(upload, viewer);
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
      if (row.updated_at > newest) newest = row.updated_at;
    }

    // Varies by caller (grants differ), so the ETag must include the viewer
    // and the response must never enter a shared cache.
    const etag = `"${id}-${org}-${viewer}-${newest}-${entries.length}-${skipped}"`;
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
    }
    return c.json({ roster_id: id, entries, skipped }, 200, {
      ETag: etag,
      "Cache-Control": "private, no-store",
    });
  });
}
