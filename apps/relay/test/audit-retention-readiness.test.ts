import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const READINESS = "https://relay.test/v1/audit/retention-readiness";
const DAY = 86_400_000;

async function admin(org: string, handle = `${org}-admin`) {
  const token = await registerHandle(handle, "claude", org, "admin");
  return wsAuth(handle, token, org);
}

async function seedOrgEvent(org: string, at: number, target: string) {
  const result = await env.DB.prepare(
    "INSERT INTO org_events (event, action_type, org, actor, actor_type, target_type, " +
      "target_id, actor_ip, actor_country, description, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "org.invite.issue", "C", org, "admin", "handle", "invite", target,
    "203.0.113.10", "US", `issued ${target}`, at,
  ).run();
  return Number(result.meta.last_row_id);
}

async function seedRosterEvent(org: string, at: number, rosterId: string) {
  const result = await env.DB.prepare(
    "INSERT INTO roster_events (event, action_type, roster_id, org, actor, actor_type, " +
      "target_type, target_id, actor_ip, actor_country, description, at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "roster.create", "C", rosterId, org, "admin", "handle", "roster", rosterId,
    "203.0.113.11", "US", `created ${rosterId}`, at,
  ).run();
  return Number(result.meta.last_row_id);
}

async function acknowledge(
  org: string, orgEventId: number, orgEventCount: number,
  rosterEventId: number, rosterEventCount: number,
) {
  await env.DB.prepare(
    "INSERT INTO audit_export_acknowledgements " +
      "(org, org_event_id, org_event_count, roster_event_id, roster_event_count, acknowledged_by, acknowledged_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(org, orgEventId, orgEventCount, rosterEventId, rosterEventCount, "admin", 1).run();
}

async function body(response: Response) {
  return response.json<any>();
}

describe("audit retention readiness", () => {
  it("uses the default cutoff and fails closed without export acknowledgement", async () => {
    const org = "ready-default";
    const headers = await admin(org);
    const evaluatedAt = 500 * DAY;
    const cutoff = 100 * DAY;
    await seedOrgEvent(org, cutoff - 1, "old-org");
    await seedOrgEvent("ready-default-foreign", cutoff - 1, "foreign-old-org");
    await seedRosterEvent(org, cutoff, "boundary-roster");

    const response = await SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response)).toEqual({
      state: "export_required",
      evaluated_at: evaluatedAt,
      cutoff_at: cutoff,
      retention_policy: {
        event_retention_days: 400, version: 0, updated_by: null, updated_at: null,
      },
      active_hold: null,
      ledgers: {
        org: {
          acknowledged_through_id: null,
          eligible_event_count: 0,
          unacknowledged_event_count: 1,
          export_ready: false,
        },
        roster: {
          acknowledged_through_id: null,
          eligible_event_count: 0,
          unacknowledged_event_count: 0,
          export_ready: false,
        },
      },
    });
  });

  it("counts only cutoff-eligible acknowledged rows and identifies a stale ledger watermark", async () => {
    const org = "ready-coverage";
    const headers = await admin(org);
    const evaluatedAt = 500 * DAY;
    const cutoff = 100 * DAY;
    const firstOrgId = await seedOrgEvent(org, cutoff - 2, "covered-org");
    const rosterId = await seedRosterEvent(org, cutoff - 1, "covered-roster");
    await acknowledge(org, firstOrgId, 1, rosterId, 1);
    await seedOrgEvent(org, cutoff - 1, "uncovered-org");
    await seedRosterEvent(org, cutoff, "boundary-roster");

    const first = await body(await SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }));
    expect(first.state).toBe("export_required");
    expect(first.ledgers).toEqual({
      org: {
        acknowledged_through_id: firstOrgId,
        eligible_event_count: 1,
        unacknowledged_event_count: 1,
        export_ready: false,
      },
      roster: {
        acknowledged_through_id: rosterId,
        eligible_event_count: 1,
        unacknowledged_event_count: 0,
        export_ready: true,
      },
    });

    const orgStats = await env.DB.prepare(
      "SELECT MAX(id) AS max_id, COUNT(*) AS n FROM org_events WHERE org = ?",
    ).bind(org).first<{ max_id: number; n: number }>();
    const rosterStats = await env.DB.prepare(
      "SELECT MAX(id) AS max_id, COUNT(*) AS n FROM roster_events WHERE org = ?",
    ).bind(org).first<{ max_id: number; n: number }>();
    await env.DB.prepare(
      "UPDATE audit_export_acknowledgements SET org_event_id = ?, org_event_count = ?, " +
        "roster_event_id = ?, roster_event_count = ? WHERE org = ?",
    ).bind(orgStats!.max_id, orgStats!.n, rosterStats!.max_id, rosterStats!.n, org).run();

    const ready = await body(await SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }));
    expect(ready.state).toBe("ready");
    expect(ready.ledgers.org).toMatchObject({
      eligible_event_count: 2, unacknowledged_event_count: 0, export_ready: true,
    });
    expect(ready.ledgers.roster).toMatchObject({
      eligible_event_count: 1, unacknowledged_event_count: 0, export_ready: true,
    });
    expect(await body(await SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }))).toEqual(ready);
  });

  it("reports a legal hold ahead of otherwise complete export coverage", async () => {
    const org = "ready-hold";
    const headers = await admin(org);
    const evaluatedAt = 500 * DAY;
    const eventId = await seedOrgEvent(org, 1, "covered-org");
    const rosterId = await seedRosterEvent(org, 1, "covered-roster");
    await acknowledge(org, eventId, 1, rosterId, 1);
    const hold = await SELF.fetch("https://relay.test/v1/audit/legal-holds", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Incident preservation", request_id: "h".repeat(32) }),
    });
    expect(hold.status).toBe(201);

    const readiness = await body(await SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }));
    expect(readiness.state).toBe("held");
    expect(readiness.active_hold).toMatchObject({
      reason: "Incident preservation", released_by: null, released_at: null,
    });
    expect(readiness.ledgers.org).toMatchObject({ eligible_event_count: 0, export_ready: true });
    expect(readiness.ledgers.roster).toMatchObject({ eligible_event_count: 0, export_ready: true });
  });

  it("uses configured policy and enforces admin, tenant, and evaluation-time boundaries", async () => {
    const org = "ready-auth";
    const headers = await admin(org);
    const evaluatedAt = 500 * DAY;
    const policy = await SELF.fetch("https://relay.test/v1/audit/retention-policy", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        event_retention_days: 30, expected_version: 0, request_id: "p".repeat(32),
      }),
    });
    expect(policy.status).toBe(200);
    await acknowledge(org, 0, 0, 0, 0);
    const configured = await body(await SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }));
    expect(configured.cutoff_at).toBe(470 * DAY);
    expect(configured.retention_policy).toMatchObject({ event_retention_days: 30, version: 1 });

    const memberToken = await registerHandle("ready-member", "claude", org, "member");
    expect((await SELF.fetch(READINESS, { headers: wsAuth("ready-member", memberToken, org) })).status).toBe(403);
    expect((await SELF.fetch(READINESS, {
      headers: wsAuth("ready-member", memberToken, "ready-other"),
    })).status).toBe(401);
    for (const query of ["evaluated_at=-1", "evaluated_at=1.5", "evaluated_at=1&evaluated_at=2"]) {
      expect((await SELF.fetch(`${READINESS}?${query}`, { headers })).status).toBe(400);
    }
    expect((await SELF.fetch(`${READINESS}?evaluated_at=${Date.now() + DAY}`, { headers })).status).toBe(400);
  });

  it("never treats a concurrent unacknowledged old append as covered", async () => {
    const org = "ready-race";
    const headers = await admin(org);
    const evaluatedAt = 500 * DAY;
    await acknowledge(org, 0, 0, 0, 0);
    const [response] = await Promise.all([
      SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }),
      seedOrgEvent(org, 1, "racing-old-event"),
    ]);
    const readiness = await body(response);
    expect(["ready", "export_required"]).toContain(readiness.state);
    expect(readiness.ledgers.org.eligible_event_count).toBe(0);
    if (readiness.state === "export_required") {
      expect(readiness.ledgers.org).toMatchObject({
        unacknowledged_event_count: 1, export_ready: false,
      });
    }
  });

  it("never mixes a concurrent policy version with the other version's cutoff", async () => {
    const org = "ready-policy-race";
    const headers = await admin(org);
    const evaluatedAt = 500 * DAY;
    await acknowledge(org, 0, 0, 0, 0);
    const [readinessResponse, updateResponse] = await Promise.all([
      SELF.fetch(`${READINESS}?evaluated_at=${evaluatedAt}`, { headers }),
      SELF.fetch("https://relay.test/v1/audit/retention-policy", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          event_retention_days: 30, expected_version: 0, request_id: "r".repeat(32),
        }),
      }),
    ]);
    expect(updateResponse.status).toBe(200);
    const readiness = await body(readinessResponse);
    expect([
      [400, 0, 100 * DAY],
      [30, 1, 470 * DAY],
    ]).toContainEqual([
      readiness.retention_policy.event_retention_days,
      readiness.retention_policy.version,
      readiness.cutoff_at,
    ]);
  });
});
