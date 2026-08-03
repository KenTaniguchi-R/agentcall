import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const POLICY = "https://relay.test/v1/audit/retention-policy";
const HOLDS = "https://relay.test/v1/audit/legal-holds";

async function admin(org: string, handle = `${org}-admin`) {
  const token = await registerHandle(handle, "claude", org, "admin");
  return wsAuth(handle, token, org);
}

async function json(response: Response) {
  return response.json<any>();
}

describe("audit retention control plane", () => {
  it("returns the documented default without creating mutable tenant state", async () => {
    const headers = await admin("ret-default");
    const response = await SELF.fetch(POLICY, { headers });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      event_retention_days: 400,
      version: 0,
      updated_by: null,
      updated_at: null,
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_retention_policies WHERE org = ?",
    ).bind("ret-default").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("denies members and cross-tenant credentials on every control surface", async () => {
    const org = "ret-auth";
    const memberToken = await registerHandle("ret-member", "claude", org, "member");
    const member = wsAuth("ret-member", memberToken, org);
    const foreign = wsAuth("ret-member", memberToken, "another-org");
    const mutation = {
      method: "PUT",
      headers: { ...member, "content-type": "application/json" },
      body: JSON.stringify({ event_retention_days: 365, expected_version: 0, request_id: "a".repeat(32) }),
    };
    expect((await SELF.fetch(POLICY, { headers: member })).status).toBe(403);
    expect((await SELF.fetch(POLICY, mutation)).status).toBe(403);
    expect((await SELF.fetch(HOLDS, {
      method: "POST", headers: { ...member, "content-type": "application/json" },
      body: JSON.stringify({ reason: "investigation", request_id: "b".repeat(32) }),
    })).status).toBe(403);
    const validHoldId = `hold_${"c".repeat(32)}`;
    expect((await SELF.fetch(HOLDS, { headers: member })).status).toBe(403);
    expect((await SELF.fetch(`${HOLDS}/${validHoldId}`, { headers: member })).status).toBe(403);
    expect((await SELF.fetch(`${HOLDS}/${validHoldId}/release`, {
      method: "POST", headers: { ...member, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "d".repeat(32) }),
    })).status).toBe(403);
    expect((await SELF.fetch(POLICY, { headers: foreign })).status).toBe(401);
  });

  it("updates a bounded versioned policy idempotently and audits exactly once", async () => {
    const org = "ret-policy";
    const headers = await admin(org);
    const request = { event_retention_days: 365, expected_version: 0, request_id: "c".repeat(32) };
    const init = {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(request),
    };
    const first = await SELF.fetch(POLICY, init);
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody).toMatchObject({
      event_retention_days: 365, version: 1, updated_by: `${org}-admin`, updated_at: expect.any(Number),
    });
    const repeated = await SELF.fetch(POLICY, init);
    expect(repeated.status).toBe(200);
    expect(await json(repeated)).toEqual(firstBody);

    const conflict = await SELF.fetch(POLICY, {
      ...init,
      body: JSON.stringify({ ...request, event_retention_days: 366 }),
    });
    expect(conflict.status).toBe(409);
    const stale = await SELF.fetch(POLICY, {
      ...init,
      body: JSON.stringify({ ...request, request_id: "d".repeat(32) }),
    });
    expect(stale.status).toBe(409);

    const stored = await env.DB.prepare(
      "SELECT event_retention_days, version, updated_by FROM audit_retention_policies WHERE org = ?",
    ).bind(org).first();
    expect(stored).toEqual({ event_retention_days: 365, version: 1, updated_by: `${org}-admin` });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE org = ? AND event = 'audit.retention.update'",
    ).bind(org).first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("enforces retention bounds in both the API and D1 schema", async () => {
    const org = "ret-bounds";
    const headers = await admin(org);
    for (const [days, requestId] of [[29, "e".repeat(32)], [2_556, "f".repeat(32)]]) {
      expect((await SELF.fetch(POLICY, {
        method: "PUT", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ event_retention_days: days, expected_version: 0, request_id: requestId }),
      })).status).toBe(400);
    }
    await expect(env.DB.prepare(
      "INSERT INTO audit_retention_policies " +
      "(org, event_retention_days, version, updated_by, updated_at, last_request_id) VALUES (?, ?, 1, ?, 1, ?)",
    ).bind(org, 29, "admin", "g".repeat(32)).run()).rejects.toThrow();
  });

  it("rolls policy state back when its audit evidence cannot be written", async () => {
    const org = "ret-atomic";
    const headers = await admin(org);
    await env.DB.prepare(
      "CREATE TRIGGER fail_retention_audit BEFORE INSERT ON org_events " +
      "WHEN NEW.event = 'audit.retention.update' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    ).run();
    const response = await SELF.fetch(POLICY, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ event_retention_days: 365, expected_version: 0, request_id: "h".repeat(32) }),
    });
    expect(response.status).toBe(503);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_retention_policies WHERE org = ?",
    ).bind(org).first<{ n: number }>()).toEqual({ n: 0 });
    await env.DB.prepare("DROP TRIGGER fail_retention_audit").run();
  });

  it("creates and releases one tenant hold idempotently without reactivation", async () => {
    const org = "ret-hold";
    const headers = await admin(org);
    const createRequest = { reason: "Preserve evidence for incident 42", request_id: "i".repeat(32) };
    const create = {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(createRequest),
    };
    const first = await SELF.fetch(HOLDS, create);
    expect(first.status).toBe(201);
    const created = await json(first);
    expect(created).toMatchObject({
      hold_id: expect.stringMatching(/^hold_[a-f0-9]{32}$/),
      reason: createRequest.reason,
      created_by: `${org}-admin`,
      created_at: expect.any(Number),
      released_by: null,
      released_at: null,
    });
    const repeated = await SELF.fetch(HOLDS, create);
    expect(repeated.status).toBe(200);
    expect(await json(repeated)).toEqual(created);
    expect((await SELF.fetch(HOLDS, { ...create, body: JSON.stringify({ ...createRequest, reason: "changed" }) })).status)
      .toBe(409);
    expect((await SELF.fetch(HOLDS, {
      ...create, body: JSON.stringify({ reason: "second active hold", request_id: "j".repeat(32) }),
    })).status).toBe(409);

    const active = await SELF.fetch(HOLDS, { headers });
    expect(active.status).toBe(200);
    expect(await json(active)).toEqual({ active_hold: created });

    const releaseRequest = { request_id: "k".repeat(32) };
    const releaseUrl = `${HOLDS}/${created.hold_id}/release`;
    const release = {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(releaseRequest),
    };
    const releasedResponse = await SELF.fetch(releaseUrl, release);
    expect(releasedResponse.status).toBe(200);
    const released = await json(releasedResponse);
    expect(released).toMatchObject({
      ...created, released_by: `${org}-admin`, released_at: expect.any(Number),
    });
    expect(await json(await SELF.fetch(releaseUrl, release))).toEqual(released);
    expect((await SELF.fetch(releaseUrl, {
      ...release, body: JSON.stringify({ request_id: "l".repeat(32) }),
    })).status).toBe(409);
    expect(await json(await SELF.fetch(HOLDS, { headers }))).toEqual({ active_hold: null });
    expect(await json(await SELF.fetch(`${HOLDS}/${created.hold_id}`, { headers }))).toEqual(released);

    const replayCreate = await SELF.fetch(HOLDS, create);
    expect(replayCreate.status).toBe(200);
    expect(await json(replayCreate)).toEqual(released);

    const nextHoldResponse = await SELF.fetch(HOLDS, {
      ...create,
      body: JSON.stringify({ reason: "A later incident", request_id: "t".repeat(32) }),
    });
    expect(nextHoldResponse.status).toBe(201);
    const nextHold = await json(nextHoldResponse);
    expect((await SELF.fetch(`${HOLDS}/${nextHold.hold_id}/release`, release)).status).toBe(409);
    expect(await json(await SELF.fetch(HOLDS, { headers }))).toEqual({ active_hold: nextHold });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE org = ? AND event IN ('audit.hold.create', 'audit.hold.release')",
    ).bind(org).first<{ n: number }>()).toEqual({ n: 3 });
  });

  it("has one atomic winner for concurrent policy and hold mutations", async () => {
    const org = "ret-race";
    const headers = await admin(org);
    const policyResponses = await Promise.all([
      [365, "q".repeat(32)],
      [366, "r".repeat(32)],
    ].map(([event_retention_days, request_id]) => SELF.fetch(POLICY, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ event_retention_days, expected_version: 0, request_id }),
    })));
    expect(policyResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE org = ? AND event = 'audit.retention.update'",
    ).bind(org).first<{ n: number }>()).toEqual({ n: 1 });

    const holdRequest = { reason: "Concurrent incident hold", request_id: "s".repeat(32) };
    const holdResponses = await Promise.all([0, 1].map(() => SELF.fetch(HOLDS, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(holdRequest),
    })));
    expect(holdResponses.map((response) => response.status).sort()).toEqual([200, 201]);
    const holdBodies = await Promise.all(holdResponses.map(json));
    expect(holdBodies[0]).toEqual(holdBodies[1]);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE org = ? AND event = 'audit.hold.create'",
    ).bind(org).first<{ n: number }>()).toEqual({ n: 1 });

    const conflictOrg = "ret-race-key";
    const conflictHeaders = await admin(conflictOrg);
    const sharedRequestId = "u".repeat(32);
    const conflictingResponses = await Promise.all([365, 366].map((event_retention_days) => SELF.fetch(POLICY, {
      method: "PUT", headers: { ...conflictHeaders, "content-type": "application/json" },
      body: JSON.stringify({ event_retention_days, expected_version: 0, request_id: sharedRequestId }),
    })));
    expect(conflictingResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_events WHERE org = ? AND event = 'audit.retention.update'",
    ).bind(conflictOrg).first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("keeps holds tenant-bound and rolls back when hold audit evidence fails", async () => {
    const org = "ret-hold-atomic";
    const headers = await admin(org);
    await env.DB.prepare(
      "CREATE TRIGGER fail_hold_create_audit BEFORE INSERT ON org_events " +
      "WHEN NEW.event = 'audit.hold.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    ).run();
    const createBody = { reason: "Preserve incident evidence", request_id: "m".repeat(32) };
    const failedCreate = await SELF.fetch(HOLDS, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(failedCreate.status).toBe(503);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_legal_holds WHERE org = ?",
    ).bind(org).first<{ n: number }>()).toEqual({ n: 0 });
    await env.DB.prepare("DROP TRIGGER fail_hold_create_audit").run();

    const createdResponse = await SELF.fetch(HOLDS, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const created = await json(createdResponse);
    const foreignHeaders = await admin("ret-hold-foreign");
    expect((await SELF.fetch(`${HOLDS}/not-a-hold/release`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "n".repeat(32) }),
    })).status).toBe(404);
    expect((await SELF.fetch(`${HOLDS}/${created.hold_id}/release`, {
      method: "POST", headers: { ...foreignHeaders, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "p".repeat(32) }),
    })).status).toBe(404);
    expect((await SELF.fetch(`${HOLDS}/${created.hold_id}`, { headers: foreignHeaders })).status).toBe(404);

    await env.DB.prepare(
      "CREATE TRIGGER fail_hold_release_audit BEFORE INSERT ON org_events " +
      "WHEN NEW.event = 'audit.hold.release' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    ).run();
    const failedRelease = await SELF.fetch(`${HOLDS}/${created.hold_id}/release`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "o".repeat(32) }),
    });
    expect(failedRelease.status).toBe(503);
    expect(await json(await SELF.fetch(HOLDS, { headers }))).toEqual({ active_hold: created });
    await env.DB.prepare("DROP TRIGGER fail_hold_release_audit").run();
  });
});
