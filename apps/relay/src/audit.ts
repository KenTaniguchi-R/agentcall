import type { Hono } from "hono";
import {
  AuditExportPage, type AuditExportEventType, type AuditExportPageType,
} from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { AUDIT_READ, checkLimit } from "./ratelimit/index.js";
import { authenticateRequest, requireOrgAdmin } from "./tenant.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_PAGE_TOKEN_LENGTH = 2_048;

type Checkpoint = {
  orgEventId: number;
  orgEventCount: number;
  rosterEventId: number;
  rosterEventCount: number;
};
type Position = { at: number; ledger: "org" | "roster"; id: number };
type ExportQuery = { after?: number; before?: number; pageSize: number; pageToken?: string };
type CursorPayload = {
  org: string;
  handle: string;
  after: number | null;
  before: number | null;
  pageSize: number;
  checkpoint: Checkpoint;
  position: Position;
};

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
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`agentcall-audit-export\0${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function encodeCursor(payload: CursorPayload, secret: string): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await cursorKey(secret), encoded));
  return `${base64Url(encoded)}.${base64Url(signature)}`;
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
      "HMAC", await cursorKey(secret),
      signature as Uint8Array<ArrayBuffer>, payloadBytes as Uint8Array<ArrayBuffer>,
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as CursorPayload;
    if (
      payload.org !== org || payload.handle !== handle ||
      payload.after !== (query.after ?? null) || payload.before !== (query.before ?? null) ||
      payload.pageSize !== query.pageSize ||
      !Number.isSafeInteger(payload.checkpoint?.orgEventId) || payload.checkpoint.orgEventId < 0 ||
      !Number.isSafeInteger(payload.checkpoint?.orgEventCount) || payload.checkpoint.orgEventCount < 0 ||
      !Number.isSafeInteger(payload.checkpoint?.rosterEventId) || payload.checkpoint.rosterEventId < 0 ||
      !Number.isSafeInteger(payload.checkpoint?.rosterEventCount) || payload.checkpoint.rosterEventCount < 0 ||
      !Number.isSafeInteger(payload.position?.at) || payload.position.at < 0 ||
      (payload.position.ledger !== "org" && payload.position.ledger !== "roster") ||
      !Number.isSafeInteger(payload.position.id) || payload.position.id < 1
    ) return null;
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

function parseQuery(url: URL): ExportQuery | null {
  const after = parseInteger(url.searchParams.get("after"));
  const before = parseInteger(url.searchParams.get("before"));
  const pageSize = parseInteger(url.searchParams.get("page_size")) ?? DEFAULT_PAGE_SIZE;
  if (after === null || before === null || pageSize === null || pageSize < 1 || pageSize > MAX_PAGE_SIZE) return null;
  if (after !== undefined && before !== undefined && after >= before) return null;
  return { after, before, pageSize, pageToken: url.searchParams.get("page_token") ?? undefined };
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
      "WHERE (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?) AND (" +
      "? IS NULL OR at > ? OR (at = ? AND (ledger > ? OR (ledger = ? AND id > ?)))) " +
      "ORDER BY at ASC, ledger ASC, id ASC LIMIT ?",
  ).bind(
    org, checkpoint.orgEventId, org, checkpoint.rosterEventId,
    query.after ?? null, query.after ?? null, query.before ?? null, query.before ?? null,
    position?.at ?? null, position?.at ?? null, position?.at ?? null,
    position?.ledger ?? null, position?.ledger ?? null, position?.id ?? null,
    query.pageSize + 1,
  ).all<AuditExportEventType>();
  return results ?? [];
}

export function mountAudit(app: Hono<{ Bindings: Env }>): void {
  app.get("/v1/audit/events", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
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
        checkpoint,
        position: { at: last.at, ledger: last.ledger, id: last.id },
      }, secret)
      : "";
    const response: AuditExportPageType = {
      events,
      checkpoint: {
        org_event_id: checkpoint.orgEventId,
        org_event_count: checkpoint.orgEventCount,
        roster_event_id: checkpoint.rosterEventId,
        roster_event_count: checkpoint.rosterEventCount,
      },
      next_page_token: nextPageToken,
    };
    return c.json(AuditExportPage.parse(response));
  });
}
