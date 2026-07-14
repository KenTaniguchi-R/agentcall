import { Hono } from "hono";
import { RegisterRequest, RESERVED_HANDLES } from "@benree/agentcall-shared";
import { generateToken, sha256Hex, verifyHandleToken } from "./auth.js";
import { INSTALL_SH } from "./install-sh.js";

export { HandleDO } from "./do.js";

export type Env = { DB: D1Database; HANDLE_DO: DurableObjectNamespace };
export const RELAY_HOST = "agentcall.benree.tech";

const app = new Hono<{ Bindings: Env }>();

async function handleExists(db: D1Database, handle: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM handles WHERE handle = ?").bind(handle).first());
}

app.get("/install.sh", (c) => c.text(INSTALL_SH, 200, { "content-type": "text/x-shellscript; charset=utf-8" }));

app.post("/v1/register", async (c) => {
  const body = RegisterRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request" }, 400);
  const { handle, agent_kind } = body.data;
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) return c.json({ error: "handle reserved" }, 400);
  const token = generateToken();
  try {
    await c.env.DB.prepare(
      "INSERT INTO handles (handle, token_hash, agent_kind, created_at) VALUES (?, ?, ?, ?)",
    ).bind(handle, await sha256Hex(token), agent_kind, Date.now()).run();
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
