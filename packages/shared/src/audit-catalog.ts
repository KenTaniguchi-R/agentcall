export interface AuditEventCatalogEntry {
  event: string;
  ledger: "org" | "roster";
  action: "C" | "U" | "D";
  actors: readonly string[];
  target: string;
  source_ip: "nullable_request_metadata";
  source_country: "nullable_request_metadata";
  collection: "synchronous_d1_batch" | "durable_object_outbox";
  available_since: string;
  migration: string;
  description: string;
}

const rosterBase = "0007_roster_audit_events.sql";
const rosterKeys = "0008_roster_join_keys.sql";
const orgInvites = "0009_org_invite_lifecycle.sql";
const rosterBudget = "0010_roster_audit_budget_recovery.sql";
const callEvents = "0014_call_audit_events.sql";
const retentionControls = "0016_audit_retention_controls.sql";

/** Durable, tenant-exportable event types implemented by the relay. */
export const AUDIT_EVENT_CATALOG = [
  { event: "org.invite.issue", ledger: "org", action: "C", actors: ["bootstrap", "handle"], target: "invite", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: orgInvites, description: "An organization invite was issued." },
  { event: "org.invite.redeem", ledger: "org", action: "C", actors: ["invite"], target: "handle", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: orgInvites, description: "An organization invite enrolled a handle." },
  { event: "org.invite.revoke", ledger: "org", action: "U", actors: ["handle"], target: "invite", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: orgInvites, description: "An unused organization invite was revoked." },
  { event: "call.submit", ledger: "org", action: "C", actors: ["handle"], target: "call", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "durable_object_outbox", available_since: "2026-08-03", migration: callEvents, description: "A caller submitted a call to an online handle." },
  { event: "call.accept", ledger: "org", action: "U", actors: ["handle"], target: "call", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "durable_object_outbox", available_since: "2026-08-03", migration: callEvents, description: "The callee accepted a call." },
  { event: "call.complete", ledger: "org", action: "U", actors: ["handle"], target: "call", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "durable_object_outbox", available_since: "2026-08-03", migration: callEvents, description: "The callee completed a call." },
  { event: "call.fail", ledger: "org", action: "U", actors: ["handle"], target: "call", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "durable_object_outbox", available_since: "2026-08-03", migration: callEvents, description: "The callee reported that a call failed." },
  { event: "call.cancel", ledger: "org", action: "U", actors: ["handle"], target: "call", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "durable_object_outbox", available_since: "2026-08-03", migration: callEvents, description: "The callee confirmed that a call was canceled." },
  { event: "call.timeout", ledger: "org", action: "U", actors: ["system"], target: "call", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "durable_object_outbox", available_since: "2026-08-03", migration: callEvents, description: "The relay expired a call at its deadline." },
  { event: "audit.retention.update", ledger: "org", action: "U", actors: ["handle"], target: "retention_policy", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-03", migration: retentionControls, description: "An organization administrator changed the audit event retention window." },
  { event: "audit.hold.create", ledger: "org", action: "C", actors: ["handle"], target: "legal_hold", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-03", migration: retentionControls, description: "An organization administrator created an audit legal or incident hold." },
  { event: "audit.hold.release", ledger: "org", action: "U", actors: ["handle"], target: "legal_hold", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-03", migration: retentionControls, description: "An organization administrator released an audit legal or incident hold." },
  { event: "roster.create", ledger: "roster", action: "C", actors: ["handle"], target: "roster", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBase, description: "A roster was created." },
  { event: "roster.join", ledger: "roster", action: "C", actors: ["handle"], target: "handle", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBase, description: "A handle joined a roster." },
  { event: "roster.leave", ledger: "roster", action: "D", actors: ["handle"], target: "handle", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBase, description: "A handle left a roster." },
  { event: "roster.expel", ledger: "roster", action: "D", actors: ["admin_secret"], target: "handle", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBase, description: "A roster administrator expelled a handle." },
  { event: "roster.delete", ledger: "roster", action: "D", actors: ["admin_secret"], target: "roster", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBase, description: "A roster administrator deleted a roster." },
  { event: "roster.join_key.issue", ledger: "roster", action: "C", actors: ["handle", "admin_secret"], target: "join_key", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterKeys, description: "A roster join key was issued." },
  { event: "roster.join_key.revoke", ledger: "roster", action: "U", actors: ["admin_secret"], target: "join_key", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterKeys, description: "A roster join key was revoked." },
  { event: "roster.join_key.evict", ledger: "roster", action: "D", actors: ["admin_secret"], target: "join_key", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterKeys, description: "Members admitted by a join key were evicted." },
  { event: "roster.audit_budget_exhausted", ledger: "roster", action: "U", actors: ["handle"], target: "roster", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBase, description: "A roster reached its member-mutation audit budget." },
  { event: "roster.audit_budget_reset", ledger: "roster", action: "U", actors: ["admin_secret"], target: "roster", source_ip: "nullable_request_metadata", source_country: "nullable_request_metadata", collection: "synchronous_d1_batch", available_since: "2026-08-02", migration: rosterBudget, description: "A roster administrator reset the audit budget." },
] as const satisfies readonly AuditEventCatalogEntry[];

type CatalogEntry = (typeof AUDIT_EVENT_CATALOG)[number];
export type OrgAuditEvent = Extract<CatalogEntry, { ledger: "org" }>["event"];
export type RosterAuditEvent = Extract<CatalogEntry, { ledger: "roster" }>["event"];
