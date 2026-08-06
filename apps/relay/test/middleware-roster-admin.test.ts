import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

// Every route below authenticates with the roster's admin secret rather than
// the caller's org role, so requireAdmin does not cover them. This list is the
// durable version of that guarantee, mirroring middleware-admin.test.ts: a new
// /v1/roster/:id/* admin route that forgets requireRosterAdmin fails this test
// with something other than a byte-identical 404 — most likely a 200 acting on
// an unauthenticated request — instead of silently shipping unguarded.
//
// The bodies are schema-valid apart from the secret. That matters: it forces
// the 404 to come from the admin check rather than from jsonBody rejecting a
// malformed body, which would produce the same status for the wrong reason.
const ROSTER_ADMIN_ROUTES: { path: (id: string) => string; body: (secret: string) => unknown }[] = [
  { path: (id) => `/v1/roster/${id}/audit-budget/reset`, body: (s) => ({ admin_secret: s }) },
  { path: (id) => `/v1/roster/${id}/expel`, body: (s) => ({ admin_secret: s, handle: "somebody" }) },
  { path: (id) => `/v1/roster/${id}/keys`, body: (s) => ({ admin_secret: s, description: "d" }) },
  { path: (id) => `/v1/roster/${id}/keys/list`, body: (s) => ({ admin_secret: s }) },
  {
    path: (id) => `/v1/roster/${id}/keys/${"a".repeat(12)}/revoke`,
    body: (s) => ({ admin_secret: s, prefix: "a".repeat(12) }),
  },
  { path: (id) => `/v1/roster/${id}/delete`, body: (s) => ({ admin_secret: s }) },
];

// One shared body for "unknown roster" and "wrong secret" (roster.ts:101-103).
// Asserted as a whole object, not just the status: a distinct body for either
// case turns roster ids into an enumerable namespace even at the same status.
const NOT_FOUND = { error: "not found" };

async function createRoster(handle: string, org = "acme") {
  const token = await registerHandle(handle, "claude", org);
  const res = await SELF.fetch(new Request("https://relay.test/v1/roster", {
    method: "POST",
    headers: { "cf-connecting-ip": `create-${handle}`, ...wsAuth(handle, token, org) },
  }));
  expect(res.status).toBe(200);
  return { token, org, handle, ...(await res.json<{ roster_id: string; admin_secret: string }>()) };
}

// Distinct per handle so the per-(org, roster) ROSTER_WRITE budget of 10 is
// spent on the routes under test, not on IP collisions between them.
async function post(roster: { org: string; handle: string; token: string }, path: string, body: unknown) {
  return SELF.fetch(new Request(`https://relay.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `admin-gate-${roster.handle}`,
      ...wsAuth(roster.handle, roster.token, roster.org),
    },
    body: JSON.stringify(body),
    cf: { country: "US" },
  }));
}

describe("roster admin-secret route enforcement", () => {
  it("rejects a wrong admin secret on every roster admin route with a byte-identical 404", async () => {
    const roster = await createRoster("wrong-secret-caller");
    for (const route of ROSTER_ADMIN_ROUTES) {
      const path = route.path(roster.roster_id);
      const response = await post(roster, path, route.body("not-the-admin-secret"));
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual(NOT_FOUND);
    }
  });

  it("rejects an absent admin secret on every roster admin route with the same 404", async () => {
    const roster = await createRoster("absent-secret-caller");
    for (const route of ROSTER_ADMIN_ROUTES) {
      const path = route.path(roster.roster_id);
      const response = await post(roster, path, {});
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual(NOT_FOUND);
    }
  });

  // The enumeration property, stated as an equality rather than as two separate
  // expectations: a wrong secret on a roster that exists must be indistinguishable
  // from the correct secret on one that does not.
  it("answers a wrong secret and an unknown roster identically", async () => {
    const roster = await createRoster("indistinguishable-caller");
    const unknownId = "z".repeat(22);

    for (const route of ROSTER_ADMIN_ROUTES) {
      const wrongSecret = await post(roster, route.path(roster.roster_id), route.body("wrong"));
      const unknownRoster = await post(roster, route.path(unknownId), route.body(roster.admin_secret));

      expect(wrongSecret.status, route.path(roster.roster_id)).toBe(unknownRoster.status);
      expect(await wrongSecret.json(), route.path(roster.roster_id))
        .toEqual(await unknownRoster.json());
    }
  });

  // The admin secret is not a bearer token that travels between orgs. Holding a
  // valid secret for a roster in another org must not admit you to this one —
  // the org comparison is a separate check from the secret comparison, and this
  // is what fails if a refactor keeps one and drops the other.
  it("rejects a valid admin secret presented from a different org", async () => {
    const owner = await createRoster("cross-org-owner", "org-alpha");
    const outsider = await registerHandle("cross-org-outsider", "claude", "org-beta");

    for (const route of ROSTER_ADMIN_ROUTES) {
      const path = route.path(owner.roster_id);
      const response = await SELF.fetch(new Request(`https://relay.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "admin-gate-cross-org",
          ...wsAuth("cross-org-outsider", outsider, "org-beta"),
        },
        body: JSON.stringify(route.body(owner.admin_secret)),
        cf: { country: "US" },
      }));
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual(NOT_FOUND);
    }
  });

  // Guards the other direction: the gate must not reject everything. Without
  // this, deleting the roster lookup entirely would still pass the four tests
  // above.
  it("admits the correct admin secret", async () => {
    const roster = await createRoster("correct-secret-caller");
    const response = await post(
      roster, `/v1/roster/${roster.roster_id}/keys/list`, { admin_secret: roster.admin_secret },
    );
    expect(response.status).toBe(200);
    expect(await response.json<{ keys: unknown[] }>()).toHaveProperty("keys");
  });
});
