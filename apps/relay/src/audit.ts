import type { Hono } from "hono";
import {
  AuditLegalHoldCreateRequest, AuditLegalHoldReleaseRequest,
  AuditExportAcknowledgement, AuditExportAcknowledgementRequest, AuditExportPage,
  AuditRetentionPolicy, AuditRetentionPolicyUpdateRequest,
  AUDIT_HOLD_ID_RE, decodeSignedToken, encodeSignedToken, toBase64Url,
  type AuditCheckpointType, type AuditExportAcknowledgementType,
  type AuditExportEventType, type AuditExportPageType,
  type AuditRetentionPolicyType, type OrgAuditEvent,
} from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { sha256Hex } from "./auth.js";
import { AUDIT_READ, AUDIT_WRITE } from "./ratelimit/index.js";
import { rateLimit, requireAdmin, type RelayAppEnv } from "./middleware.js";
import { auditLocation, orgAuditTrimStatement } from "./events.js";
import {
  AUDIT_HOLD_COLUMNS,
  evaluateAuditRetentionReadiness,
  publicAuditHold,
  retentionPolicyFromRow,
  type AuditHoldRow,
  type AuditPolicyRow,
} from "./audit-retention.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_PAGE_TOKEN_LENGTH = 2_048;
const MAX_COMPLETION_RECEIPT_LENGTH = 1_024;
const MAX_FILTER_LENGTH = 256;
const AUDIT_CACHE_HEADERS = {
  "Cache-Control": "private, no-cache, no-transform",
  Vary: "Authorization, X-AgentCall-Org, X-AgentCall-Handle",
} as const;
const AUDIT_RETENTION_UPDATE_EVENT: OrgAuditEvent = "audit.retention.update";
const AUDIT_HOLD_CREATE_EVENT: OrgAuditEvent = "audit.hold.create";
const AUDIT_HOLD_RELEASE_EVENT: OrgAuditEvent = "audit.hold.release";

type Checkpoint = {
  orgEventId: number;
  orgEventCount: number;
  rosterEventId: number;
  rosterEventCount: number;
};
type Position = { at: number; ledger: "org" | "roster"; id: number };
type ExportQuery = {
  after?: number;
  before?: number;
  actor?: string;
  event?: string;
  actorIp?: string;
  pageSize: number;
  pageToken?: string;
};
type CursorPayload = {
  org: string;
  handle: string;
  after: number | null;
  before: number | null;
  filterDigest: string;
  pageSize: number;
  checkpoint: Checkpoint;
  position: Position;
};
type CompletionReceiptPayload = { version: 1; org: string; checkpoint: Checkpoint };
type PolicyRequestRow = {
  requested_days: number;
  expected_version: number;
  resulting_version: number;
  actor: string;
  at: number;
};

function parseIfNoneMatch(value: string): "*" | string[] | null {
  // HTTP optional whitespace is SP / HTAB only. String.trim() also removes
  // NBSP and other Unicode whitespace, which could promote malformed input
  // such as NBSP + `*` into a matching wildcard.
  const input = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (input === "*") return "*";
  const tags: string[] = [];
  let index = 0;
  while (index < input.length) {
    // RFC 9110's list extension permits empty members; skip OWS and commas.
    while (index < input.length && (input[index] === " " || input[index] === "\t" || input[index] === ",")) index++;
    if (index >= input.length) break;
    if (input.startsWith("W/", index)) index += 2;
    if (input[index] !== '"') return null;
    const start = index++;
    while (index < input.length && input[index] !== '"') {
      const code = input.charCodeAt(index);
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) return null;
      index++;
    }
    if (index >= input.length) return null;
    tags.push(input.slice(start, ++index));
    while (index < input.length && (input[index] === " " || input[index] === "\t")) index++;
    if (index < input.length && input[index] !== ",") return null;
  }
  return tags;
}

function ifNoneMatchMatches(value: string | undefined, current: string): boolean {
  if (value === undefined) return false;
  const parsed = parseIfNoneMatch(value);
  return parsed === "*" || (parsed !== null && parsed.some((tag) => tag === current));
}

async function tokenKey(secret: string, purpose: "cursor" | "completion"): Promise<CryptoKey> {
  // Keep the original cursor domain stable so an in-progress export survives
  // this deployment. Completion receipts use a separate key domain and cannot
  // be replayed as cursors even though both derive from the operator secret.
  const domain = purpose === "cursor" ? "agentcall-audit-export" : "agentcall-audit-export-completion";
  const material = new TextEncoder().encode(`${domain}\0${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function encodeCursor(payload: CursorPayload, secret: string): Promise<string> {
  return encodeSignedToken(payload, await tokenKey(secret, "cursor"));
}

async function filterDigest(query: ExportQuery): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify([
    query.actor ?? null,
    query.event ?? null,
    query.actorIp ?? null,
  ]));
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

async function decodeCursor(
  token: string, secret: string, org: string, handle: string, query: ExportQuery,
): Promise<CursorPayload | null> {
  const payload = await decodeSignedToken<CursorPayload>(
    token, await tokenKey(secret, "cursor"), MAX_PAGE_TOKEN_LENGTH,
  );
  if (!payload) return null;
  // A valid signature proves the relay issued these bytes, not that they still
  // describe THIS request. Re-check every claim against the current query so a
  // cursor cannot be replayed across orgs, handles, filters, or page sizes.
  if (
    payload.org !== org || payload.handle !== handle ||
    payload.after !== (query.after ?? null) || payload.before !== (query.before ?? null) ||
    payload.filterDigest !== await filterDigest(query) ||
    payload.pageSize !== query.pageSize ||
    !validCheckpoint(payload.checkpoint) ||
    !Number.isSafeInteger(payload.position?.at) || payload.position.at < 0 ||
    (payload.position.ledger !== "org" && payload.position.ledger !== "roster") ||
    !Number.isSafeInteger(payload.position.id) || payload.position.id < 1
  ) return null;
  return payload;
}

function validCheckpoint(value: Checkpoint): boolean {
  return Number.isSafeInteger(value?.orgEventId) && value.orgEventId >= 0 &&
    Number.isSafeInteger(value?.orgEventCount) && value.orgEventCount >= 0 &&
    Number.isSafeInteger(value?.rosterEventId) && value.rosterEventId >= 0 &&
    Number.isSafeInteger(value?.rosterEventCount) && value.rosterEventCount >= 0;
}

async function encodeCompletionReceipt(
  org: string, checkpoint: Checkpoint, secret: string,
): Promise<string> {
  return encodeSignedToken({ version: 1, org, checkpoint }, await tokenKey(secret, "completion"));
}

async function decodeCompletionReceipt(
  token: string, secret: string, org: string,
): Promise<CompletionReceiptPayload | null> {
  const payload = await decodeSignedToken<CompletionReceiptPayload>(
    token, await tokenKey(secret, "completion"), MAX_COMPLETION_RECEIPT_LENGTH,
  );
  if (!payload) return null;
  if (payload.version !== 1 || payload.org !== org || !validCheckpoint(payload.checkpoint)) return null;
  return payload;
}

function parseInteger(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseFilter(value: string | null): string | undefined | null {
  if (value === null) return undefined;
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 1 || bytes > MAX_FILTER_LENGTH) return null;
  return value;
}

function parseQuery(url: URL): ExportQuery | null {
  const after = parseInteger(url.searchParams.get("after"));
  const before = parseInteger(url.searchParams.get("before"));
  const actor = parseFilter(url.searchParams.get("actor"));
  const event = parseFilter(url.searchParams.get("event"));
  const actorIp = parseFilter(url.searchParams.get("actor_ip"));
  const pageSize = parseInteger(url.searchParams.get("page_size")) ?? DEFAULT_PAGE_SIZE;
  if (
    after === null || before === null || actor === null || event === null || actorIp === null ||
    pageSize === null || pageSize < 1 || pageSize > MAX_PAGE_SIZE
  ) return null;
  if (after !== undefined && before !== undefined && after >= before) return null;
  return { after, before, actor, event, actorIp, pageSize, pageToken: url.searchParams.get("page_token") ?? undefined };
}

async function captureCheckpoint(db: D1Database, org: string): Promise<Checkpoint> {
  const [orgResult, rosterResult] = await db.batch([
    db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS row_count FROM org_events WHERE org = ?").bind(org),
    db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS row_count FROM roster_events WHERE org = ?").bind(org),
  ]);
  const orgRow = orgResult.results[0] as { max_id: number; row_count: number } | undefined;
  const rosterRow = rosterResult.results[0] as { max_id: number; row_count: number } | undefined;
  return {
    orgEventId: Number(orgRow?.max_id ?? 0),
    orgEventCount: Number(orgRow?.row_count ?? 0),
    rosterEventId: Number(rosterRow?.max_id ?? 0),
    rosterEventCount: Number(rosterRow?.row_count ?? 0),
  };
}

async function checkpointIsComplete(db: D1Database, org: string, checkpoint: Checkpoint): Promise<boolean> {
  const [orgResult, rosterResult] = await db.batch([
    db.prepare("SELECT COUNT(*) AS row_count FROM org_events WHERE org = ? AND id <= ?")
      .bind(org, checkpoint.orgEventId),
    db.prepare("SELECT COUNT(*) AS row_count FROM roster_events WHERE org = ? AND id <= ?")
      .bind(org, checkpoint.rosterEventId),
  ]);
  const orgCount = Number((orgResult.results[0] as { row_count: number } | undefined)?.row_count ?? 0);
  const rosterCount = Number((rosterResult.results[0] as { row_count: number } | undefined)?.row_count ?? 0);
  return orgCount === checkpoint.orgEventCount && rosterCount === checkpoint.rosterEventCount;
}

function publicCheckpoint(checkpoint: Checkpoint): AuditCheckpointType {
  return {
    org_event_id: checkpoint.orgEventId,
    org_event_count: checkpoint.orgEventCount,
    roster_event_id: checkpoint.rosterEventId,
    roster_event_count: checkpoint.rosterEventCount,
  };
}

async function readAcknowledgement(
  db: D1Database, org: string,
): Promise<AuditExportAcknowledgementType | null> {
  const row = await db.prepare(
    "SELECT org_event_id, org_event_count, roster_event_id, roster_event_count, " +
      "acknowledged_by, acknowledged_at FROM audit_export_acknowledgements WHERE org = ?",
  ).bind(org).first<AuditCheckpointType & { acknowledged_by: string; acknowledged_at: number }>();
  if (!row) return null;
  return AuditExportAcknowledgement.parse({
    acknowledged_checkpoint: {
      org_event_id: Number(row.org_event_id),
      org_event_count: Number(row.org_event_count),
      roster_event_id: Number(row.roster_event_id),
      roster_event_count: Number(row.roster_event_count),
    },
    acknowledged_by: row.acknowledged_by,
    acknowledged_at: Number(row.acknowledged_at),
  });
}

function sameCheckpoint(left: AuditCheckpointType, right: Checkpoint): boolean {
  return left.org_event_id === right.orgEventId && left.org_event_count === right.orgEventCount &&
    left.roster_event_id === right.rosterEventId && left.roster_event_count === right.rosterEventCount;
}

function policyFromRequest(row: PolicyRequestRow): AuditRetentionPolicyType {
  return AuditRetentionPolicy.parse({
    event_retention_days: Number(row.requested_days),
    version: Number(row.resulting_version),
    updated_by: row.actor,
    updated_at: Number(row.at),
  });
}

function policyRequestMatches(
  row: PolicyRequestRow, requestedDays: number, expectedVersion: number,
): boolean {
  return Number(row.requested_days) === requestedDays && Number(row.expected_version) === expectedVersion;
}

async function readPolicy(db: D1Database, org: string): Promise<AuditRetentionPolicyType> {
  const row = await db.prepare(
    "SELECT event_retention_days, version, updated_by, updated_at " +
      "FROM audit_retention_policies WHERE org = ?",
  ).bind(org).first<AuditPolicyRow>();
  return retentionPolicyFromRow(row);
}

async function readPolicyRequest(
  db: D1Database, org: string, requestId: string,
): Promise<PolicyRequestRow | null> {
  return db.prepare(
    "SELECT requested_days, expected_version, resulting_version, actor, at " +
      "FROM audit_retention_policy_requests WHERE org = ? AND request_id = ?",
  ).bind(org, requestId).first<PolicyRequestRow>();
}

async function readHoldByCreateRequest(
  db: D1Database, org: string, requestId: string,
): Promise<AuditHoldRow | null> {
  return db.prepare(
    `SELECT ${AUDIT_HOLD_COLUMNS} FROM audit_legal_holds WHERE org = ? AND create_request_id = ?`,
  ).bind(org, requestId).first<AuditHoldRow>();
}

async function readHoldByReleaseRequest(
  db: D1Database, org: string, requestId: string,
): Promise<AuditHoldRow | null> {
  return db.prepare(
    `SELECT ${AUDIT_HOLD_COLUMNS} FROM audit_legal_holds WHERE org = ? AND release_request_id = ?`,
  ).bind(org, requestId).first<AuditHoldRow>();
}

async function readHold(db: D1Database, org: string, holdId: string): Promise<AuditHoldRow | null> {
  return db.prepare(
    `SELECT ${AUDIT_HOLD_COLUMNS} FROM audit_legal_holds WHERE org = ? AND hold_id = ?`,
  ).bind(org, holdId).first<AuditHoldRow>();
}

async function readActiveHold(db: D1Database, org: string): Promise<AuditHoldRow | null> {
  return db.prepare(
    `SELECT ${AUDIT_HOLD_COLUMNS} FROM audit_legal_holds WHERE org = ? AND released_at IS NULL`,
  ).bind(org).first<AuditHoldRow>();
}

function retentionMutationFailed(error: unknown): void {
  console.error("audit retention control mutation failed", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
}

function parseEvaluationTime(url: URL, now: number): number | null {
  const values = url.searchParams.getAll("evaluated_at");
  if (values.length === 0) return now;
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return null;
  const evaluatedAt = Number(values[0]);
  return Number.isSafeInteger(evaluatedAt) && evaluatedAt <= now ? evaluatedAt : null;
}

async function readPage(
  db: D1Database, org: string, query: ExportQuery, checkpoint: Checkpoint, position?: Position,
): Promise<AuditExportEventType[]> {
  const { results } = await db.prepare(
    "SELECT ledger, id, event, action_type, roster_id, actor, actor_type, target_type, target_id, target_role, " +
      "actor_ip, actor_country, description, at FROM (" +
      "SELECT 'org' AS ledger, id, event, action_type, NULL AS roster_id, actor, actor_type, " +
      "target_type, target_id, target_role, actor_ip, actor_country, description, at FROM org_events " +
      "WHERE org = ? AND id <= ? UNION ALL " +
      "SELECT 'roster' AS ledger, id, event, action_type, roster_id, actor, actor_type, " +
      "target_type, target_id, NULL AS target_role, actor_ip, actor_country, description, at FROM roster_events " +
      "WHERE org = ? AND id <= ?) AS combined " +
      "WHERE (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?) " +
      "AND (? IS NULL OR actor = ?) AND (? IS NULL OR event = ?) AND (? IS NULL OR actor_ip = ?) AND (" +
      "? IS NULL OR at > ? OR (at = ? AND (ledger > ? OR (ledger = ? AND id > ?)))) " +
      "ORDER BY at ASC, ledger ASC, id ASC LIMIT ?",
  ).bind(
    org, checkpoint.orgEventId, org, checkpoint.rosterEventId,
    query.after ?? null, query.after ?? null, query.before ?? null, query.before ?? null,
    query.actor ?? null, query.actor ?? null, query.event ?? null, query.event ?? null,
    query.actorIp ?? null, query.actorIp ?? null,
    position?.at ?? null, position?.at ?? null, position?.at ?? null,
    position?.ledger ?? null, position?.ledger ?? null, position?.id ?? null,
    query.pageSize + 1,
  ).all<AuditExportEventType>();
  return results ?? [];
}

export function mountAudit(app: Hono<RelayAppEnv>): void {
  app.get("/v1/audit/retention-readiness", rateLimit(AUDIT_READ, "identity", "audit-retention-read:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const evaluatedAt = parseEvaluationTime(new URL(c.req.url), Date.now());
    if (evaluatedAt === null) return c.json({ error: "invalid evaluation time" }, 400);
    try {
      return c.json(
        await evaluateAuditRetentionReadiness(c.env.DB, identity.org, evaluatedAt),
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      console.error("audit retention readiness failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return c.json({ error: "audit retention readiness unavailable" }, 503);
    }
  });

  app.get("/v1/audit/retention-policy", rateLimit(AUDIT_READ, "identity", "audit-retention-read:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    return c.json(await readPolicy(c.env.DB, identity.org), 200, { "Cache-Control": "no-store" });
  });

  app.put("/v1/audit/retention-policy", rateLimit(AUDIT_WRITE, "identity", "audit-retention-write:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const body = AuditRetentionPolicyUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const existingRequest = await readPolicyRequest(c.env.DB, identity.org, body.data.request_id);
    if (existingRequest) {
      if (!policyRequestMatches(
        existingRequest, body.data.event_retention_days, body.data.expected_version,
      )) return c.json({ error: "request id conflicts with an earlier retention update" }, 409);
      return c.json(policyFromRequest(existingRequest), 200, { "Cache-Control": "no-store" });
    }
    const current = await readPolicy(c.env.DB, identity.org);
    if (current.version !== body.data.expected_version) {
      return c.json({ error: "retention policy version changed", current }, 409);
    }
    const resultingVersion = body.data.expected_version + 1;
    const now = Date.now();
    const [actorIp, actorCountry] = auditLocation(c);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO audit_retention_policies " +
            "(org, event_retention_days, version, updated_by, updated_at, last_request_id) " +
            "SELECT ?, ?, ?, ?, ?, ? WHERE ? = 0 " +
            "ON CONFLICT(org) DO UPDATE SET event_retention_days = excluded.event_retention_days, " +
            "version = audit_retention_policies.version + 1, updated_by = excluded.updated_by, " +
            "updated_at = excluded.updated_at, last_request_id = excluded.last_request_id " +
            "WHERE audit_retention_policies.version = ?",
        ).bind(
          identity.org, body.data.event_retention_days, resultingVersion, identity.handle, now,
          body.data.request_id, body.data.expected_version, body.data.expected_version,
        ),
        c.env.DB.prepare(
          "INSERT INTO audit_retention_policy_requests " +
            "(org, request_id, requested_days, expected_version, resulting_version, actor, at) " +
            "SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (" +
            "SELECT 1 FROM audit_retention_policies WHERE org = ? AND version = ? AND last_request_id = ?) " +
            "AND NOT EXISTS (SELECT 1 FROM audit_retention_policy_requests WHERE org = ? AND request_id = ?)",
        ).bind(
          identity.org, body.data.request_id, body.data.event_retention_days, body.data.expected_version,
          resultingVersion, identity.handle, now,
          identity.org, resultingVersion, body.data.request_id,
          identity.org, body.data.request_id,
        ),
        c.env.DB.prepare(
          "INSERT INTO org_events " +
            "(event_key, event, action_type, org, actor, actor_type, target_type, target_id, target_role, " +
            "actor_ip, actor_country, description, at) " +
            "SELECT ?, ?, 'U', ?, ?, 'handle', 'retention_policy', ?, NULL, ?, ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM audit_retention_policy_requests WHERE org = ? AND request_id = ?) " +
            "AND NOT EXISTS (SELECT 1 FROM org_events WHERE event_key = ?)",
        ).bind(
          `audit-retention:${identity.org}:${body.data.request_id}`,
          AUDIT_RETENTION_UPDATE_EVENT,
          identity.org, identity.handle, "event-retention",
          actorIp, actorCountry,
          `${identity.handle} set audit event retention to ${body.data.event_retention_days} days`, now,
          identity.org, body.data.request_id,
          `audit-retention:${identity.org}:${body.data.request_id}`,
        ),
        orgAuditTrimStatement(c.env.DB, identity.org),
      ]);
    } catch (error) {
      retentionMutationFailed(error);
      return c.json({ error: "audit retention update unavailable" }, 503);
    }
    const storedRequest = await readPolicyRequest(c.env.DB, identity.org, body.data.request_id);
    if (!storedRequest) {
      return c.json({
        error: "retention policy version changed",
        current: await readPolicy(c.env.DB, identity.org),
      }, 409);
    }
    if (!policyRequestMatches(
      storedRequest, body.data.event_retention_days, body.data.expected_version,
    )) return c.json({ error: "request id conflicts with an earlier retention update" }, 409);
    return c.json(policyFromRequest(storedRequest), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v1/audit/legal-holds", rateLimit(AUDIT_READ, "identity", "audit-hold-read:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    return c.json({ active_hold: publicAuditHold(await readActiveHold(c.env.DB, identity.org)) }, 200, {
      "Cache-Control": "no-store",
    });
  });

  app.get("/v1/audit/legal-holds/:holdId", rateLimit(AUDIT_READ, "identity", "audit-hold-read:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const holdId = c.req.param("holdId");
    if (!AUDIT_HOLD_ID_RE.test(holdId)) return c.json({ error: "audit legal hold not found" }, 404);
    const hold = await readHold(c.env.DB, identity.org, holdId);
    if (!hold) return c.json({ error: "audit legal hold not found" }, 404);
    return c.json(publicAuditHold(hold), 200, { "Cache-Control": "no-store" });
  });

  app.post("/v1/audit/legal-holds", rateLimit(AUDIT_WRITE, "identity", "audit-hold-write:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const body = AuditLegalHoldCreateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const existingRequest = await readHoldByCreateRequest(c.env.DB, identity.org, body.data.request_id);
    if (existingRequest) {
      if (existingRequest.reason !== body.data.reason) {
        return c.json({ error: "request id conflicts with an earlier hold" }, 409);
      }
      return c.json(publicAuditHold(existingRequest), 200, { "Cache-Control": "no-store" });
    }
    if (await readActiveHold(c.env.DB, identity.org)) {
      return c.json({ error: "an audit legal hold is already active" }, 409);
    }
    const holdId = `hold_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const [actorIp, actorCountry] = auditLocation(c);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO audit_legal_holds " +
            "(org, hold_id, reason, created_by, created_at, create_request_id) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(identity.org, holdId, body.data.reason, identity.handle, now, body.data.request_id),
        c.env.DB.prepare(
          "INSERT INTO org_events " +
            "(event_key, event, action_type, org, actor, actor_type, target_type, target_id, target_role, " +
            "actor_ip, actor_country, description, at) " +
            "SELECT ?, ?, 'C', ?, ?, 'handle', 'legal_hold', ?, NULL, ?, ?, ?, ? " +
            "WHERE NOT EXISTS (SELECT 1 FROM org_events WHERE event_key = ?)",
        ).bind(
          `audit-hold-create:${identity.org}:${body.data.request_id}`,
          AUDIT_HOLD_CREATE_EVENT,
          identity.org, identity.handle, holdId, actorIp, actorCountry,
          `${identity.handle} created audit legal hold ${holdId}`, now,
          `audit-hold-create:${identity.org}:${body.data.request_id}`,
        ),
        orgAuditTrimStatement(c.env.DB, identity.org),
      ]);
    } catch (error) {
      const racedRequest = await readHoldByCreateRequest(c.env.DB, identity.org, body.data.request_id);
      if (racedRequest && racedRequest.reason === body.data.reason) {
        return c.json(publicAuditHold(racedRequest), 200, { "Cache-Control": "no-store" });
      }
      if (await readActiveHold(c.env.DB, identity.org)) {
        return c.json({ error: "an audit legal hold is already active" }, 409);
      }
      retentionMutationFailed(error);
      return c.json({ error: "audit legal hold unavailable" }, 503);
    }
    return c.json(publicAuditHold(await readHold(c.env.DB, identity.org, holdId)), 201, {
      "Cache-Control": "no-store",
    });
  });

  app.post("/v1/audit/legal-holds/:holdId/release", rateLimit(AUDIT_WRITE, "identity", "audit-hold-write:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const body = AuditLegalHoldReleaseRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const holdId = c.req.param("holdId");
    if (!AUDIT_HOLD_ID_RE.test(holdId)) return c.json({ error: "audit legal hold not found" }, 404);
    const requestReplay = await readHoldByReleaseRequest(c.env.DB, identity.org, body.data.request_id);
    if (requestReplay) {
      if (requestReplay.hold_id !== holdId) {
        return c.json({ error: "request id conflicts with an earlier hold release" }, 409);
      }
      return c.json(publicAuditHold(requestReplay), 200, { "Cache-Control": "no-store" });
    }
    const existing = await readHold(c.env.DB, identity.org, holdId);
    if (!existing) return c.json({ error: "audit legal hold not found" }, 404);
    if (existing.released_at !== null) {
      if (existing.release_request_id !== body.data.request_id) {
        return c.json({ error: "audit legal hold was already released" }, 409);
      }
      return c.json(publicAuditHold(existing), 200, { "Cache-Control": "no-store" });
    }
    const now = Date.now();
    const [actorIp, actorCountry] = auditLocation(c);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE audit_legal_holds SET released_by = ?, released_at = ?, release_request_id = ? " +
            "WHERE org = ? AND hold_id = ? AND released_at IS NULL",
        ).bind(identity.handle, now, body.data.request_id, identity.org, holdId),
        c.env.DB.prepare(
          "INSERT INTO org_events " +
            "(event_key, event, action_type, org, actor, actor_type, target_type, target_id, target_role, " +
            "actor_ip, actor_country, description, at) " +
            "SELECT ?, ?, 'U', ?, ?, 'handle', 'legal_hold', ?, NULL, ?, ?, ?, ? " +
            "WHERE changes() > 0",
        ).bind(
          `audit-hold-release:${identity.org}:${body.data.request_id}`,
          AUDIT_HOLD_RELEASE_EVENT,
          identity.org, identity.handle, holdId, actorIp, actorCountry,
          `${identity.handle} released audit legal hold ${holdId}`, now,
        ),
        orgAuditTrimStatement(c.env.DB, identity.org),
      ]);
    } catch (error) {
      const racedRequest = await readHoldByReleaseRequest(c.env.DB, identity.org, body.data.request_id);
      if (racedRequest) {
        if (racedRequest.hold_id !== holdId) {
          return c.json({ error: "request id conflicts with an earlier hold release" }, 409);
        }
        return c.json(publicAuditHold(racedRequest), 200, { "Cache-Control": "no-store" });
      }
      retentionMutationFailed(error);
      return c.json({ error: "audit legal hold release unavailable" }, 503);
    }
    const released = await readHold(c.env.DB, identity.org, holdId);
    if (!released || released.release_request_id !== body.data.request_id) {
      return c.json({ error: "audit legal hold was already released" }, 409);
    }
    return c.json(publicAuditHold(released), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v1/audit/events", rateLimit(AUDIT_READ, "identity", "audit-export:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const query = parseQuery(new URL(c.req.url));
    if (!query) return c.json({ error: "invalid audit export parameters" }, 400);
    const secret = c.env.BOOTSTRAP_TOKEN;
    if (!secret) return c.json({ error: "audit export unavailable" }, 503);
    const cursor = query.pageToken
      ? await decodeCursor(query.pageToken, secret, identity.org, identity.handle, query)
      : undefined;
    if (query.pageToken && !cursor) return c.json({ error: "invalid page token" }, 400);
    const checkpoint = cursor?.checkpoint ?? await captureCheckpoint(c.env.DB, identity.org);
    const rows = await readPage(c.env.DB, identity.org, query, checkpoint, cursor?.position);
    // Validate after reading. A deletion before/during the page read changes
    // the count here; a deletion after this check is caught by the next page,
    // while a final page already contains every remaining checkpointed row.
    if (!(await checkpointIsComplete(c.env.DB, identity.org, checkpoint))) {
      return c.json({ error: "audit snapshot changed; restart export" }, 409);
    }
    const events = rows.slice(0, query.pageSize);
    const last = events.at(-1);
    const nextPageToken = rows.length > query.pageSize && last
      ? await encodeCursor({
        org: identity.org, handle: identity.handle,
        after: query.after ?? null, before: query.before ?? null, pageSize: query.pageSize,
        filterDigest: await filterDigest(query),
        checkpoint,
        position: { at: last.at, ledger: last.ledger, id: last.id },
      }, secret)
      : "";
    const fullLedger = query.after === undefined && query.before === undefined &&
      query.actor === undefined && query.event === undefined && query.actorIp === undefined;
    const acknowledgement = await readAcknowledgement(c.env.DB, identity.org);
    const response: AuditExportPageType = {
      events,
      checkpoint: publicCheckpoint(checkpoint),
      next_page_token: nextPageToken,
      completion_receipt: fullLedger && nextPageToken === ""
        ? await encodeCompletionReceipt(identity.org, checkpoint, secret)
        : null,
      acknowledged_checkpoint: acknowledgement?.acknowledged_checkpoint ?? null,
    };
    const body = JSON.stringify(AuditExportPage.parse(response));
    const etag = `"${await sha256Hex(body)}"`;
    const headers = { ...AUDIT_CACHE_HEADERS, ETag: etag };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=UTF-8" },
    });
  });

  app.post("/v1/audit/export-acknowledgements", rateLimit(AUDIT_WRITE, "identity", "audit-ack:"), requireAdmin, async (c) => {
    const identity = c.var.identity;
    const body = AuditExportAcknowledgementRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const secret = c.env.BOOTSTRAP_TOKEN;
    if (!secret) return c.json({ error: "audit export unavailable" }, 503);
    const receipt = await decodeCompletionReceipt(body.data.completion_receipt, secret, identity.org);
    if (!receipt) return c.json({ error: "invalid completion receipt" }, 400);
    const checkpoint = receipt.checkpoint;
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO audit_export_acknowledgements (" +
        "org, org_event_id, org_event_count, roster_event_id, roster_event_count, acknowledged_by, acknowledged_at" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org) DO UPDATE SET " +
        "org_event_id = excluded.org_event_id, org_event_count = excluded.org_event_count, " +
        "roster_event_id = excluded.roster_event_id, roster_event_count = excluded.roster_event_count, " +
        "acknowledged_by = excluded.acknowledged_by, acknowledged_at = excluded.acknowledged_at " +
        "WHERE excluded.org_event_id >= audit_export_acknowledgements.org_event_id " +
        "AND excluded.roster_event_id >= audit_export_acknowledgements.roster_event_id " +
        "AND (excluded.org_event_id > audit_export_acknowledgements.org_event_id " +
        "OR excluded.roster_event_id > audit_export_acknowledgements.roster_event_id)",
    ).bind(
      identity.org, checkpoint.orgEventId, checkpoint.orgEventCount,
      checkpoint.rosterEventId, checkpoint.rosterEventCount, identity.handle, now,
    ).run();
    const acknowledgement = await readAcknowledgement(c.env.DB, identity.org);
    if (!acknowledgement) return c.json({ error: "audit acknowledgement unavailable" }, 503);
    if (!sameCheckpoint(acknowledgement.acknowledged_checkpoint, checkpoint)) {
      return c.json({ error: "completion receipt is older than the acknowledged checkpoint" }, 409);
    }
    return c.json(acknowledgement, 200, { "Cache-Control": "no-store" });
  });
}
