import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_CATALOG } from "../src/audit-catalog.js";

const relaySources = ["invites.ts", "index.ts", "do.ts", "audit.ts", "recovery.ts"].map((file) =>
  readFileSync(new URL(`../../../apps/relay/src/${file}`, import.meta.url), "utf8"));

describe("durable audit event catalog", () => {
  it("exactly matches every durable event literal emitted by relay mutations", () => {
    const emitted = relaySources.flatMap((source) => [...source.matchAll(/(?:event:\s*|callAuditIntent\(|_EVENT:\s*OrgAuditEvent\s*=\s*)"((?:org|roster|call|audit|credential)\.[a-z_.]+)"/g)]
      .map((match) => match[1]!));
    expect([...new Set(emitted)].sort()).toEqual(AUDIT_EVENT_CATALOG
      .filter((entry) => !entry.event.startsWith("roster."))
      .map((entry) => entry.event).sort());
  });

  it("has unique names and explicit availability/provenance metadata", () => {
    expect(new Set(AUDIT_EVENT_CATALOG.map((entry) => entry.event)).size).toBe(AUDIT_EVENT_CATALOG.length);
    for (const entry of AUDIT_EVENT_CATALOG) {
      expect(entry.available_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.migration).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(entry.source_ip).toBe("nullable_request_metadata");
      expect(entry.source_country).toBe("nullable_request_metadata");
      expect(["synchronous_d1_batch", "durable_object_outbox"]).toContain(entry.collection);
      expect(entry.actors.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    const eventsByMigration = AUDIT_EVENT_CATALOG.reduce<Record<string, (typeof AUDIT_EVENT_CATALOG)[number][]>>(
      (groups, entry) => ({ ...groups, [entry.migration]: [...(groups[entry.migration] ?? []), entry] }), {},
    );
    expect(Object.fromEntries(Object.entries(eventsByMigration).map(([migration, entries]) => [
      migration, entries.map((entry) => entry.event).sort(),
    ]))).toEqual({
      "0007_roster_audit_events.sql": [
        "roster.audit_budget_exhausted", "roster.create", "roster.delete",
        "roster.expel", "roster.join", "roster.leave",
      ],
      "0008_roster_join_keys.sql": [
        "roster.join_key.evict", "roster.join_key.issue", "roster.join_key.revoke",
      ],
      "0009_org_invite_lifecycle.sql": [
        "org.invite.issue", "org.invite.redeem", "org.invite.revoke",
      ],
      "0010_roster_audit_budget_recovery.sql": ["roster.audit_budget_reset"],
      "0014_call_audit_events.sql": [
        "call.accept", "call.cancel", "call.complete", "call.fail", "call.submit", "call.timeout",
      ],
      "0016_audit_retention_controls.sql": [
        "audit.hold.create", "audit.hold.release", "audit.retention.update",
      ],
      "0018_recovery_v2.sql": ["credential.recovery.issue", "credential.recovery.redeem"],
    });
  });
});
