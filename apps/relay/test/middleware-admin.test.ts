import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

// Every /v1/audit/* and /v1/invites/* route below is admin-only, enforced by
// the requireAdmin middleware (apps/relay/src/middleware.ts) rather than a
// hand-copied check inside each handler. This list is the durable version of
// that guarantee: a new admin-only route that forgets requireAdmin fails this
// test with something other than 403 — most likely a 200 leaking data, or a
// 400/404 from handler logic that ran before any admin check — instead of
// silently shipping unguarded.
const ADMIN_ONLY_ROUTES: { method: string; path: string }[] = [
  { method: "GET", path: "/v1/audit/retention-readiness" },
  { method: "GET", path: "/v1/audit/retention-policy" },
  { method: "PUT", path: "/v1/audit/retention-policy" },
  { method: "GET", path: "/v1/audit/legal-holds" },
  { method: "GET", path: "/v1/audit/legal-holds/hold_test" },
  { method: "POST", path: "/v1/audit/legal-holds" },
  { method: "POST", path: "/v1/audit/legal-holds/hold_test/release" },
  { method: "GET", path: "/v1/audit/events" },
  { method: "POST", path: "/v1/audit/export-acknowledgements" },
  { method: "POST", path: "/v1/invites" },
  { method: "POST", path: "/v1/invites/list" },
  { method: "POST", path: "/v1/invites/some-id/revoke" },
];

describe("admin-only route enforcement", () => {
  it("rejects a non-admin identity on every admin-only route with a byte-identical 403", async () => {
    const token = await registerHandle("member-of-many", "claude", "admin-gate-org", "member");
    for (const { method, path } of ADMIN_ONLY_ROUTES) {
      const response = await SELF.fetch(`https://relay.test${path}`, {
        method,
        headers: { ...wsAuth("member-of-many", token, "admin-gate-org"), "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json(), `${method} ${path}`).toEqual({ error: "administrator role required" });
    }
  });
});
