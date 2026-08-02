import { Hono } from "hono";
import { BootstrapInviteRequest, CardUpload, RegisterRequest, visibleTasks } from "@benree/agentcall-shared";
import { mountA2A } from "./a2a.js";
import { mountRoster } from "./roster.js";
import { constantTimeEqual, generateToken, sha256Hex } from "./auth.js";
import { authenticateRequest, identityKey, registrationAddressHost } from "./tenant.js";
import { sharedRosterIds } from "./groups.js";
import { checkLimit, NATIVE_CARD, NATIVE_READ, REGISTER, type RateLimitEnv } from "./ratelimit/index.js";

export { HandleDO } from "./do.js";
export { RateLimiterDO } from "./ratelimit/do.js";

export type Env = RateLimitEnv & {
  DB: D1Database;
  HANDLE_DO: DurableObjectNamespace;
  BOOTSTRAP_TOKEN?: string;
};
const app = new Hono<{ Bindings: Env }>();
mountA2A(app);
mountRoster(app);

async function handleExists(db: D1Database, org: string, handle: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM handles WHERE org = ? AND handle = ?").bind(org, handle).first());
}

app.post("/v1/register", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await checkLimit(c.env, ip, REGISTER))) return c.json({ error: "rate limited" }, 429);
  const body = RegisterRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request" }, 400);
  const { invite, handle, agent_kind } = body.data;
  const inviteHash = await sha256Hex(invite);
  const inviteRow = await c.env.DB.prepare(
    "SELECT org FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  ).bind(inviteHash, Date.now()).first<{ org: string }>();
  if (!inviteRow) return c.json({ error: "invalid invite" }, 404);
  const org = inviteRow.org;
  const token = generateToken();
  try {
    const now = Date.now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO handles (org, handle, token_hash, agent_kind, created_at) " +
          "SELECT org, ?, ?, ?, ? FROM invites " +
          "WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
      ).bind(handle, await sha256Hex(token), agent_kind ?? null, now, inviteHash, now),
      c.env.DB.prepare(
        "UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL",
      ).bind(now, handle, inviteHash),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) return c.json({ error: "invalid invite" }, 404);
  } catch {
    return c.json({ error: "handle taken" }, 409);
  }
  return c.json({ org, token, address: `${handle}@${registrationAddressHost(org, c.req.url)}` });
});

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function createOrgInvite(db: D1Database, org: string, createdBy: string | null) {
  const invite = generateToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  await db.prepare(
    "INSERT INTO invites (token_hash, org, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256Hex(invite), org, createdBy, now, expiresAt).run();
  return { invite, expires_at: expiresAt };
}

app.post("/v1/admin/invite", async (c) => {
  // Disabled by default. Relay operators enable initial tenant provisioning
  // with `wrangler secret put BOOTSTRAP_TOKEN`; the secret never enters D1.
  const configured = c.env.BOOTSTRAP_TOKEN;
  if (!configured) return c.notFound();
  const supplied = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const [expectedHash, suppliedHash] = await Promise.all([sha256Hex(configured), sha256Hex(supplied)]);
  if (!constantTimeEqual(expectedHash, suppliedHash)) return c.json({ error: "unauthorized" }, 401);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await checkLimit(c.env, `bootstrap:${ip}`, REGISTER))) {
    return c.json({ error: "rate limited" }, 429);
  }
  const body = BootstrapInviteRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request" }, 400);
  return c.json(await createOrgInvite(c.env.DB, body.data.org, null));
});

app.post("/v1/invite", async (c) => {
  const identity = await authenticateRequest(c.env.DB, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const { org, handle } = identity;
  if (!(await checkLimit(c.env, `invite:${org}:${handle}`, REGISTER))) {
    return c.json({ error: "rate limited" }, 429);
  }
  return c.json(await createOrgInvite(c.env.DB, org, handle));
});

// Presence is caller-only. Anonymous, this endpoint was an oracle: 404-vs-200
// enumerated registered handles (the namespace is first-name shaped, so a name
// dictionary walks it in seconds) and polling `online` gave anyone a live "is
// this person at their desk" feed. Placing a call already requires a token, so
// requiring one to observe presence costs a legitimate caller nothing.
//
// Auth runs before the existence check — deliberately. A 404 to an
// unauthenticated prober would still answer "does this handle exist?" without
// any credential, which is most of what the oracle was worth.
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
app.post("/v1/token/rotate", async (c) => {
  const identity = await authenticateRequest(c.env.DB, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const { org, handle } = identity;
  if (!(await checkLimit(c.env, `rotate:${org}:${handle}`, REGISTER))) {
    return c.json({ error: "rate limited" }, 429);
  }
  const next = generateToken();
  // UPDATE, never INSERT: an unregistered handle can't reach here (it fails
  // the auth check above), so this must not be able to conjure a row.
  await c.env.DB.prepare("UPDATE handles SET token_hash = ? WHERE org = ? AND handle = ?")
    .bind(await sha256Hex(next), org, handle).run();
  return c.json({ token: next });
});

app.get("/v1/status/:handle", async (c) => {
  const identity = await authenticateRequest(c.env.DB, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const { org } = identity;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await checkLimit(c.env, ip, NATIVE_READ))) return c.json({ error: "rate limited" }, 429);
  const handle = c.req.param("handle");
  if (!(await handleExists(c.env.DB, org, handle))) return c.json({ error: "unknown handle" }, 404);
  const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(identityKey(org, handle)));
  return stub.fetch("https://do/status");
});

app.put("/v1/card", async (c) => {
  const identity = await authenticateRequest(c.env.DB, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const { org, handle } = identity;
  if (!(await checkLimit(c.env, `${org}:${handle}`, NATIVE_CARD))) return c.json({ error: "rate limited" }, 429);
  const body = CardUpload.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid card" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(org, handle) DO UPDATE SET card_json = excluded.card_json, updated_at = excluded.updated_at",
  ).bind(org, handle, JSON.stringify(body.data), Date.now()).run();
  return c.json({ ok: true });
});

app.get("/v1/card/:handle", async (c) => {
  const identity = await authenticateRequest(c.env.DB, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const { org, handle: viewer } = identity;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await checkLimit(c.env, ip, NATIVE_READ))) return c.json({ error: "rate limited" }, 429);
  const handle = c.req.param("handle");
  const row = await c.env.DB.prepare("SELECT card_json, updated_at FROM cards WHERE org = ? AND handle = ?")
    .bind(org, handle).first<{ card_json: string; updated_at: number }>();
  if (!row) return c.json({ error: "no card" }, 404);

  const upload = CardUpload.parse(JSON.parse(row.card_json));
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
  const identity = await authenticateRequest(c.env.DB, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const { org, handle } = identity;

  let target: string;
  let groups: string[] = [];
  if (role === "listen") {
    target = handle;
  } else if (role === "call") {
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
  fwd.headers.set("X-Verified-Groups", JSON.stringify(groups));
  return stub.fetch(fwd);
});

export default app;
