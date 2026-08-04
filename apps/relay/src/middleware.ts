import { createMiddleware } from "hono/factory";
import type { Env } from "./index.js";
import { authenticateRequest, type Identity } from "./tenant.js";
import { checkLimit, type RateLimitPolicy } from "./ratelimit/index.js";

export type RelayAppEnv = { Bindings: Env; Variables: { identity: Identity } };

// These endpoints authenticate with their own credential or capability. Keep
// the list explicit: a newly added /v1 route is authenticated by default.
const PUBLIC_V1_PATHS = new Set([
  "/v1/register",
  "/v1/admin/invite",
  "/v1/recovery/redeem",
  "/v1/rooms",
  "/v1/rooms/join",
  "/v1/room",
  "/v1/room/ws",
]);

function isPublicV1Path(path: string): boolean {
  // A2A owns its version negotiation and application/a2a+json error contract;
  // its handlers retain the same authentication boundary until migration.
  // Room capabilities have these explicitly mounted route shapes. Keep this
  // explicit so a future /v1/room/* route cannot silently bypass identity.
  if (path === "/v1/room" || path === "/v1/room/ws" || /^\/v1\/room\/(?:admit|deny|lock|confirm|reject|pause|resume|leave|heartbeat)$/.test(path)) {
    return true;
  }
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
