import { Hono } from "hono";
import { CardUpload, RegisterRequest, RESERVED_HANDLES } from "@benree/agentcall-shared";
import { generateToken, sha256Hex, verifyHandleToken } from "./auth.js";
import { INSTALL_SH } from "./install-sh.js";

export { HandleDO } from "./do.js";

export type Env = {
  DB: D1Database;
  HANDLE_DO: DurableObjectNamespace;
  REGISTER_RL: RateLimit;
  CARD_RL: RateLimit;
};
// Not exported: workerd treats every named export of the entry module as a
// potential WorkerEntrypoint and rejects non-handler values outright
// ("Incorrect type for map entry 'RELAY_HOST'"), killing the worker at
// startup under current wrangler/workerd. Nothing outside this file uses it.
const RELAY_HOST = "agentcall.benree.tech";

const app = new Hono<{ Bindings: Env }>();

async function handleExists(db: D1Database, handle: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM handles WHERE handle = ?").bind(handle).first());
}

app.get("/install.sh", (c) => c.text(INSTALL_SH, 200, { "content-type": "text/x-shellscript; charset=utf-8" }));

app.post("/v1/register", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.REGISTER_RL.limit({ key: ip })).success) return c.json({ error: "rate limited" }, 429);
  const body = RegisterRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request" }, 400);
  const { handle, agent_kind } = body.data;
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) return c.json({ error: "handle reserved" }, 400);
  const token = generateToken();
  try {
    await c.env.DB.prepare(
      "INSERT INTO handles (handle, token_hash, agent_kind, created_at) VALUES (?, ?, ?, ?)",
    ).bind(handle, await sha256Hex(token), agent_kind ?? null, Date.now()).run();
  } catch {
    return c.json({ error: "handle taken" }, 409);
  }
  return c.json({ token, address: `${handle}@${RELAY_HOST}` });
});

app.get("/v1/status/:handle", async (c) => {
  const handle = c.req.param("handle");
  if (!(await handleExists(c.env.DB, handle))) return c.json({ error: "unknown handle" }, 404);
  const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(handle));
  return stub.fetch("https://do/status");
});

app.put("/v1/card", async (c) => {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
  if (!(await c.env.CARD_RL.limit({ key: handle })).success) return c.json({ error: "rate limited" }, 429);
  const body = CardUpload.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid card" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO cards (handle, card_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(handle) DO UPDATE SET card_json = excluded.card_json, updated_at = excluded.updated_at",
  ).bind(handle, JSON.stringify(body.data), Date.now()).run();
  return c.json({ ok: true });
});

app.get("/v1/card/:handle", async (c) => {
  const handle = c.req.param("handle");
  const row = await c.env.DB.prepare("SELECT card_json, updated_at FROM cards WHERE handle = ?")
    .bind(handle).first<{ card_json: string; updated_at: number }>();
  if (!row) return c.json({ error: "no card" }, 404);

  // Optional caller auth selects the extended view (A2A "extended agent
  // card" pattern): the viewer sees default_offer plus their own grants,
  // never the full ACL. Present-but-invalid credentials are rejected
  // rather than silently downgraded to the public view.
  let viewer = "";
  const viewerHandle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (viewerHandle || token) {
    if (!(await verifyHandleToken(c.env.DB, viewerHandle, token))) return c.json({ error: "unauthorized" }, 401);
    viewer = viewerHandle;
  }

  const upload = CardUpload.parse(JSON.parse(row.card_json));
  const visible = new Set([...upload.default_offer, ...(viewer ? (upload.grants[viewer] ?? []) : [])]);
  return c.json({
    handle,
    description: upload.description,
    agent_kind: upload.agent_kind,
    tasks: upload.tasks.filter((t) => visible.has(t.id)),
    updated_at: row.updated_at,
  });
});

app.get("/v1/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
  const role = c.req.query("role");
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);

  let target: string;
  if (role === "listen") {
    target = handle;
  } else if (role === "call") {
    const to = c.req.query("to") ?? "";
    if (!(await handleExists(c.env.DB, to))) return c.json({ error: "unknown handle" }, 404);
    target = to;
  } else {
    return c.json({ error: "bad role" }, 400);
  }

  const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(target));
  const fwd = new Request(`https://do/ws?role=${role}&test_timeout_ms=${c.req.query("test_timeout_ms") ?? ""}`, c.req.raw);
  fwd.headers.set("X-Verified-From", handle);
  return stub.fetch(fwd);
});

export default app;
