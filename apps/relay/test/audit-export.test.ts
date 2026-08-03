import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

async function seedOrgEvent(org: string, at: number, target: string) {
  await env.DB.prepare(
    "INSERT INTO org_events (event, action_type, org, actor, actor_type, target_type, " +
      "target_id, actor_ip, actor_country, description, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "org.invite.issue", "C", org, "admin", "handle", "invite", target,
    "203.0.113.10", "US", `issued ${target}`, at,
  ).run();
}

async function seedRosterEvent(org: string, at: number, rosterId: string) {
  await env.DB.prepare(
    "INSERT INTO roster_events (event, action_type, roster_id, org, actor, actor_type, " +
      "target_type, target_id, actor_ip, actor_country, description, at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "roster.create", "C", rosterId, org, "admin", "handle", "roster", rosterId,
    "203.0.113.11", "US", `created ${rosterId}`, at,
  ).run();
}

describe("organization audit export", () => {
  it("exports both ledgers in a stable tenant-scoped snapshot", async () => {
    const token = await registerHandle("audit-admin", "claude", "audit-org", "admin");
    await seedOrgEvent("audit-org", 1_000, "invite-a");
    await seedRosterEvent("audit-org", 2_000, "roster-a");
    await seedOrgEvent("other-org", 1_500, "foreign");

    const first = await SELF.fetch("https://relay.test/v1/audit/events?page_size=1&before=3000", {
      headers: wsAuth("audit-admin", token, "audit-org"),
    });
    expect(first.status).toBe(200);
    const page1 = await first.json<any>();
    expect(page1.events).toEqual([expect.objectContaining({
      ledger: "org", event: "org.invite.issue", target_id: "invite-a", target_role: null, at: 1_000,
    })]);
    expect(page1.next_page_token).toEqual(expect.any(String));
    expect(page1.checkpoint).toMatchObject({
      org_event_id: expect.any(Number), org_event_count: expect.any(Number),
      roster_event_id: expect.any(Number), roster_event_count: expect.any(Number),
    });

    const otherAdminToken = await registerHandle("other-audit-admin", "claude", "audit-org", "admin");
    const replayedByAnotherAdmin = await SELF.fetch(
      `https://relay.test/v1/audit/events?page_size=1&before=3000&page_token=${encodeURIComponent(page1.next_page_token)}`,
      { headers: wsAuth("other-audit-admin", otherAdminToken, "audit-org") },
    );
    expect(replayedByAnotherAdmin.status).toBe(400);
    const replayedWithChangedFilter = await SELF.fetch(
      `https://relay.test/v1/audit/events?page_size=1&before=3001&page_token=${encodeURIComponent(page1.next_page_token)}`,
      { headers: wsAuth("audit-admin", token, "audit-org") },
    );
    expect(replayedWithChangedFilter.status).toBe(400);

    // A concurrent append after page one must not leak into the captured export.
    await seedOrgEvent("audit-org", 3_000, "late-event");
    const second = await SELF.fetch(
      `https://relay.test/v1/audit/events?page_size=1&before=3000&page_token=${encodeURIComponent(page1.next_page_token)}`,
      { headers: wsAuth("audit-admin", token, "audit-org") },
    );
    expect(second.status).toBe(200);
    const page2 = await second.json<any>();
    expect(page2.events).toEqual([expect.objectContaining({
      ledger: "roster", event: "roster.create", roster_id: "roster-a", at: 2_000,
    })]);
    expect(page2.next_page_token).toBe("");
    expect(JSON.stringify([page1, page2])).not.toContain("late-event");
    expect(JSON.stringify([page1, page2])).not.toContain("foreign");
  });

  it("rejects members before revealing whether audit rows exist", async () => {
    const memberToken = await registerHandle("audit-member", "claude", "private-audit", "member");
    await seedOrgEvent("private-audit", 1_000, "private-event");
    const response = await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: wsAuth("audit-member", memberToken, "private-audit"),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "administrator role required" });
    expect((await SELF.fetch("https://relay.test/v1/audit/events")).status).toBe(401);
  });

  it("rejects a forged snapshot cursor", async () => {
    const token = await registerHandle("cursor-admin", "claude", "cursor-org", "admin");
    const response = await SELF.fetch("https://relay.test/v1/audit/events?page_token=forged", {
      headers: wsAuth("cursor-admin", token, "cursor-org"),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid page token" });
    expect((await SELF.fetch("https://relay.test/v1/audit/events?after=2&before=1", {
      headers: wsAuth("cursor-admin", token, "cursor-org"),
    })).status).toBe(400);
    expect((await SELF.fetch("https://relay.test/v1/audit/events?page_size=501", {
      headers: wsAuth("cursor-admin", token, "cursor-org"),
    })).status).toBe(400);
  });

  it("does not accept a cursor signed with the caller's bearer token", async () => {
    const token = await registerHandle("client-signing-admin", "claude", "client-signing-org", "admin");
    await seedOrgEvent("client-signing-org", 1_000, "first");
    await seedOrgEvent("client-signing-org", 2_000, "second");
    const first = await SELF.fetch("https://relay.test/v1/audit/events?page_size=1&before=3000", {
      headers: wsAuth("client-signing-admin", token, "client-signing-org"),
    });
    const page = await first.json<any>();
    const payload = new TextEncoder().encode(JSON.stringify({
      org: "client-signing-org", handle: "client-signing-admin", after: null, before: 3000,
      pageSize: 1,
      checkpoint: {
        orgEventId: page.checkpoint.org_event_id,
        orgEventCount: page.checkpoint.org_event_count,
        rosterEventId: page.checkpoint.roster_event_id,
        rosterEventCount: page.checkpoint.roster_event_count,
      },
      position: { at: 1_000, ledger: "org", id: page.events[0].id },
    }));
    const digest = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`agentcall-audit-export\0Bearer ${token}`),
    );
    const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const forged = `${encode(payload)}.${encode(signature)}`;

    const response = await SELF.fetch(
      `https://relay.test/v1/audit/events?page_size=1&before=3000&page_token=${encodeURIComponent(forged)}`,
      { headers: wsAuth("client-signing-admin", token, "client-signing-org") },
    );
    expect(response.status).toBe(400);
  });

  it("aborts instead of silently omitting a checkpointed row removed mid-export", async () => {
    const token = await registerHandle("gap-admin", "claude", "gap-org", "admin");
    await seedOrgEvent("gap-org", 1_000, "first");
    await seedOrgEvent("gap-org", 2_000, "second");
    const first = await SELF.fetch("https://relay.test/v1/audit/events?page_size=1&before=3000", {
      headers: wsAuth("gap-admin", token, "gap-org"),
    });
    const page = await first.json<any>();
    await env.DB.prepare("DELETE FROM org_events WHERE org = ? AND target_id = ?")
      .bind("gap-org", "second").run();

    const response = await SELF.fetch(
      `https://relay.test/v1/audit/events?page_size=1&before=3000&page_token=${encodeURIComponent(page.next_page_token)}`,
      { headers: wsAuth("gap-admin", token, "gap-org") },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "audit snapshot changed; restart export" });
  });

  it("paginates equal timestamps deterministically by ledger and id", async () => {
    const token = await registerHandle("ordering-admin", "claude", "ordering-org", "admin");
    await seedOrgEvent("ordering-org", 1_000, "org-a");
    await seedOrgEvent("ordering-org", 1_000, "org-b");
    await seedRosterEvent("ordering-org", 1_000, "roster-a");
    let pageToken: string | undefined;
    const order: string[] = [];
    do {
      const response = await SELF.fetch(
        `https://relay.test/v1/audit/events?page_size=1&before=2000${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
        { headers: wsAuth("ordering-admin", token, "ordering-org") },
      );
      expect(response.status).toBe(200);
      const page = await response.json<any>();
      order.push(page.events[0].target_id);
      pageToken = page.next_page_token || undefined;
    } while (pageToken);
    expect(order).toEqual(["org-a", "org-b", "roster-a"]);
  });

  it("uses inclusive after and exclusive before boundaries and supports an empty result", async () => {
    const token = await registerHandle("boundary-admin", "claude", "boundary-org", "admin");
    await seedOrgEvent("boundary-org", 1_000, "at-after");
    await seedOrgEvent("boundary-org", 2_000, "at-before");
    const response = await SELF.fetch(
      "https://relay.test/v1/audit/events?after=1000&before=2000",
      { headers: wsAuth("boundary-admin", token, "boundary-org") },
    );
    const page = await response.json<any>();
    expect(page.events.map((event: any) => event.target_id)).toEqual(["at-after"]);

    const empty = await SELF.fetch(
      "https://relay.test/v1/audit/events?after=3000&before=4000",
      { headers: wsAuth("boundary-admin", token, "boundary-org") },
    );
    expect(await empty.json<any>()).toMatchObject({ events: [], next_page_token: "" });
  });
});
