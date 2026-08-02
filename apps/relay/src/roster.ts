import type { Hono } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "./index.js";
import { constantTimeEqual, generateToken, sha256Hex } from "./auth.js";
import {
  CardUpload, JoinRosterRequest, MAX_BUNDLE_TASKS_PER_CARD, MAX_ROSTER_MEMBERS,
  ROSTER_ID_RE, visibleTasks,
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
    const secret = generateToken();
    await c.env.DB.prepare("INSERT INTO rosters (id, secret_hash, created_at, org) VALUES (?, ?, ?, ?)")
      .bind(roster_id, await sha256Hex(secret), Date.now(), org).run();
    // The creator is a member like anyone else — there is no owner role.
    await c.env.DB.prepare("INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, ?, ?, ?)")
      .bind(roster_id, org, handle, Date.now()).run();
    // The secret is returned exactly once and never stored in plaintext.
    return c.json({ roster_id, secret });
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

    const supplied = await sha256Hex(body.data.secret);
    // Authorization and capacity are evaluated by SQLite at INSERT time, not
    // by Worker reads that concurrent joins or a secret rotation can straddle.
    // Comparing secret_hash in SQL is deliberately acceptable here: both
    // operands are fixed-length SHA-256 digests of an unguessable 32-byte
    // token, so SQLite's byte-wise early exit reveals no usable secret prefix.
    const inserted = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO roster_members (roster_id, org, handle, joined_at) " +
        "SELECT r.id, r.org, ?, ? FROM rosters r " +
        "WHERE r.id = ? AND r.org = ? AND r.secret_hash = ? " +
        "AND (SELECT COUNT(*) FROM roster_members WHERE roster_id = r.id) < ?",
    ).bind(handle, Date.now(), id, org, supplied, MAX_ROSTER_MEMBERS).run();
    if ((inserted.meta.changes ?? 0) === 1) return c.json({ ok: true });

    // Zero changes has three meanings. This read chooses the response only;
    // it cannot authorize a write, so racing it cannot bypass the atomic gate.
    const state = await c.env.DB.prepare(
      "SELECT r.secret_hash, EXISTS(" +
        "SELECT 1 FROM roster_members m WHERE m.roster_id = r.id AND m.org = r.org AND m.handle = ?" +
        ") AS member FROM rosters r WHERE r.id = ? AND r.org = ?",
    ).bind(handle, id, org).first<{ secret_hash: string; member: number }>();
    if (!state || !constantTimeEqual(state.secret_hash, supplied)) return c.json(NOT_FOUND, 404);
    if (state.member === 1) return c.json({ ok: true });
    return c.json({ error: "roster full" }, 409);
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
