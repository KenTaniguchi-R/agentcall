import type { Context, Hono } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "./index.js";
import { constantTimeEqual, generateToken, sha256Hex, verifyHandleToken } from "./auth.js";
import {
  CardUpload, JoinRosterRequest, MAX_BUNDLE_TASKS_PER_CARD, MAX_ROSTER_MEMBERS,
  ROSTER_ID_RE, visibleTasks,
} from "@benree/agentcall-shared";

// 16 random bytes, base64url — 22 chars, inside ROSTER_ID_RE's 16..64 window.
// Unguessable but not secret: it travels in URL paths and will be logged.
function generateRosterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Returns the verified handle, or null. Every roster route calls this first:
// possession of a handle token is the floor, not the gate — registration is
// open, so membership is what actually authorizes.
async function auth(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return (await verifyHandleToken(c.env.DB, handle, token)) ? handle : null;
}

export function mountRoster(app: Hono<{ Bindings: Env }>): void {
  app.post("/v1/roster", async (c) => {
    const handle = await auth(c);
    if (!handle) return c.json({ error: "unauthorized" }, 401);
    // Reuses REGISTER_RL with a distinct key prefix, the same technique
    // /v1/token/rotate uses: creating rosters should cost what registering
    // handles costs, so it cannot be used to cheaply fill D1 with rows.
    if (!(await c.env.REGISTER_RL.limit({ key: `roster:${handle}` })).success) {
      return c.json({ error: "rate limited" }, 429);
    }
    const roster_id = generateRosterId();
    const secret = generateToken();
    await c.env.DB.prepare("INSERT INTO rosters (id, secret_hash, created_at) VALUES (?, ?, ?)")
      .bind(roster_id, await sha256Hex(secret), Date.now()).run();
    // The creator is a member like anyone else — there is no owner role.
    await c.env.DB.prepare("INSERT INTO roster_members (roster_id, handle, joined_at) VALUES (?, ?, ?)")
      .bind(roster_id, handle, Date.now()).run();
    // The secret is returned exactly once and never stored in plaintext.
    return c.json({ roster_id, secret });
  });

  // One shared body for "unknown roster" and "wrong secret". They MUST be
  // byte-identical: a distinct response for either one turns roster ids into
  // an enumerable namespace. Declared once so the two call sites cannot drift.
  const NOT_FOUND = { error: "not found" } as const;

  app.post("/v1/roster/:id/join", async (c) => {
    const handle = await auth(c);
    if (!handle) return c.json({ error: "unauthorized" }, 401);

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

    const row = await c.env.DB.prepare("SELECT secret_hash FROM rosters WHERE id = ?")
      .bind(id).first<{ secret_hash: string }>();
    // Hash the supplied secret even when the roster is missing, so the two
    // paths cost the same. Never log the secret or its digest.
    const supplied = await sha256Hex(body.data.secret);
    if (!row || !constantTimeEqual(row.secret_hash, supplied)) return c.json(NOT_FOUND, 404);

    // Past this point the caller has proved the secret, so revealing that the
    // roster exists and is full costs nothing.
    const already = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
    ).bind(id, handle).first();
    if (!already) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM roster_members WHERE roster_id = ?")
        .bind(id).first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_ROSTER_MEMBERS) return c.json({ error: "roster full" }, 409);
      // OR IGNORE: two concurrent joins by the same handle can both pass the
      // membership check above and then race on the (roster_id, handle)
      // primary key. This endpoint documents itself as idempotent, so the
      // loser of that race must not 500.
      await c.env.DB.prepare("INSERT OR IGNORE INTO roster_members (roster_id, handle, joined_at) VALUES (?, ?, ?)")
        .bind(id, handle, Date.now()).run();
    }
    return c.json({ ok: true });
  });

  app.get("/v1/roster/:id/bundle", async (c) => {
    const viewer = await auth(c);
    if (!viewer) return c.json({ error: "unauthorized" }, 401);

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
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
    ).bind(id, viewer).first();
    if (!member) return c.json(NOT_FOUND, 404);

    // One bounded join, never N queries. Bounded by MAX_ROSTER_MEMBERS,
    // which join enforces.
    const { results } = await c.env.DB.prepare(
      "SELECT c.handle, c.card_json, c.updated_at FROM roster_members m " +
        "JOIN cards c ON c.handle = m.handle WHERE m.roster_id = ? ORDER BY c.handle",
    ).bind(id).all<{ handle: string; card_json: string; updated_at: number }>();

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
    const etag = `"${id}-${viewer}-${newest}-${entries.length}-${skipped}"`;
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
    }
    return c.json({ roster_id: id, entries, skipped }, 200, {
      ETag: etag,
      "Cache-Control": "private, no-store",
    });
  });
}
