import type { Hono } from "hono";
import {
  AuditExportAcknowledgement, AuditExportAcknowledgementRequest, AuditExportPage,
  type AuditCheckpointType, type AuditExportAcknowledgementType,
  type AuditExportEventType, type AuditExportPageType,
} from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { sha256Hex } from "./auth.js";
import { AUDIT_READ, AUDIT_WRITE, checkLimit } from "./ratelimit/index.js";
import { authenticateRequest, requireOrgAdmin } from "./tenant.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_PAGE_TOKEN_LENGTH = 2_048;
const MAX_COMPLETION_RECEIPT_LENGTH = 1_024;
const MAX_FILTER_LENGTH = 256;
const AUDIT_CACHE_HEADERS = {
  "Cache-Control": "private, no-cache, no-transform",
  Vary: "Authorization, X-AgentCall-Org, X-AgentCall-Handle",
} as const;

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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    // Different nonzero unused pad bits can decode to the same bytes. Requiring
    // the canonical round trip prevents a textually modified signed token from
    // verifying as an alias of the token the relay actually issued.
    return base64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
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
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await tokenKey(secret, "cursor"), encoded));
  return `${base64Url(encoded)}.${base64Url(signature)}`;
}

async function filterDigest(query: ExportQuery): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify([
    query.actor ?? null,
    query.event ?? null,
    query.actorIp ?? null,
  ]));
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

async function decodeCursor(
  token: string, secret: string, org: string, handle: string, query: ExportQuery,
): Promise<CursorPayload | null> {
  if (token.length > MAX_PAGE_TOKEN_LENGTH) return null;
  const [payloadValue, signatureValue, extra] = token.split(".");
  if (!payloadValue || !signatureValue || extra !== undefined) return null;
  const payloadBytes = fromBase64Url(payloadValue);
  const signature = fromBase64Url(signatureValue);
  if (!payloadBytes || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await tokenKey(secret, "cursor"),
      signature as Uint8Array<ArrayBuffer>, payloadBytes as Uint8Array<ArrayBuffer>,
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as CursorPayload;
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
  } catch {
    return null;
  }
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
  const encoded = new TextEncoder().encode(JSON.stringify({ version: 1, org, checkpoint }));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", await tokenKey(secret, "completion"), encoded,
  ));
  return `${base64Url(encoded)}.${base64Url(signature)}`;
}

async function decodeCompletionReceipt(
  token: string, secret: string, org: string,
): Promise<CompletionReceiptPayload | null> {
  if (token.length > MAX_COMPLETION_RECEIPT_LENGTH) return null;
  const [payloadValue, signatureValue, extra] = token.split(".");
  if (!payloadValue || !signatureValue || extra !== undefined) return null;
  const payloadBytes = fromBase64Url(payloadValue);
  const signature = fromBase64Url(signatureValue);
  if (!payloadBytes || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await tokenKey(secret, "completion"),
      signature as Uint8Array<ArrayBuffer>, payloadBytes as Uint8Array<ArrayBuffer>,
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as CompletionReceiptPayload;
    if (payload.version !== 1 || payload.org !== org || !validCheckpoint(payload.checkpoint)) return null;
    return payload;
  } catch {
    return null;
  }
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

export function mountAudit(app: Hono<{ Bindings: Env }>): void {
  app.get("/v1/audit/events", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (!requireOrgAdmin(identity)) return c.json({ error: "administrator role required" }, 403);
    const query = parseQuery(new URL(c.req.url));
    if (!query) return c.json({ error: "invalid audit export parameters" }, 400);
    const secret = c.env.BOOTSTRAP_TOKEN;
    if (!secret) return c.json({ error: "audit export unavailable" }, 503);
    if (!(await checkLimit(c.env, `audit-export:${identity.org}:${identity.handle}`, AUDIT_READ))) {
      return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
    }
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

  app.post("/v1/audit/export-acknowledgements", async (c) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (!requireOrgAdmin(identity)) return c.json({ error: "administrator role required" }, 403);
    const body = AuditExportAcknowledgementRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const secret = c.env.BOOTSTRAP_TOKEN;
    if (!secret) return c.json({ error: "audit export unavailable" }, 503);
    if (!(await checkLimit(c.env, `audit-ack:${identity.org}:${identity.handle}`, AUDIT_WRITE))) {
      return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
    }
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
