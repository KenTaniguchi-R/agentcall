import { Hono } from "hono";
import { CardUpload, RegisterRequest, visibleTasks, type OrgRoleType } from "@benree/agentcall-shared";
import { mountA2A } from "./a2a.js";
import { mountAudit } from "./audit.js";
import { orgAuditStatement, orgAuditTrimStatement } from "./events.js";
import { expiredInviteCleanupStatement, mountInvites } from "./invites.js";
import { mountKeys } from "./keys.js";
import { mountPresence } from "./presence.js";
import { mountRoster } from "./roster.js";
import { generateToken, sha256Hex } from "./auth.js";
import { deploymentOrgAllows, identityKey, registrationAddressHost,
  type DeploymentMode } from "./tenant.js";
import { sharedRosterIds } from "./groups.js";
import { checkLimit, NATIVE_CARD, NATIVE_READ, REGISTER, type RateLimitEnv } from "./ratelimit/index.js";
import { parseStoredCard } from "./stored-card.js";
import { drainRecoveryEvictions, mountRecovery } from "./recovery.js";
import { mountRooms } from "./room/routes.js";
import { rateLimit, requireIdentity, type RelayAppEnv } from "./middleware.js";

export { HandleDO } from "./do.js";
export { RateLimiterDO } from "./ratelimit/do.js";
export { RoomDO } from "./room/do.js";

export type Env = RateLimitEnv & {
  DB: D1Database;
  HANDLE_DO: DurableObjectNamespace;
  ROOM_DO: DurableObjectNamespace;
  STATUS_READS: AnalyticsEngineDataset;
  BOOTSTRAP_TOKEN?: string;
  /** Required: missing or unknown deployment mode fails every tenant boundary closed. */
  DEPLOYMENT_MODE: DeploymentMode;
  /** Pins a customer-operated relay to one tenant and makes the tenant hostname-independent. */
  SELF_HOSTED_ORG?: string;
};
const app = new Hono<RelayAppEnv>();
app.use("/v1/*", requireIdentity);
mountA2A(app);
mountAudit(app);
mountInvites(app);
mountKeys(app);
mountPresence(app);
mountRoster(app);
mountRecovery(app);
mountRooms(app);

async function handleExists(db: D1Database, org: string, handle: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM handles WHERE org = ? AND handle = ?").bind(org, handle).first());
}

function registrationDatabaseFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  let kind = "unknown";
  if (/no such (?:table|column)|has no column named|database schema/i.test(message)) kind = "schema";
  else if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) kind = "constraint";
  else if (/timeout|timed out|connection|network|unavailable|internal error/i.test(message)) kind = "unavailable";
  // Do not log the raw D1 message: wrappers may include SQL or bound values.
  console.error("registration database failure", {
    name: error instanceof Error ? error.name : "UnknownError",
    kind,
  });
  return { error: "registration temporarily unavailable" } as const;
}

app.post("/v1/register", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await checkLimit(c.env, ip, REGISTER))) return c.json({ error: "rate limited" }, 429);
  const body = RegisterRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request" }, 400);
  const { invite, handle, agent_kind } = body.data;
  const inviteHash = await sha256Hex(invite);
  let inviteRow: { org: string; org_role: OrgRoleType } | null;
  try {
    inviteRow = await c.env.DB.prepare(
      "SELECT org, org_role FROM invites WHERE token_hash = ? AND used_at IS NULL " +
        "AND revoked_at IS NULL AND expires_at > ?",
    ).bind(inviteHash, Date.now()).first<{ org: string; org_role: OrgRoleType }>();
  } catch (error) {
    return c.json(registrationDatabaseFailure(error), 503, { "Retry-After": "5" });
  }
  if (!inviteRow) return c.json({ error: "invalid invite" }, 404);
  const org = inviteRow.org;
  if (!deploymentOrgAllows(c.env.DEPLOYMENT_MODE, c.env.SELF_HOSTED_ORG, org)) {
    return c.json({ error: "invalid invite" }, 404);
  }
  const token = generateToken();
  try {
    const now = Date.now();
    const tokenHash = await sha256Hex(token);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO handles (org, handle, token_hash, agent_kind, created_at, org_role) " +
          "SELECT org, ?, ?, ?, ?, org_role FROM invites " +
          "WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? " +
          "ON CONFLICT(org, handle) DO NOTHING",
      ).bind(handle, tokenHash, agent_kind ?? null, now, inviteHash, now),
      c.env.DB.prepare(
        "UPDATE invites SET used_at = ?, used_by = ? " +
        "WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND EXISTS (" +
          "SELECT 1 FROM handles WHERE org = invites.org AND handle = ? AND token_hash = ?)",
      ).bind(now, handle, inviteHash, handle, tokenHash),
      orgAuditStatement(c, {
        event: "org.invite.redeem", action: "C", org, actor: inviteHash, actorType: "invite",
        targetType: "handle", targetId: handle,
        targetRole: inviteRow.org_role,
        description: `Organization invite ${inviteHash} enrolled ${handle} as ${inviteRow.org_role}`, at: now,
      }, "previous-change"),
      orgAuditTrimStatement(c.env.DB, org),
      expiredInviteCleanupStatement(c.env.DB, org, now),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      if (await handleExists(c.env.DB, org, handle)) return c.json({ error: "handle taken" }, 409);
      return c.json({ error: "invalid invite" }, 404);
    }
    if ((results[1].meta.changes ?? 0) !== 1) throw new Error("registration invite update invariant failed");
  } catch (error) {
    return c.json(
      registrationDatabaseFailure(error),
      503,
      { "Retry-After": "5" },
    );
  }
  return c.json({ org, token, address: `${handle}@${registrationAddressHost(org, c.req.url)}` });
});

// Until this existed, a leaked token was permanent: register was the only
// write to `handles` in the whole codebase, and `agentcall uninstall --purge`
// clears the local copy while the relay row and its hash live on forever.
//
// Rotation only — releasing a handle is deliberately not implemented. The
// Durable Objects are addressed by org + handle. Releasing and reassigning an
// identity still needs an explicit generation/recovery design so a replacement
// owner cannot inherit the prior owner's stored state.
//
// Token rotation shares the 5/min credential-operation policy. Its distinct
// key keeps it from sharing a budget with registrations or invite creation.
app.post("/v1/token/rotate", rateLimit(REGISTER, "identity", "rotate:"), async (c) => {
  const identity = c.var.identity;
  const { org, handle } = identity;
  const next = generateToken();
  // UPDATE, never INSERT: an unregistered handle can't reach here (it fails
  // the auth check above), so this must not be able to conjure a row.
  const presented = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const result = await c.env.DB.prepare(
    "UPDATE handles SET token_hash = ? WHERE org = ? AND handle = ? AND token_hash = ?",
  ).bind(await sha256Hex(next), org, handle, await sha256Hex(presented)).run();
  if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "credential changed" }, 409);
  return c.json({ token: next });
});

app.put("/v1/card", rateLimit(NATIVE_CARD, "identity"), async (c) => {
  const identity = c.var.identity;
  const { org, handle } = identity;
  const body = CardUpload.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid card" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(org, handle) DO UPDATE SET card_json = excluded.card_json, updated_at = excluded.updated_at",
  ).bind(org, handle, JSON.stringify(body.data), Date.now()).run();
  return c.json({ ok: true });
});

app.get("/v1/card/:handle", rateLimit(NATIVE_READ, "ip"), async (c) => {
  const identity = c.var.identity;
  const { org, handle: viewer } = identity;
  const handle = c.req.param("handle");
  const row = await c.env.DB.prepare("SELECT card_json, updated_at FROM cards WHERE org = ? AND handle = ?")
    .bind(org, handle).first<{ card_json: string; updated_at: number }>();
  if (!row) return c.json({ error: "no card" }, 404);

  const upload = parseStoredCard(row.card_json, org, handle);
  if (!upload) return c.json({ error: "no card" }, 404);
  return c.json({
    handle,
    description: upload.description,
    agent_kind: upload.agent_kind,
    tasks: visibleTasks(upload, viewer, await sharedRosterIds(c.env.DB, org, viewer, handle)),
    updated_at: row.updated_at,
  });
});

app.get("/v1/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
  const role = c.req.query("role");
  const identity = c.var.identity;
  const { org, handle } = identity;

  let target: string;
  let groups: string[] = [];
  if (role === "listen") {
    target = handle;
  } else if (role === "call") {
    // A call socket is one opaque attempt, even when the target is offline or
    // unknown. Meter upgrades before target lookup so it cannot be used as a
    // free presence/namespace oracle.
    if (!(await checkLimit(c.env, `${org}:${handle}`, NATIVE_READ))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const to = c.req.query("to") ?? "";
    if (!(await handleExists(c.env.DB, org, to))) return c.json({ error: "unknown handle" }, 404);
    target = to;
    // The caller cannot supply a policy selector. Group attestation is the
    // relay's observation that both identities are currently live members of
    // the same roster, taken before the DO accepts the caller socket.
    groups = await sharedRosterIds(c.env.DB, org, handle, target);
  } else {
    return c.json({ error: "bad role" }, 400);
  }

  const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(identityKey(org, target)));
  const fwd = new Request(`https://do/ws?role=${role}&test_timeout_ms=${c.req.query("test_timeout_ms") ?? ""}`, c.req.raw);
  fwd.headers.set("X-Verified-From", handle);
  fwd.headers.set("X-Verified-Org", org);
  fwd.headers.set("X-Verified-Target", target);
  fwd.headers.set("X-Verified-Credential-Generation", String(identity.recoveryGeneration));
  fwd.headers.set("X-Verified-Relay-Origin", registrationAddressHost(org, c.req.url));
  fwd.headers.set("X-Verified-Groups", JSON.stringify(groups));
  fwd.headers.set("X-Verified-Actor-IP", c.req.header("cf-connecting-ip") ?? "");
  const country = c.req.raw.cf?.country;
  fwd.headers.set("X-Verified-Actor-Country", typeof country === "string" ? country : "");
  return stub.fetch(fwd);
});

const worker = Object.assign(app, {
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(drainRecoveryEvictions(env));
  },
});

export default worker;
