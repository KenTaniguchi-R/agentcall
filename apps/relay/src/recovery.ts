import type { Context, Hono } from "hono";
// Type-only, so the index -> recovery -> index cycle is erased at compile
// time and never exists at runtime — the same rule roster.ts and a2a.ts follow.
import type { Env } from "./index.js";
import { RecoveryRedeemRequest } from "@benree/agentcall-shared";
import { generateToken, generateRecoveryCode, normalizeRecoveryCode, sha256Hex, verifyHandleToken } from "./auth.js";
import { RELAY_HOST } from "./host.js";

type App = Hono<{ Bindings: Env }>;

function auth(c: Context<{ Bindings: Env }>): { handle: string; token: string } {
  return {
    handle: c.req.header("X-AgentCall-Handle") ?? "",
    token: (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, ""),
  };
}

// Charged on BOTH keys: an IP-only limit lets one attacker grind many
// handles, and a handle-only limit lets a botnet grind one handle. Both are
// consumed per request so neither dimension is free.
//
// Only safe for token-authenticated routes (issue, state): anyone who can
// reach them already holds the token, so charging the handle key costs a
// legitimate caller nothing. redeem is NOT authenticated and must use
// limitedByIp below instead — see its comment for why.
async function limited(c: Context<{ Bindings: Env }>, handle: string): Promise<boolean> {
  const byHandle = await c.env.RECOVER_RL.limit({ key: `h:${handle}` });
  return !byHandle.success || (await limitedByIp(c));
}

// IP key only — deliberately does NOT charge the handle key. redeem is
// unauthenticated: anyone can submit a guessed code for any handle, so a
// handle-keyed limit would let a stranger grind a victim's handle-key
// budget and hold it permanently 429'd, denying the owner their own
// recovery at exactly the moment they need it (RECOVER_RL is 3/60s, shared
// across issue/state/redeem, which makes this cheap to sustain). The
// per-handle key exists to stop credential grinding, but the recovery code
// is 120 bits, so grinding is already infeasible and that key buys
// essentially nothing on redeem — while creating a targeted
// denial-of-recovery. The per-IP key still bounds abuse volume.
//
// This is a deliberate amendment to the original design (which charged both
// keys on redeem too) — do not "restore" the handle key here.
//
// Called before any existence check, same as `limited` above: charging
// ahead of knowing whether the handle exists is what keeps a 429 from
// becoming a handle-enumeration oracle.
async function limitedByIp(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const byIp = await c.env.RECOVER_RL.limit({ key: `i:${ip}` });
  return !byIp.success;
}

export function mountRecovery(app: App): void {
  app.post("/v1/recovery/issue", async (c) => {
    const { handle, token } = auth(c);
    if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
    if (await limited(c, handle)) return c.json({ error: "rate limited" }, 429);

    const code = generateRecoveryCode();
    // Conditioned on the token hash we just authenticated against, for the
    // same reason rotate is: verify-then-write is two round trips, and a
    // concurrent rotation between them would otherwise bind a recovery code
    // to a credential that no longer exists.
    const row = await c.env.DB.prepare(
      "UPDATE handles SET recovery_hash = ? WHERE handle = ? AND token_hash = ? RETURNING handle",
    ).bind(await sha256Hex(normalizeRecoveryCode(code)!), handle, await sha256Hex(token)).first();
    if (!row) return c.json({ error: "unauthorized" }, 401);
    return c.json({ recovery_code: code });
  });

  app.get("/v1/recovery/state", async (c) => {
    const { handle, token } = auth(c);
    if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
    if (await limited(c, handle)) return c.json({ error: "rate limited" }, 429);

    const row = await c.env.DB.prepare(
      "SELECT recovery_hash, recovery_redeemed_at FROM handles WHERE handle = ?",
    ).bind(handle).first<{ recovery_hash: string | null; recovery_redeemed_at: number | null }>();
    // Booleans and a timestamp only — never the hash. A caller holding the
    // token could mint a fresh code anyway, so this leaks nothing new, but
    // returning the stored hash would leak something it can't undo.
    return c.json({ issued: row?.recovery_hash != null, redeemed_at: row?.recovery_redeemed_at ?? null });
  });

  app.post("/v1/recovery/redeem", async (c) => {
    const body = RecoveryRedeemRequest.safeParse(await c.req.json().catch(() => null));
    // A malformed code is a client bug, not a guess, and is rejected before
    // any database work. It is the one failure that does NOT return 401 —
    // it reveals nothing about whether the handle exists.
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const { handle, recovery_code } = body.data;

    // IP key only — see limitedByIp's comment. Charging the handle key here
    // would turn this unauthenticated endpoint into a denial-of-recovery
    // tool against the very owner it's meant to help.
    if (await limitedByIp(c)) return c.json({ error: "rate limited" }, 429);

    const normalized = normalizeRecoveryCode(recovery_code);
    if (normalized === null) return c.json({ error: "invalid request" }, 400);

    const nextToken = generateToken();
    const nextCode = generateRecoveryCode();
    // Everything hangs on this one statement.
    //
    // `recovery_hash = ?` in SQL is NEVER true when the column is NULL —
    // that is exactly the property this relies on, and it is why the
    // never-issued case cannot be redeemed even though its "expected" value
    // is absent. Do not "fix" this into `IS NOT DISTINCT FROM` or an
    // IFNULL-defaulted comparison.
    //
    // It is also the compare-and-swap: two concurrent redemptions of the
    // same code both pass a read-then-write check, but only one can match
    // the hash here, because the winner overwrites it in the same statement.
    const row = await c.env.DB.prepare(
      "UPDATE handles SET token_hash = ?, recovery_hash = ?, recovery_redeemed_at = ? " +
        "WHERE handle = ? AND recovery_hash = ? RETURNING handle",
    ).bind(
      await sha256Hex(nextToken),
      await sha256Hex(normalizeRecoveryCode(nextCode)!),
      Date.now(),
      handle,
      await sha256Hex(normalized),
    ).first();

    // One response for unknown handle, wrong code, never-issued, and
    // lost-race. Distinguishing them would turn this into the handle
    // enumeration oracle that /v1/status was before it required auth.
    if (!row) return c.json({ error: "unauthorized" }, 401);
    return c.json({ token: nextToken, recovery_code: nextCode, address: `${handle}@${RELAY_HOST}` });
  });
}
