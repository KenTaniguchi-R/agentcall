import { Hono } from "hono";
import { RegisterRequest, RESERVED_HANDLES } from "@agentcall/shared";
import { generateToken, sha256Hex } from "./auth.js";

export { HandleDO } from "./do.js";

export type Env = { DB: D1Database; HANDLE_DO: DurableObjectNamespace };
export const RELAY_HOST = "agentcall.benree.tech";

const app = new Hono<{ Bindings: Env }>();

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

export default app;
