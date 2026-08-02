import type { Context, Hono } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "./index.js";
import { generateToken, sha256Hex, verifyHandleToken } from "./auth.js";

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
}
