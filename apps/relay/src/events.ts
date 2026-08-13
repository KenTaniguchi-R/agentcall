import type { Context } from "hono";
import type { OrgAuditEvent, OrgRoleType } from "@benree/agentcall-shared";
import type { RelayAppEnv } from "./middleware.js";

export type OrgAuditActor = "handle" | "bootstrap" | "invite" | "recovery";
type OrgAuditTarget = "invite" | "handle" | "call" | "retention_policy" | "legal_hold";

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

export const MAX_RETAINED_ORG_AUDIT_EVENTS = 10_000;

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
