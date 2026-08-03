import {
  AuditLegalHold,
  AuditRetentionPolicy,
  AuditRetentionReadiness,
  AUDIT_RETENTION_DAY_MS,
  DEFAULT_AUDIT_EVENT_RETENTION_DAYS,
  type AuditRetentionReadinessType,
} from "@benree/agentcall-shared";

export type AuditPolicyRow = {
  event_retention_days: number;
  version: number;
  updated_by: string;
  updated_at: number;
};

export type AuditHoldRow = {
  hold_id: string;
  reason: string;
  created_by: string;
  created_at: number;
  create_request_id: string;
  released_by: string | null;
  released_at: number | null;
  release_request_id: string | null;
};

export const AUDIT_HOLD_COLUMNS = "hold_id, reason, created_by, created_at, create_request_id, " +
  "released_by, released_at, release_request_id";

const LEDGER_CONFIG = {
  org: { table: "org_events", checkpointColumn: "org_event_id" },
  roster: { table: "roster_events", checkpointColumn: "roster_event_id" },
} as const;
type AuditRetentionLedger = keyof typeof LEDGER_CONFIG;
type SqlFragment = { sql: string; bindings: (string | number)[] };

type AcknowledgementRow = {
  org_event_id: number;
  roster_event_id: number;
};

type LedgerCountRow = {
  eligible_count: number;
  unacknowledged_count: number;
};

function retentionCutoffPredicate(
  table: string,
  org: string,
  evaluatedAt: number,
): SqlFragment {
  return {
    sql: `${table}.org = ? AND ${table}.at < MAX(0, ? - COALESCE((` +
      `SELECT event_retention_days FROM audit_retention_policies WHERE org = ?` +
      `), ?) * ?)`,
    bindings: [
      org,
      evaluatedAt,
      org,
      DEFAULT_AUDIT_EVENT_RETENTION_DAYS,
      AUDIT_RETENTION_DAY_MS,
    ],
  };
}

/**
 * Complete fail-closed row predicate for retention execution. A future bounded
 * DELETE must embed this clause inside its own D1 transaction rather than
 * treating a prior readiness response as authorization.
 */
export function auditRetentionEligibilityPredicate(
  ledger: AuditRetentionLedger,
  org: string,
  evaluatedAt: number,
): SqlFragment & { table: string } {
  const { table, checkpointColumn } = LEDGER_CONFIG[ledger];
  const cutoff = retentionCutoffPredicate(table, org, evaluatedAt);
  return {
    table,
    sql: `${cutoff.sql} AND ${table}.id <= COALESCE((` +
      `SELECT ${checkpointColumn} FROM audit_export_acknowledgements WHERE org = ?` +
      `), -1) AND NOT EXISTS (` +
      `SELECT 1 FROM audit_legal_holds WHERE org = ? AND released_at IS NULL` +
      `)`,
    bindings: [...cutoff.bindings, org, org],
  };
}

function unacknowledgedCutoffPredicate(
  ledger: AuditRetentionLedger,
  org: string,
  evaluatedAt: number,
): SqlFragment {
  const { table, checkpointColumn } = LEDGER_CONFIG[ledger];
  const cutoff = retentionCutoffPredicate(table, org, evaluatedAt);
  return {
    sql: `${cutoff.sql} AND (` +
      `NOT EXISTS (SELECT 1 FROM audit_export_acknowledgements WHERE org = ?) OR ` +
      `${table}.id > COALESCE((` +
        `SELECT ${checkpointColumn} FROM audit_export_acknowledgements WHERE org = ?` +
      `), -1))`,
    bindings: [...cutoff.bindings, org, org],
  };
}

export function retentionPolicyFromRow(row: AuditPolicyRow | null) {
  return row ? AuditRetentionPolicy.parse({
    event_retention_days: Number(row.event_retention_days),
    version: Number(row.version),
    updated_by: row.updated_by,
    updated_at: Number(row.updated_at),
  }) : {
    event_retention_days: DEFAULT_AUDIT_EVENT_RETENTION_DAYS,
    version: 0 as const,
    updated_by: null,
    updated_at: null,
  };
}

export function publicAuditHold(row: AuditHoldRow | null) {
  return row ? AuditLegalHold.parse({
    hold_id: row.hold_id,
    reason: row.reason,
    created_by: row.created_by,
    created_at: Number(row.created_at),
    released_by: row.released_by,
    released_at: row.released_at === null ? null : Number(row.released_at),
  }) : null;
}

function ledgerReadiness(
  acknowledgedThroughId: number | null,
  row: LedgerCountRow | undefined,
) {
  const unacknowledgedEventCount = Number(row?.unacknowledged_count ?? 0);
  return {
    acknowledged_through_id: acknowledgedThroughId,
    eligible_event_count: Number(row?.eligible_count ?? 0),
    unacknowledged_event_count: unacknowledgedEventCount,
    export_ready: acknowledgedThroughId !== null && unacknowledgedEventCount === 0,
  };
}

export async function evaluateAuditRetentionReadiness(
  db: D1Database,
  org: string,
  evaluatedAt: number,
): Promise<AuditRetentionReadinessType> {
  const policyStatement = db.prepare(
    "SELECT event_retention_days, version, updated_by, updated_at " +
      "FROM audit_retention_policies WHERE org = ?",
  ).bind(org);
  const holdStatement = db.prepare(
    `SELECT ${AUDIT_HOLD_COLUMNS} FROM audit_legal_holds WHERE org = ? AND released_at IS NULL`,
  ).bind(org);
  const acknowledgementStatement = db.prepare(
    "SELECT org_event_id, roster_event_id FROM audit_export_acknowledgements WHERE org = ?",
  ).bind(org);

  // The complete eligibility predicate and coverage counts execute with the
  // policy/hold/acknowledgement reads in one D1 batch transaction.
  const countStatement = (ledger: AuditRetentionLedger) => {
    const eligibility = auditRetentionEligibilityPredicate(ledger, org, evaluatedAt);
    const unacknowledged = unacknowledgedCutoffPredicate(ledger, org, evaluatedAt);
    return db.prepare(
      `SELECT ` +
        `(SELECT COUNT(*) FROM ${eligibility.table} WHERE ${eligibility.sql}) AS eligible_count, ` +
        `(SELECT COUNT(*) FROM ${eligibility.table} WHERE ${unacknowledged.sql}) ` +
          `AS unacknowledged_count`,
    ).bind(...eligibility.bindings, ...unacknowledged.bindings);
  };

  const [policyResult, holdResult, acknowledgementResult, orgResult, rosterResult] = await db.batch([
    policyStatement,
    holdStatement,
    acknowledgementStatement,
    countStatement("org"),
    countStatement("roster"),
  ]);
  const policy = retentionPolicyFromRow(
    (policyResult.results[0] as AuditPolicyRow | undefined) ?? null,
  );
  const cutoffAt = Math.max(0, evaluatedAt - policy.event_retention_days * AUDIT_RETENTION_DAY_MS);
  const activeHold = publicAuditHold(
    (holdResult.results[0] as AuditHoldRow | undefined) ?? null,
  );
  const acknowledgement = acknowledgementResult.results[0] as AcknowledgementRow | undefined;
  const held = activeHold !== null;

  const orgLedger = ledgerReadiness(
    acknowledgement ? Number(acknowledgement.org_event_id) : null,
    orgResult.results[0] as LedgerCountRow | undefined,
  );
  const rosterLedger = ledgerReadiness(
    acknowledgement ? Number(acknowledgement.roster_event_id) : null,
    rosterResult.results[0] as LedgerCountRow | undefined,
  );
  const state = held
    ? "held"
    : orgLedger.export_ready && rosterLedger.export_ready
      ? "ready"
      : "export_required";

  return AuditRetentionReadiness.parse({
    state,
    evaluated_at: evaluatedAt,
    cutoff_at: cutoffAt,
    retention_policy: policy,
    active_hold: activeHold,
    ledgers: { org: orgLedger, roster: rosterLedger },
  });
}
