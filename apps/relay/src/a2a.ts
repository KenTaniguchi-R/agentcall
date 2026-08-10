import type { Context, Hono, MiddlewareHandler } from "hono";
// Type-only, so the index -> a2a -> index cycle is erased at compile time and
// never exists at runtime. Do not turn this into a value import.
import {
  A2ACancelTaskRequest, A2A_VERSION_HEADER, a2aError, isSupportedA2AVersion,
  standardError, toAgentCard, toDirectoryCard, visibleTasks,
} from "@benree/agentcall-shared";
import { authenticateRequest, identityObjectName } from "./tenant.js";
import { resolveAgentId } from "./identity.js";
import { NATIVE_READ } from "./ratelimit/index.js";
import { parseStoredCard } from "./stored-card.js";
import type { RelayAppEnv } from "./middleware.js";
import { jsonBody, rateLimit } from "./middleware.js";

// The card endpoint is public and cheap; a short TTL keeps the TCK's
// Cache-Control/ETag checks satisfied without making policy edits slow to
// propagate. `updated_at` supplies a real Last-Modified and a stable ETag.
const CARD_MAX_AGE = 300;
const A2A_CONTENT_TYPE = "application/a2a+json";
const A2A_HEADERS = { "Content-Type": A2A_CONTENT_TYPE } as const;

type A2AContext = Context<RelayAppEnv>;
type TaskAccess = { caller: string; cursorKey: string; cursorScope: string; stub: DurableObjectStub };

async function taskCursorKey(req: A2AContext["req"]): Promise<string> {
  const token = (req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const material = new TextEncoder().encode(`agentcall-a2a-task-cursor\0${token}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizeTaskAccess(c: A2AContext): Promise<TaskAccess | Response> {
  const identity = c.var.identity;
  const target = c.req.param("handle") ?? "";
  const targetAgentId = await resolveAgentId(c.env.DB, identity.org, target);
  if (!targetAgentId) return c.json({ error: "not found" }, 404);
  // cursorScope is persisted inside issued cursor tokens, so moving it to the
  // stable identity also means a cursor keeps pointing at the same object
  // across a future rename instead of silently addressing a fresh one. Any
  // cursor issued under the old scope stops validating, which is correct: it
  // named an object that is no longer the one being read.
  const cursorScope = identityObjectName({ org: identity.org, agentId: targetAgentId });
  return {
    caller: identity.handle,
    cursorKey: await taskCursorKey(c.req),
    cursorScope,
    stub: c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(cursorScope)),
  };
}

function forwardTaskRequest(access: TaskAccess, path: string, search = "", method = "GET"): Promise<Response> {
  return access.stub.fetch(new Request(`https://do${path}${search}`, {
    method,
    headers: {
      "X-Verified-From": access.caller,
      "X-Task-Cursor-Key": access.cursorKey,
      "X-Task-Cursor-Scope": access.cursorScope,
    },
  }));
}

function taskPathSuffix(c: A2AContext): string {
  const handle = c.req.param("handle") ?? "";
  const prefix = `/v1/a2a/${handle}/tasks/`;
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(path.slice(prefix.length));
  } catch {
    return "";
  }
}

function cardHeaders(etagSource: string, updatedAtMs: number): Record<string, string> {
  return {
    ...A2A_HEADERS,
    "Cache-Control": `public, max-age=${CARD_MAX_AGE}`,
    ETag: `"${etagSource}"`,
    "Last-Modified": new Date(updatedAtMs).toUTCString(),
  };
}

function privateCardHeaders(etagSource: string, updatedAtMs: number): Record<string, string> {
  return {
    ...A2A_HEADERS,
    "Cache-Control": "private, no-store",
    ETag: `"${etagSource}"`,
    "Last-Modified": new Date(updatedAtMs).toUTCString(),
  };
}

export function mountA2A(app: Hono<RelayAppEnv>): void {
  // A2A keeps its application/a2a+json error contract, so it has a narrow
  // route-local identity seam while the shared /v1 middleware deliberately
  // leaves these protocol handlers alone.
  const requireA2AIdentity: MiddlewareHandler<RelayAppEnv> = async (c, next) => {
    const identity = await authenticateRequest(c.env, c.req);
    if (!identity) {
      const { status, body } = standardError(401, "unauthorized");
      return c.json(body, status as 401, A2A_HEADERS);
    }
    c.set("identity", identity);
    await next();
  };
  const requireA2AVersion: MiddlewareHandler<RelayAppEnv> = async (c, next) => {
    const version = c.req.header(A2A_VERSION_HEADER) ?? c.req.query(A2A_VERSION_HEADER);
    if (!isSupportedA2AVersion(version)) {
      const { status, body } = a2aError("VersionNotSupported", `unsupported A2A-Version: ${version}`);
      return c.json(body, status as 400, A2A_HEADERS);
    }
    await next();
  };
  const a2aRateLimited = (c: A2AContext) => {
    const { status, body } = standardError(429, "rate limited");
    return c.json(body, status as 429, A2A_HEADERS);
  };
  app.use("/v1/a2a/:handle/agent-card.json", requireA2AIdentity);
  app.use("/v1/a2a/:handle/tasks", requireA2AIdentity);
  app.use("/v1/a2a/:handle/tasks/*", requireA2AIdentity);

  app.get("/.well-known/agent-card.json", (c) => {
    const version = c.req.header(A2A_VERSION_HEADER);
    if (!isSupportedA2AVersion(version)) {
      const { status, body } = a2aError("VersionNotSupported", `unsupported A2A-Version: ${version}`);
      return c.json(body, status as 400, A2A_HEADERS);
    }
    const origin = new URL(c.req.url).origin;
    const card = toDirectoryCard({ origin });
    return c.json(card, 200, cardHeaders(`dir-${CARD_MAX_AGE}`, 0));
  });

  app.get("/v1/a2a/:handle/agent-card.json", requireA2AVersion, rateLimit(NATIVE_READ, "ip", "", a2aRateLimited), async (c) => {
    const identity = c.var.identity;
    const { org, handle: viewer } = identity;

    const handle = c.req.param("handle");
    const targetAgentId = await resolveAgentId(c.env.DB, org, handle);
    const row = targetAgentId
      ? await c.env.DB.prepare(
        "SELECT card_json, updated_at FROM cards WHERE org = ? AND agent_id = ?",
      ).bind(org, targetAgentId).first<{ card_json: string; updated_at: number }>()
      : null;

    // §3.3.2 Resource category — a plain 404, NOT TaskNotFoundError, which is
    // an A2A-specific error about tasks and would be semantically wrong for a
    // missing agent. The same section requires that servers MUST NOT reveal
    // the existence of resources the client is not authorized to access and
    // SHOULD NOT distinguish "does not exist" from "not authorized", so an
    // unknown handle and a blocked caller must be indistinguishable here. Keep
    // the message generic for that reason.
    const notFound = () => {
      const { status, body } = standardError(404, "no such agent");
      return c.json(body, status as 404, A2A_HEADERS);
    };
    if (!row) return notFound();

    const upload = parseStoredCard(row.card_json, org, handle);
    if (!upload || upload.blocked.includes(viewer)) return notFound();
    const origin = new URL(c.req.url).origin;
    const card = toAgentCard({
      handle,
      description: upload.description,
      // A card carries no per-group task grants since #379.
      tasks: visibleTasks(upload, viewer),
      baseUrl: `${origin}/v1/a2a/${handle}`,
      offlineDelivery: upload.offline_delivery.enabled,
    });

    return c.json(card, 200, privateCardHeaders(`${org}-${viewer}-${handle}-${row.updated_at}`, row.updated_at));
  });

  app.get("/v1/a2a/:handle/tasks", requireA2AVersion, rateLimit(NATIVE_READ, "ip", "", a2aRateLimited), async (c) => {
    const access = await authorizeTaskAccess(c);
    if (access instanceof Response) return access;
    return forwardTaskRequest(access, "/tasks", new URL(c.req.url).search);
  });

  app.get("/v1/a2a/:handle/tasks/*", requireA2AVersion, rateLimit(NATIVE_READ, "ip", "", a2aRateLimited), async (c) => {
    const access = await authorizeTaskAccess(c);
    if (access instanceof Response) return access;
    const id = taskPathSuffix(c);
    if (!id || id.includes("/") || id.includes(":")) {
      const { status, body } = a2aError("TaskNotFound", "task does not exist or is not accessible");
      return c.json(body, status as 404, A2A_HEADERS);
    }
    return forwardTaskRequest(access, `/tasks/${encodeURIComponent(id)}`, new URL(c.req.url).search);
  });

  app.post("/v1/a2a/:handle/tasks/*", requireA2AVersion, rateLimit(NATIVE_READ, "ip", "", a2aRateLimited), async (c) => {
    const access = await authorizeTaskAccess(c);
    if (access instanceof Response) return access;
    const operation = taskPathSuffix(c);
    const match = /^([^/:]+):cancel$/.exec(operation);
    if (!match) {
      const { status, body } = standardError(404, "unknown operation");
      return c.json(body, status as 404, A2A_HEADERS);
    }
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== A2A_CONTENT_TYPE) {
      const { status, body } = a2aError("ContentTypeNotSupported", "expected application/a2a+json");
      return c.json(body, status as 415, A2A_HEADERS);
    }
    const body = await jsonBody(c, A2ACancelTaskRequest);
    if (!body) {
      const { status, body: error } = standardError(400, "invalid cancel request");
      return c.json(error, status as 400, A2A_HEADERS);
    }
    return forwardTaskRequest(access, `/tasks/${encodeURIComponent(match[1]!)}:cancel`, "", "POST");
  });
}
