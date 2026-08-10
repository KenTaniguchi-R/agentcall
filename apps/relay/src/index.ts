import { Hono } from "hono";
import { CardUpload, RegisterRequest, visibleTasks, type OrgRoleType } from "@benree/agentcall-shared";
import { mountA2A } from "./a2a.js";
import { mountAudit } from "./audit.js";
import { orgAuditStatement, orgAuditTrimStatement } from "./events.js";
import { expiredInviteCleanupStatement, mountInvites } from "./invites.js";
import { mountKeys } from "./keys.js";
import { mountPresence } from "./presence.js";
import { generateToken, sha256Hex } from "./auth.js";
import { generateAgentId, resolveAgentId } from "./identity.js";
import { deploymentOrgAllows, identityObjectName,
  type DeploymentMode } from "./tenant.js";
import { checkLimit, NATIVE_CARD, NATIVE_READ, REGISTER, type RateLimitEnv } from "./ratelimit/index.js";
import { parseStoredCard } from "./stored-card.js";
import { drainRecoveryEvictions, mountRecovery } from "./recovery.js";
import { jsonBody, rateLimit, requireIdentity, type RelayAppEnv } from "./middleware.js";

export { HandleDO } from "./do.js";
export { RateLimiterDO } from "./ratelimit/do.js";

export type Env = RateLimitEnv & {
  /** Hosted-only product-site assets; customer-owned relays intentionally omit them. */
  ASSETS?: Fetcher;
  DB: D1Database;
  HANDLE_DO: DurableObjectNamespace;
  STATUS_READS: AnalyticsEngineDataset;
  BOOTSTRAP_TOKEN?: string;
  /** Required: missing or unknown deployment mode fails every tenant boundary closed. */
  DEPLOYMENT_MODE: DeploymentMode;
  /** Pins a customer-operated relay to one tenant and makes the tenant hostname-independent. */
  SELF_HOSTED_ORG?: string;
};

const app = new Hono<RelayAppEnv>();
app.get("/", (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.get("/assets/*", (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.use("/v1/*", requireIdentity);
mountA2A(app);
mountAudit(app);
mountInvites(app);
mountKeys(app);
mountPresence(app);
mountRecovery(app);

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
  const body = await jsonBody(c, RegisterRequest);
  if (!body) return c.json({ error: "invalid request" }, 400);
  const { invite, handle, agent_kind } = body;
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
      // agent_id is minted inside this batch rather than in a follow-up write
      // (#154, #319): the decision requires identity and address to be created
      // atomically, so a partial failure consumes neither the invite nor the
      // address and cannot leave an addressed handle with no identity.
      c.env.DB.prepare(
        "INSERT INTO handles (org, handle, token_hash, agent_kind, created_at, org_role, agent_id) " +
          "SELECT org, ?, ?, ?, ?, org_role, ? FROM invites " +
          "WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? " +
          "ON CONFLICT(org, handle) DO NOTHING",
      ).bind(handle, tokenHash, agent_kind ?? null, now, generateAgentId(), inviteHash, now),
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
  return c.json({ org, token });
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
  const { org } = identity;
  // Deliberately NOT routed through jsonBody: the `inv_stored_cards` gate
  // whitelists every direct parse of the card schema in the relay, and that is
  // how it proves uploads validate here while stored reads go through
  // parseStoredCard. Hiding this call behind a schema-generic helper would
  // erase it from that grep and leave the gate blind to the upload path.
  // (The gate greps for the schema name, so do not spell it out above.)
  const parsed = CardUpload.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid card" }, 400);
  const body = parsed.data;
  // The publisher's own identity, taken from the authenticated request rather
  // than resolved from its address (#154 slice 5).
  await c.env.DB.prepare(
    "INSERT INTO cards (org, agent_id, card_json, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(org, agent_id) DO UPDATE SET card_json = excluded.card_json, updated_at = excluded.updated_at",
  ).bind(org, identity.agentId, JSON.stringify(body), Date.now()).run();
  return c.json({ ok: true });
});

app.get("/v1/card/:handle", rateLimit(NATIVE_READ, "ip"), async (c) => {
  const identity = c.var.identity;
  const { org, handle: viewer } = identity;
  const handle = c.req.param("handle");
  // A missing identity and a missing card are the same 404: the address is
  // how a caller asks, but the card belongs to whoever holds that address now.
  const targetAgentId = await resolveAgentId(c.env.DB, org, handle);
  if (!targetAgentId) return c.json({ error: "no card" }, 404);
  const row = await c.env.DB.prepare("SELECT card_json, updated_at FROM cards WHERE org = ? AND agent_id = ?")
    .bind(org, targetAgentId).first<{ card_json: string; updated_at: number }>();
  if (!row) return c.json({ error: "no card" }, 404);

  const upload = parseStoredCard(row.card_json, org, handle);
  if (!upload) return c.json({ error: "no card" }, 404);
  return c.json({
    handle,
    description: upload.description,
    agent_kind: upload.agent_kind,
    tasks: visibleTasks(upload, viewer),
    offline_delivery: upload.offline_delivery,
    updated_at: row.updated_at,
  });
});

app.get("/v1/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
  const role = c.req.query("role");
  const identity = c.var.identity;
  const { org, handle } = identity;

  // The address is what the caller asked for and what gets displayed; the
  // agent id is what selects the object. They are tracked separately from
  // here down so neither is used for the other's job.
  let target: string;
  let targetAgentId: string;
  let mailboxEnabled = false;
  if (role === "listen") {
    target = handle;
    targetAgentId = identity.agentId;
  } else if (role === "call") {
    // A call socket is one opaque attempt, even when the target is offline or
    // unknown. Meter upgrades before target lookup so it cannot be used as a
    // free presence/namespace oracle.
    if (!(await checkLimit(c.env, `${org}:${handle}`, NATIVE_READ))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const to = c.req.query("to") ?? "";
    // Replaces the previous handleExists check: resolving the identity proves
    // existence and yields the object name in the same query, so the two
    // cannot disagree. Same 404 as before for an unknown handle.
    const resolved = await resolveAgentId(c.env.DB, org, to);
    if (!resolved) return c.json({ error: "unknown handle" }, 404);
    target = to;
    targetAgentId = resolved;
    const cardRow = await c.env.DB.prepare(
      "SELECT card_json FROM cards WHERE org = ? AND agent_id = ?",
    ).bind(org, targetAgentId).first<{ card_json: string }>();
    const targetCard = cardRow ? parseStoredCard(cardRow.card_json, org, target) : null;
    mailboxEnabled = targetCard?.offline_delivery.enabled === true;
  } else {
    return c.json({ error: "bad role" }, 400);
  }

  const stub = c.env.HANDLE_DO.get(
    c.env.HANDLE_DO.idFromName(identityObjectName({ org, agentId: targetAgentId })),
  );
  const doUrl = new URL("https://do/ws");
  doUrl.searchParams.set("role", role);
  doUrl.searchParams.set("test_timeout_ms", c.req.query("test_timeout_ms") ?? "");
  if (role === "listen") {
    const capability = c.req.query("capability");
    const listenerSessionId = c.req.query("listener_session_id");
    if (capability) doUrl.searchParams.set("capability", capability);
    if (listenerSessionId) doUrl.searchParams.set("listener_session_id", listenerSessionId);
  }
  const fwd = new Request(doUrl, c.req.raw);
  fwd.headers.set("X-Verified-From", handle);
  // The connecting party's stable identity. X-Verified-From stays the address
  // because the object echoes it into call records and audit, where the name
  // shown at the time is the point; this is what keys durable state.
  fwd.headers.set("X-Verified-Agent-Id", identity.agentId);
  fwd.headers.set("X-Verified-Target-Agent-Id", targetAgentId);
  fwd.headers.set("X-Verified-Mailbox-Enabled", mailboxEnabled ? "true" : "false");
  fwd.headers.set("X-Verified-Org", org);
  fwd.headers.set("X-Verified-Target", target);
  fwd.headers.set("X-Verified-Credential-Generation", String(identity.recoveryGeneration));
  fwd.headers.set("X-Verified-Relay-Origin", new URL(c.req.url).hostname);
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
