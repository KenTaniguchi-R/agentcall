import type { Context } from "hono";
import type { OrgAuditEvent, OrgRoleType, RosterAuditEvent } from "@benree/agentcall-shared";
import type { RelayAppEnv } from "./middleware.js";

type AuditAction = "C" | "R" | "U" | "D";
type AuditActor = "handle" | "admin_secret" | "system";
type AuditTarget = "handle" | "roster" | "join_key";
export type OrgAuditActor = "handle" | "bootstrap" | "invite" | "recovery";
type OrgAuditTarget = "invite" | "handle" | "call" | "retention_policy" | "legal_hold";

type RosterAudit = {
  event: RosterAuditEvent;
  action: AuditAction;
  rosterId: string;
  org: string;
  actor: string;
  actorType: AuditActor;
  targetType: AuditTarget | null;
  targetId: string | null;
  description: string;
  at: number;
};

type OrgAudit = {
  eventKey?: string;
  event: OrgAuditEvent;
  action: "C" | "U";
  org: string;
  actor: string;
  actorType: OrgAuditActor;
  targetType: OrgAuditTarget;
  targetId: string;
  targetRole?: OrgRoleType | null;
  description: string;
  at: number;
};

export const MAX_ROSTER_AUDIT_EVENTS = 10_000;
export const MAX_RETAINED_ORG_AUDIT_EVENTS = 10_000;
type AuditCondition = "always" | "previous-change" | "roster-exists";

export function auditLocation(c: Context<RelayAppEnv>): [string | null, string | null] {
  const country = c.req.raw.cf?.country;
  return [
    c.req.header("cf-connecting-ip") ?? null,
    typeof country === "string" ? country : null,
  ];
}

// Audit events record successful mutations only; reads belong in analytics.
// Append this statement after every state-changing statement in the same D1
// batch so a failed mutation cannot leave behind evidence that it succeeded.
export function rosterAuditStatement(
  c: Context<RelayAppEnv>, audit: RosterAudit, condition: AuditCondition = "always",
): D1PreparedStatement {
  const [actorIp, actorCountry] = auditLocation(c);
  const values = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  const predicate = condition === "previous-change"
    ? " WHERE changes() > 0"
    : condition === "roster-exists"
      ? " WHERE EXISTS (SELECT 1 FROM rosters WHERE id = ? AND org = ?)"
      : "";
  const bindings: (string | number | null)[] = [
    audit.event, audit.action, audit.rosterId, audit.org, audit.actor, audit.actorType,
    audit.targetType, audit.targetId, actorIp, actorCountry, audit.description, audit.at,
  ];
  if (condition === "roster-exists") bindings.push(audit.rosterId, audit.org);
  return c.env.DB.prepare(
    "INSERT INTO roster_events (event, action_type, roster_id, org, actor, actor_type, " +
      "target_type, target_id, actor_ip, actor_country, description, at) " +
      (condition === "always" ? `VALUES (${values})` : `SELECT ${values}${predicate}`),
  ).bind(...bindings);
}

export function orgAuditStatement(
  c: Context<RelayAppEnv>, audit: OrgAudit, condition: "always" | "previous-change" = "always",
): D1PreparedStatement {
  const [actorIp, actorCountry] = auditLocation(c);
  const values = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  const predicate = condition === "previous-change" ? " WHERE changes() > 0" : "";
  return c.env.DB.prepare(
    "INSERT INTO org_events (event_key, event, action_type, org, actor, actor_type, target_type, target_id, " +
      "target_role, actor_ip, actor_country, description, at) " +
      (condition === "always" ? `VALUES (${values})` : `SELECT ${values}${predicate}`),
  ).bind(
    audit.eventKey ?? null, audit.event, audit.action, audit.org, audit.actor, audit.actorType, audit.targetType, audit.targetId,
    audit.targetRole ?? null, actorIp, actorCountry, audit.description, audit.at,
  );
}

export function orgAuditTrimStatement(db: D1Database, org: string): D1PreparedStatement {
  return db.prepare(
    "DELETE FROM org_events WHERE org = ? AND id NOT IN (" +
      "SELECT id FROM org_events WHERE org = ? ORDER BY id DESC LIMIT ?)",
  ).bind(org, org, MAX_RETAINED_ORG_AUDIT_EVENTS);
}
