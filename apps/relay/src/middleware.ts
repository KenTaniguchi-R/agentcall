import { createMiddleware } from "hono/factory";
import type { Env } from "./index.js";
import { authenticateRequest, requireOrgAdmin, type Identity } from "./tenant.js";
import { checkLimit, type RateLimitPolicy } from "./ratelimit/index.js";

export type RelayAppEnv = { Bindings: Env; Variables: { identity: Identity } };

// These endpoints authenticate with their own credential or capability. Keep
// the list explicit: a newly added /v1 route is authenticated by default.
const PUBLIC_V1_PATHS = new Set([
  "/v1/register",
  "/v1/admin/invite",
  "/v1/recovery/redeem",
]);

function isPublicV1Path(path: string): boolean {
  // A2A owns its version negotiation and application/a2a+json error contract;
  // its handlers retain the same authentication boundary until migration.
  // A2A owns its authentication/error contract until its final migration.
  // Match only the routes mounted today; new A2A routes authenticate by
  // default until they are deliberately added here.
  return PUBLIC_V1_PATHS.has(path)
    || /^\/v1\/a2a\/[^/]+\/agent-card\.json$/.test(path)
    || /^\/v1\/a2a\/[^/]+\/tasks(?:\/[^/]+)?$/.test(path);
}

export const requireIdentity = createMiddleware<RelayAppEnv>(async (c, next) => {
  if (isPublicV1Path(c.req.path)) return next();
  const identity = await authenticateRequest(c.env, c.req);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  c.set("identity", identity);
  await next();
});

// Admin-gating an endpoint used to mean pasting this check into the handler
// by hand — every audit and invite route did, 12 times, byte-identical. That
// makes "admin-only" a property of whoever wrote the handler remembering to
// paste it, not a property of the route. A new route that forgets the line
// ships unguarded and nothing catches it. Routing it through middleware
// instead makes admin-gating a property of the route table: a route either
// lists requireAdmin in its chain or it doesn't, and that's visible at the
// call site rather than buried in handler logic. Depends on requireIdentity
// having already set c.var.identity.
export const requireAdmin = createMiddleware<RelayAppEnv>(async (c, next) => {
  if (!requireOrgAdmin(c.var.identity)) return c.json({ error: "administrator role required" }, 403);
  await next();
});

// Reading a JSON body has one fragile part: `c.req.json()` REJECTS on a
// malformed body, so the `.catch(() => null)` is what keeps a truncated POST
// from surfacing as a 500 instead of the route's own 400/404. Seventeen
// handlers wrote that chain out by hand, which is seventeen chances to drop
// the catch. Returning undefined rather than a Response leaves each route
// owning its own rejection status and body — roster answers 404 to keep
// roster ids unenumerable, audit answers 400 — which is a real difference
// this helper must not flatten.
// `overrides` is for routes that take a field from the URL path rather than
// the body — the override wins, so a body that also carries the field cannot
// contradict the path. Passing none leaves the parsed value untouched, so a
// non-object body still reaches the schema and is rejected by it.
export async function jsonBody<T>(
  c: { req: { json(): Promise<unknown> } },
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  overrides?: Record<string, unknown>,
): Promise<T | undefined> {
  const raw = await c.req.json().catch(() => null);
  const value = overrides
    ? { ...(typeof raw === "object" && raw ? raw : {}), ...overrides }
    : raw;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function rateLimit(
  policy: RateLimitPolicy,
  keyBy: "ip" | "identity" | ((c: any) => string),
  prefix = "",
  onLimited?: (c: any) => Response,
) {
  return createMiddleware<RelayAppEnv>(async (c, next) => {
    const key = typeof keyBy === "function" ? keyBy(c) : keyBy === "ip"
      ? c.req.header("cf-connecting-ip") ?? "unknown"
      : (() => {
          const identity = c.var.identity;
          return `${prefix}${identity.org}:${identity.handle}`;
        })();
    if (!(await checkLimit(c.env, key, policy))) return onLimited?.(c) ?? c.json({ error: "rate limited" }, 429);
    await next();
  });
}
