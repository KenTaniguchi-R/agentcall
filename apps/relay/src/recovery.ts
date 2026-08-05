import type { Hono } from "hono";
import {
  RecoveryIssueRequest, RecoveryRedeemRequest, type RecoveryRedeemRequestType,
} from "@benree/agentcall-shared";
import { constantTimeEqual, sha256Hex } from "./auth.js";
import { checkLimit, REGISTER } from "./ratelimit/index.js";
import { jsonBody, rateLimit, type RelayAppEnv } from "./middleware.js";
import type { Env } from "./index.js";
import { orgAuditStatement, orgAuditTrimStatement } from "./events.js";
import {
  deploymentOrgAllows, identityObjectName,
} from "./tenant.js";
import { resolveAgentId } from "./identity.js";

const RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;

type StoredReceipt = {
  org: string;
  handle: string;
  consumed_generation: number;
  operation_id: string;
  consumed_recovery_hash: string;
  client_token_hash: string;
  client_public_id: string;
  successor_recovery_hash: string;
  successor_recovery_public_id: string;
  committed_at: number;
};

const publicId = (kind: "act" | "agr", digest: string) => `${kind}_${digest.slice(0, 16)}`;

function validPublicIds(body: RecoveryRedeemRequestType): boolean {
  return body.client_public_id === publicId("act", body.client_token_digest) &&
    body.successor_recovery_public_id === publicId("agr", body.successor_recovery_digest);
}

const MAX_EVICTIONS_PER_ALARM = 50;
const MAX_EVICTION_BACKOFF_MS = 60 * 60_000;
type EvictionEnv = Pick<Env, "DB" | "HANDLE_DO">;

// Resolved here rather than at the five call sites: they all address the job
// by (org, handle) because recovery_evictions is keyed that way, and the
// object name is the only thing that needs the identity.
async function evict(env: EvictionEnv, org: string, handle: string, generation: number): Promise<boolean> {
  try {
    const agentId = await resolveAgentId(env.DB, org, handle);
    if (!agentId) {
      // No identity behind the address means no object to evict from. Drop
      // the job instead of retrying it forever against nothing. Unreachable
      // today — handles cannot be released yet — but this queue retries with
      // backoff and an orphan would never drain on its own.
      await env.DB.prepare(
        "DELETE FROM recovery_evictions WHERE org = ? AND handle = ? AND recovery_generation = ?",
      ).bind(org, handle, generation).run();
      return true;
    }
    const stub = env.HANDLE_DO.get(env.HANDLE_DO.idFromName(identityObjectName({ org, agentId })));
    if (!(await stub.fetch("https://do/credentials/evict", {
      method: "POST",
      headers: {
        "X-Credential-Org": org,
        "X-Credential-Handle": handle,
        // The floor is durable DO state, so it is keyed by the identity while
        // the handle above only matches live sockets for this request.
        "X-Credential-Agent-Id": agentId,
        "X-Recovery-Generation": String(generation),
      },
    })).ok) throw new Error("eviction rejected");
    await env.DB.prepare(
      "DELETE FROM recovery_evictions WHERE org = ? AND handle = ? AND recovery_generation = ?",
    ).bind(org, handle, generation).run();
    return true;
  } catch {
    const row = await env.DB.prepare(
      "SELECT attempts FROM recovery_evictions WHERE org = ? AND handle = ? AND recovery_generation = ?",
    ).bind(org, handle, generation).first<{ attempts: number }>();
    if (row) {
      const attempts = row.attempts + 1;
      const delay = Math.min(5 * 60_000 * (2 ** Math.min(attempts - 1, 8)), MAX_EVICTION_BACKOFF_MS);
      await env.DB.prepare(
        "UPDATE recovery_evictions SET attempts = ?, last_attempt = ?, next_attempt = ? " +
          "WHERE org = ? AND handle = ? AND recovery_generation = ?",
      ).bind(attempts, Date.now(), Date.now() + delay, org, handle, generation).run();
    }
    return false;
  }
}

export async function drainRecoveryEvictions(env: EvictionEnv): Promise<void> {
  const now = Date.now();
  const jobs = await env.DB.prepare(
    "SELECT org, handle, recovery_generation FROM recovery_evictions " +
      "WHERE next_attempt <= ? ORDER BY next_attempt LIMIT ?",
  ).bind(now, MAX_EVICTIONS_PER_ALARM).all<{
    org: string; handle: string; recovery_generation: number;
  }>();
  for (const job of jobs.results ?? []) {
    await evict(env, job.org, job.handle, job.recovery_generation);
  }
}

function receiptJson(row: StoredReceipt, evictionConfirmed: boolean) {
  return {
    org: row.org,
    handle: row.handle,
    operation_id: row.operation_id,
    consumed_generation: row.consumed_generation,
    recovery_generation: row.consumed_generation + 1,
    client_public_id: row.client_public_id,
    recovery_public_id: row.successor_recovery_public_id,
    committed_at: row.committed_at,
    eviction_confirmed: evictionConfirmed,
  };
}

async function findReceipt(
  env: Env, request: RecoveryRedeemRequestType, now: number,
): Promise<StoredReceipt | null> {
  return env.DB.prepare(
    "SELECT org, handle, consumed_generation, operation_id, consumed_recovery_hash, " +
      "client_token_hash, client_public_id, successor_recovery_hash, successor_recovery_public_id, committed_at " +
      "FROM recovery_receipts WHERE org = ? AND handle = ? AND consumed_generation = ? " +
      "AND operation_id = ? AND expires_at > ?",
  ).bind(request.org, request.handle, request.generation, request.operation_id, now).first<StoredReceipt>();
}

function exactReceipt(row: StoredReceipt, request: RecoveryRedeemRequestType, currentHash: string): boolean {
  return constantTimeEqual(row.consumed_recovery_hash, currentHash) &&
    constantTimeEqual(row.client_token_hash, request.client_token_digest) &&
    row.client_public_id === request.client_public_id &&
    constantTimeEqual(row.successor_recovery_hash, request.successor_recovery_digest) &&
    row.successor_recovery_public_id === request.successor_recovery_public_id;
}

export function mountRecovery(app: Hono<RelayAppEnv>): void {
  app.get("/v1/recovery/status", async (c) => {
    const identity = c.var.identity;
    const row = await c.env.DB.prepare(
      "SELECT recovery_hash, recovery_generation FROM handles WHERE org = ? AND handle = ?",
    ).bind(identity.org, identity.handle).first<{ recovery_hash: string | null; recovery_generation: number }>();
    const issued = !!row?.recovery_hash && (row.recovery_generation ?? 0) > 0;
    return c.json({
      issued,
      generation: row?.recovery_generation ?? 0,
      ...(issued ? { recovery_public_id: publicId("agr", row!.recovery_hash!) } : {}),
    });
  });

  app.post("/v1/recovery/issue", rateLimit(REGISTER, "identity", "recovery-issue:"), async (c) => {
    const identity = c.var.identity;
    const body = await jsonBody(c, RecoveryIssueRequest);
    if (!body || body.successor_recovery_public_id !==
      publicId("agr", body.successor_recovery_digest)) {
      return c.json({ error: "invalid request" }, 400);
    }
    const presented = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const now = Date.now();
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE handles SET recovery_hash = ?, recovery_generation = recovery_generation + 1, " +
          "recovery_redeemed_at = NULL WHERE org = ? AND handle = ? AND token_hash = ? " +
          "AND recovery_generation = ?",
      ).bind(
        body.successor_recovery_digest, identity.org, identity.handle, await sha256Hex(presented),
        body.expected_generation,
      ),
      orgAuditStatement(c, {
        event: "credential.recovery.issue", action: "U", org: identity.org,
        actor: identity.handle, actorType: "handle", targetType: "handle", targetId: identity.handle,
        description: `${identity.handle} issued a new recovery generation`, at: now,
      }, "previous-change"),
      orgAuditTrimStatement(c.env.DB, identity.org),
    ]);
    if ((result[0].meta.changes ?? 0) !== 1) return c.json({ error: "credential changed" }, 409);
    return c.json({
      generation: body.expected_generation + 1,
      recovery_public_id: body.successor_recovery_public_id,
    });
  });

  app.post("/v1/recovery/redeem", async (c) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await checkLimit(c.env, `recovery-ip:${ip}`, REGISTER))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const body = await jsonBody(c, RecoveryRedeemRequest);
    if (!body || !validPublicIds(body) ||
      !deploymentOrgAllows(c.env.DEPLOYMENT_MODE, c.env.SELF_HOSTED_ORG, body.org)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const request = body;
    const currentHash = await sha256Hex(request.current_recovery_proof);
    if (!(await checkLimit(c.env, `recovery-proof:${currentHash.slice(0, 16)}`, REGISTER))) {
      return c.json({ error: "rate limited" }, 429);
    }
    const now = Date.now();

    const replay = await findReceipt(c.env, request, now);
    if (replay) {
      if (!exactReceipt(replay, request, currentHash)) return c.json({ error: "unauthorized" }, 401);
      return c.json(receiptJson(replay, await evict(c.env, request.org, request.handle, request.generation + 1)));
    }

    const live = await c.env.DB.prepare(
      "SELECT recovery_hash, recovery_generation FROM handles WHERE org = ? AND handle = ?",
    ).bind(request.org, request.handle).first<{ recovery_hash: string | null; recovery_generation: number }>();
    if (!live?.recovery_hash || live.recovery_generation !== request.generation ||
      !constantTimeEqual(live.recovery_hash, currentHash)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const expiresAt = now + RECEIPT_TTL_MS;
    let results: D1Result[];
    try {
      results = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO recovery_receipts (org, handle, consumed_generation, operation_id, " +
          "consumed_recovery_hash, client_token_hash, client_public_id, successor_recovery_hash, " +
          "successor_recovery_public_id, committed_at, expires_at) " +
          "SELECT org, handle, recovery_generation, ?, recovery_hash, ?, ?, ?, ?, ?, ? FROM handles " +
          "WHERE org = ? AND handle = ? AND recovery_generation = ? AND recovery_hash = ?",
      ).bind(
        request.operation_id, request.client_token_digest, request.client_public_id,
        request.successor_recovery_digest, request.successor_recovery_public_id, now, expiresAt,
        request.org, request.handle, request.generation, currentHash,
      ),
      c.env.DB.prepare(
        "UPDATE handles SET token_hash = ?, recovery_hash = ?, recovery_generation = ?, recovery_redeemed_at = ? " +
          "WHERE org = ? AND handle = ? AND recovery_generation = ? AND recovery_hash = ? " +
          "AND EXISTS (SELECT 1 FROM recovery_receipts WHERE org = ? AND handle = ? " +
          "AND consumed_generation = ? AND operation_id = ?)",
      ).bind(
        request.client_token_digest, request.successor_recovery_digest, request.generation + 1, now,
        request.org, request.handle, request.generation, currentHash,
        request.org, request.handle, request.generation, request.operation_id,
      ),
      orgAuditStatement(c, {
        eventKey: `recovery:${request.org}:${request.handle}:${request.generation}:${request.operation_id}`,
        event: "credential.recovery.redeem", action: "U", org: request.org,
        actor: publicId("agr", currentHash), actorType: "recovery",
        targetType: "handle", targetId: request.handle,
        description: `Recovery generation ${request.generation} reset ${request.handle}'s online credential`, at: now,
      }, "previous-change"),
      c.env.DB.prepare(
        "INSERT INTO recovery_evictions (org, handle, recovery_generation, attempts, next_attempt) " +
          "SELECT ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM handles WHERE org = ? AND handle = ? " +
          "AND recovery_generation = ? AND token_hash = ? AND recovery_hash = ?) " +
          "AND EXISTS (SELECT 1 FROM recovery_receipts WHERE org = ? AND handle = ? " +
          "AND consumed_generation = ? AND operation_id = ?) " +
          "ON CONFLICT(org, handle) DO UPDATE SET " +
          "recovery_generation = excluded.recovery_generation, attempts = 0, " +
          "next_attempt = excluded.next_attempt, last_attempt = NULL",
      ).bind(
        request.org, request.handle, request.generation + 1, now,
        request.org, request.handle, request.generation + 1,
        request.client_token_digest, request.successor_recovery_digest,
        request.org, request.handle, request.generation, request.operation_id,
      ),
      c.env.DB.prepare("DELETE FROM recovery_receipts WHERE expires_at <= ?").bind(now),
      orgAuditTrimStatement(c.env.DB, request.org),
      ]);
    } catch (error) {
      // Two identical first attempts can both read before either commits. The
      // receipt primary key elects one; the loser returns that exact receipt
      // instead of surfacing the uniqueness race as a server error.
      const concurrent = await findReceipt(c.env, request, now);
      if (concurrent && exactReceipt(concurrent, request, currentHash)) {
        return c.json(receiptJson(concurrent, await evict(c.env, request.org, request.handle, request.generation + 1)));
      }
      console.error("recovery transaction failure", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return c.json({ error: "recovery temporarily unavailable" }, 503);
    }
    if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
      const concurrent = await findReceipt(c.env, request, now);
      if (concurrent && exactReceipt(concurrent, request, currentHash)) {
        return c.json(receiptJson(concurrent, await evict(c.env, request.org, request.handle, request.generation + 1)));
      }
      return c.json({ error: "unauthorized" }, 401);
    }
    const stored: StoredReceipt = {
      org: request.org, handle: request.handle, consumed_generation: request.generation,
      operation_id: request.operation_id, consumed_recovery_hash: currentHash,
      client_token_hash: request.client_token_digest, client_public_id: request.client_public_id,
      successor_recovery_hash: request.successor_recovery_digest,
      successor_recovery_public_id: request.successor_recovery_public_id, committed_at: now,
    };
    return c.json(receiptJson(stored, await evict(c.env, request.org, request.handle, request.generation + 1)));
  });
}
