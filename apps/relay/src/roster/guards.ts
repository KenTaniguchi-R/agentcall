import type { Context } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "../index.js";
import { constantTimeEqual, sha256Hex, verifyHandleToken } from "../auth.js";
import { ROSTER_ID_RE } from "@benree/agentcall-shared";

// ONE body and ONE header set for every "you may not see this" outcome:
// unknown roster, wrong secret, and non-member are indistinguishable. A
// distinct response for any of them turns roster ids into an enumerable
// namespace. Constructed fresh per call because a Response body can only be
// read once, but always from these same values.
export function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

// Hashes the supplied value even when there is no stored hash, so a missing
// roster and a wrong secret cost the same. Never log either argument.
export async function secretMatches(supplied: string, hash: string | null): Promise<boolean> {
  const digest = await sha256Hex(supplied);
  if (!hash) return false;
  return constantTimeEqual(hash, digest);
}

// The floor for every roster route: possession of a handle token proves who
// you are, not what you may see. Registration is open, so membership or a
// secret is what actually authorizes. Split out from requireRoster because
// POST /v1/roster has no :id to shape-check and rate-limits on REGISTER_RL.
export async function requireHandle(c: Context<{ Bindings: Env }>): Promise<string | Response> {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return handle;
}

// Every roster route with an :id starts here. Order matters: auth, then id
// shape, then rate limit, and only then anything that touches roster rows.
// Rate limiting before any existence-dependent query is what keeps a 429
// from distinguishing a real roster id from a fabricated one.
export async function requireRoster(
  c: Context<{ Bindings: Env }>,
  op: string,
): Promise<{ handle: string; id: string } | Response> {
  const handle = await requireHandle(c);
  if (handle instanceof Response) return handle;

  const id = c.req.param("id");
  // Not just a type narrowing: a route mounted without a literal `:id`
  // segment reaches here with undefined, and a cast would hand it to a D1
  // bind() as the string "undefined". Fail the same way a malformed id does.
  // Shape-check before touching D1: a malformed id can never match a row.
  if (!id || !ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.ROSTER_RL.limit({ key: `${op}:${ip}:${id}` })).success) {
    return c.json({ error: "rate limited" }, 429);
  }

  return { handle, id };
}

// Membership is the real authorization for reads. Checked BEFORE anything
// reveals that the roster exists, and a non-member gets exactly what an
// unknown roster gets.
export async function requireMember(
  c: Context<{ Bindings: Env }>,
  id: string,
  handle: string,
): Promise<Response | null> {
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
  ).bind(id, handle).first();
  return member ? null : notFound();
}
