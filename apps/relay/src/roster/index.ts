import type { Hono } from "hono";
import type { Env } from "../index.js";
import { generateToken, sha256Hex, verifyHandleToken } from "../auth.js";
import { JoinRosterRequest, MAX_ROSTER_MEMBERS } from "@benree/agentcall-shared";
import { notFound, requireRoster, secretMatches } from "./guards.js";
import { handleBundle } from "./bundle.js";

// 16 random bytes, base64url — 22 chars, inside ROSTER_ID_RE's 16..64 window.
// Unguessable but not secret: it travels in URL paths and will be logged.
function generateRosterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function mountRoster(app: Hono<{ Bindings: Env }>): void {
  // POST /v1/roster does NOT go through requireRoster: there is no :id yet,
  // and it is rate-limited on REGISTER_RL rather than ROSTER_RL so creating
  // a roster costs what registering a handle costs.
  app.post("/v1/roster", async (c) => {
    const handle = c.req.header("X-AgentCall-Handle") ?? "";
    const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
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

  app.post("/v1/roster/:id/join", async (c) => {
    const gate = await requireRoster(c, "join");
    if (gate instanceof Response) return gate;
    const { handle, id } = gate;

    const body = JoinRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return notFound();

    const row = await c.env.DB.prepare("SELECT secret_hash FROM rosters WHERE id = ?")
      .bind(id).first<{ secret_hash: string }>();
    // Hash the supplied secret even when the roster is missing, so the two
    // paths cost the same. Never log the secret or its digest.
    if (!(await secretMatches(body.data.secret, row?.secret_hash ?? null))) return notFound();

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
    const gate = await requireRoster(c, "bundle");
    if (gate instanceof Response) return gate;
    return handleBundle(c, gate.id, gate.handle);
  });
}
