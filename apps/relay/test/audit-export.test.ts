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
  it("acknowledges only a complete unfiltered export with a tenant-bound receipt", async () => {
    const org = "ack-org";
    const token = await registerHandle("ack-admin", "claude", org, "admin");
    const headers = wsAuth("ack-admin", token, org);
    await seedOrgEvent(org, 1_000, "first");
    await seedRosterEvent(org, 2_000, "roster-first");

    const first = await SELF.fetch("https://relay.test/v1/audit/events?page_size=1", { headers });
    expect(first.status).toBe(200);
    const firstPage = await first.json<any>();
    expect(firstPage.next_page_token).toEqual(expect.any(String));
    expect(firstPage.completion_receipt).toBeNull();
    expect(firstPage.acknowledged_checkpoint).toBeNull();

    let pageToken = firstPage.next_page_token;
    let terminalPage: any;
    do {
      const terminal = await SELF.fetch(
        `https://relay.test/v1/audit/events?page_size=1&page_token=${encodeURIComponent(pageToken)}`,
        { headers },
      );
      expect(terminal.status).toBe(200);
      terminalPage = await terminal.json<any>();
      pageToken = terminalPage.next_page_token;
    } while (pageToken);
    expect(terminalPage.next_page_token).toBe("");
    expect(terminalPage.completion_receipt).toEqual(expect.any(String));
    expect(terminalPage.completion_receipt.length).toBeLessThanOrEqual(1_024);
    const receiptPayload = JSON.parse(atob(terminalPage.completion_receipt.split(".")[0]
      .replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(terminalPage.completion_receipt.split(".")[0].length / 4) * 4, "=")));
    expect(receiptPayload).toEqual({
      version: 1,
      org,
      checkpoint: {
        orgEventId: terminalPage.checkpoint.org_event_id,
        orgEventCount: terminalPage.checkpoint.org_event_count,
        rosterEventId: terminalPage.checkpoint.roster_event_id,
        rosterEventCount: terminalPage.checkpoint.roster_event_count,
      },
    });

    const acknowledged = await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: terminalPage.completion_receipt }),
    });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.headers.get("cache-control")).toBe("no-store");
    const acknowledgement = await acknowledged.json<any>();
    expect(acknowledgement).toMatchObject({
      acknowledged_checkpoint: terminalPage.checkpoint,
      acknowledged_by: "ack-admin",
      acknowledged_at: expect.any(Number),
    });

    const stored = await env.DB.prepare(
      "SELECT org_event_id, org_event_count, roster_event_id, roster_event_count, acknowledged_by " +
        "FROM audit_export_acknowledgements WHERE org = ?",
    ).bind(org).first<any>();
    expect(stored).toEqual({
      org_event_id: terminalPage.checkpoint.org_event_id,
      org_event_count: terminalPage.checkpoint.org_event_count,
      roster_event_id: terminalPage.checkpoint.roster_event_id,
      roster_event_count: terminalPage.checkpoint.roster_event_count,
      acknowledged_by: "ack-admin",
    });

    const repeated = await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: terminalPage.completion_receipt }),
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(acknowledgement);

    const afterAck = await SELF.fetch("https://relay.test/v1/audit/events", { headers });
    expect((await afterAck.json<any>()).acknowledged_checkpoint).toEqual(terminalPage.checkpoint);
  });

  it("rejects unsafe audit export acknowledgements", async () => {
    const org = "unsafe-ack-org";
    const token = await registerHandle("unsafe-ack-admin", "claude", org, "admin");
    const headers = wsAuth("unsafe-ack-admin", token, org);
    await seedOrgEvent(org, 1_000, "first");

    for (const suffix of ["?before=2000", "?after=1000", "?actor=admin", "?event=org.invite.issue", "?actor_ip=203.0.113.10"]) {
      const response = await SELF.fetch(`https://relay.test/v1/audit/events${suffix}`, { headers });
      expect(response.status).toBe(200);
      expect((await response.json<any>()).completion_receipt).toBeNull();
    }

    const complete = await SELF.fetch("https://relay.test/v1/audit/events", { headers });
    const oldPage = await complete.json<any>();
    expect(oldPage.completion_receipt).toEqual(expect.any(String));

    const forged = `${oldPage.completion_receipt.slice(0, -1)}${oldPage.completion_receipt.endsWith("A") ? "B" : "A"}`;
    expect((await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: forged }),
    })).status).toBe(400);

    // A 32-byte signature has two unused bits in its final base64url
    // character. Changing only those bits decodes to the same bytes, but the
    // noncanonical signed-token alias must still be rejected as tampering.
    const [receiptPayload, receiptSignature] = oldPage.completion_receipt.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = alphabet.indexOf(receiptSignature.at(-1));
    expect(finalIndex % 4).toBe(0);
    const noncanonicalPadBits =
      `${receiptPayload}.${receiptSignature.slice(0, -1)}${alphabet[finalIndex + 1]}`;
    expect((await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: noncanonicalPadBits }),
    })).status).toBe(400);

    const otherToken = await registerHandle("other-ack-admin", "claude", "other-ack-org", "admin");
    expect((await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST",
      headers: { ...wsAuth("other-ack-admin", otherToken, "other-ack-org"), "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: oldPage.completion_receipt }),
    })).status).toBe(400);

    const memberToken = await registerHandle("unsafe-ack-member", "claude", org, "member");
    expect((await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST",
      headers: { ...wsAuth("unsafe-ack-member", memberToken, org), "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: oldPage.completion_receipt }),
    })).status).toBe(403);

    const oldAck = await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: oldPage.completion_receipt }),
    });
    expect(oldAck.status).toBe(200);
    await seedOrgEvent(org, 2_000, "second");
    const newPage = await (await SELF.fetch("https://relay.test/v1/audit/events", { headers })).json<any>();
    expect((await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: newPage.completion_receipt }),
    })).status).toBe(200);
    expect((await SELF.fetch("https://relay.test/v1/audit/export-acknowledgements", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ completion_receipt: oldPage.completion_receipt }),
    })).status).toBe(409);
  });

  it("supports private conditional polling with strong response validators", async () => {
    const org = "etag-org";
    const token = await registerHandle("etag-admin", "claude", org, "admin");
    await seedOrgEvent(org, 1_000, "first");
    const headers = wsAuth("etag-admin", token, org);

    const first = await SELF.fetch("https://relay.test/v1/audit/events", { headers });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache, no-transform");
    expect(first.headers.get("vary")).toBe("Authorization, X-AgentCall-Org, X-AgentCall-Handle");
    const firstBytes = await first.text();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(firstBytes)));
    expect(etag).toBe(`"${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`);

    for (const ifNoneMatch of [etag!, `W/${etag}`, `W/"other,tag", W/${etag}`, "*"]) {
      const unchanged = await SELF.fetch("https://relay.test/v1/audit/events", {
        headers: { ...headers, "If-None-Match": ifNoneMatch },
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(unchanged.headers.get("cache-control")).toBe("private, no-cache, no-transform");
      expect(await unchanged.text()).toBe("");
    }

    const mismatch = await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: { ...headers, "If-None-Match": '"not-current"' },
    });
    expect(mismatch.status).toBe(200);
    expect(mismatch.headers.get("etag")).toBe(etag);
    expect(await mismatch.text()).toBe(firstBytes);

    // A wildcard mixed into a list is invalid, not a wildcard precondition.
    const invalidWildcardList = await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: { ...headers, "If-None-Match": `*, ${etag}` },
    });
    expect(invalidWildcardList.status).toBe(200);
    const invalidObsTextWhitespace = await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: { ...headers, "If-None-Match": "\u00a0*" },
    });
    expect(invalidObsTextWhitespace.status).toBe(200);

    await seedOrgEvent(org, 2_000, "second");
    const changed = await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: { ...headers, "If-None-Match": etag! },
    });
    expect(changed.status).toBe(200);
    const changedEtag = changed.headers.get("etag");
    expect(changedEtag).not.toBe(etag);
    expect(await changed.text()).not.toBe(firstBytes);

    const changedFilter = await SELF.fetch("https://relay.test/v1/audit/events?event=roster.create", {
      headers: { ...headers, "If-None-Match": changedEtag! },
    });
    expect(changedFilter.status).toBe(200);
    expect(changedFilter.headers.get("etag")).not.toBe(changedEtag);

    const crossTenant = await SELF.fetch("https://relay.test/v1/audit/events", {
      headers: { ...wsAuth("etag-admin", token, "another-org"), "If-None-Match": etag! },
    });
    expect(crossTenant.status).toBe(401);
  });

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
      { headers: { ...wsAuth("gap-admin", token, "gap-org"), "If-None-Match": first.headers.get("etag")! } },
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

  it("filters by exact actor, event, and source IP and binds filters into the cursor", async () => {
    const token = await registerHandle("filter-admin", "claude", "filter-org", "admin");
    await seedOrgEvent("filter-org", 1_000, "invite-a");
    await seedRosterEvent("filter-org", 2_000, "roster-a");
    await seedOrgEvent("filter-org", 3_000, "invite-b");
    await seedOrgEvent("filter-org", 4_000, "invite-other-actor");
    await env.DB.prepare("UPDATE org_events SET actor = ? WHERE org = ? AND target_id = ?")
      .bind("other", "filter-org", "invite-other-actor").run();

    const first = await SELF.fetch(
      "https://relay.test/v1/audit/events?actor=admin&event=org.invite.issue&actor_ip=203.0.113.10&page_size=1",
      { headers: wsAuth("filter-admin", token, "filter-org") },
    );
    expect(first.status).toBe(200);
    const page = await first.json<any>();
    expect(page.events.map((event: any) => event.target_id)).toEqual(["invite-a"]);
    expect(page.next_page_token).toEqual(expect.any(String));

    const changed = await SELF.fetch(
      `https://relay.test/v1/audit/events?actor=other&event=org.invite.issue&actor_ip=203.0.113.10&page_size=1&page_token=${encodeURIComponent(page.next_page_token)}`,
      { headers: wsAuth("filter-admin", token, "filter-org") },
    );
    expect(changed.status).toBe(400);

    const second = await SELF.fetch(
      `https://relay.test/v1/audit/events?actor=admin&event=org.invite.issue&actor_ip=203.0.113.10&page_size=1&page_token=${encodeURIComponent(page.next_page_token)}`,
      { headers: wsAuth("filter-admin", token, "filter-org") },
    );
    expect((await second.json<any>()).events.map((event: any) => event.target_id)).toEqual(["invite-b"]);
  });

  it("rejects empty and oversized audit filters", async () => {
    const token = await registerHandle("invalid-filter-admin", "claude", "invalid-filter-org", "admin");
    const headers = wsAuth("invalid-filter-admin", token, "invalid-filter-org");
    expect((await SELF.fetch("https://relay.test/v1/audit/events?actor=", { headers })).status).toBe(400);
    expect((await SELF.fetch(
      `https://relay.test/v1/audit/events?event=${"x".repeat(257)}`, { headers },
    )).status).toBe(400);
    expect((await SELF.fetch(
      `https://relay.test/v1/audit/events?event=${encodeURIComponent("é".repeat(129))}`, { headers },
    )).status).toBe(400);
  });

  it("keeps cursors bounded when accepted filters require JSON escaping", async () => {
    const token = await registerHandle("escaped-filter-admin", "claude", "escaped-filter-org", "admin");
    const escaped = "\u0001".repeat(256);
    for (const at of [1_000, 2_000]) {
      await env.DB.prepare(
        "INSERT INTO org_events (event, action_type, org, actor, actor_type, target_type, " +
          "target_id, actor_ip, description, at) VALUES (?, 'C', ?, ?, 'handle', 'invite', ?, ?, 'escaped', ?)",
      ).bind("org.invite.issue", "escaped-filter-org", escaped, `target-${at}`, escaped, at).run();
    }
    const search = new URLSearchParams({
      actor: escaped, event: "org.invite.issue", actor_ip: escaped, page_size: "1",
    });
    const first = await SELF.fetch(`https://relay.test/v1/audit/events?${search}`, {
      headers: wsAuth("escaped-filter-admin", token, "escaped-filter-org"),
    });
    expect(first.status).toBe(200);
    const page = await first.json<any>();
    expect(page.next_page_token.length).toBeLessThanOrEqual(2_048);

    search.set("page_token", page.next_page_token);
    const second = await SELF.fetch(`https://relay.test/v1/audit/events?${search}`, {
      headers: wsAuth("escaped-filter-admin", token, "escaped-filter-org"),
    });
    expect(second.status).toBe(200);
    expect((await second.json<any>()).events).toHaveLength(1);
  });
});
