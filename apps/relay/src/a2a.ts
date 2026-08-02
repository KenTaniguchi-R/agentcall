import type { Hono } from "hono";
// Type-only, so the index -> a2a -> index cycle is erased at compile time and
// never exists at runtime. Do not turn this into a value import.
import type { Env } from "./index.js";
import {
  A2A_VERSION_HEADER, CardUpload, a2aError, isSupportedA2AVersion,
  standardError, toAgentCard, toDirectoryCard, visibleTasks,
} from "@benree/agentcall-shared";
import { authenticateRequest } from "./tenant.js";
import { sharedRosterIds } from "./groups.js";

// The card endpoint is public and cheap; a short TTL keeps the TCK's
// Cache-Control/ETag checks satisfied without making policy edits slow to
// propagate. `updated_at` supplies a real Last-Modified and a stable ETag.
const CARD_MAX_AGE = 300;

function cardHeaders(etagSource: string, updatedAtMs: number): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${CARD_MAX_AGE}`,
    ETag: `"${etagSource}"`,
    "Last-Modified": new Date(updatedAtMs).toUTCString(),
  };
}

function privateCardHeaders(etagSource: string, updatedAtMs: number): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    ETag: `"${etagSource}"`,
    "Last-Modified": new Date(updatedAtMs).toUTCString(),
  };
}

export function mountA2A(app: Hono<{ Bindings: Env }>): void {
  app.get("/.well-known/agent-card.json", (c) => {
    const version = c.req.header(A2A_VERSION_HEADER);
    if (!isSupportedA2AVersion(version)) {
      const { status, body } = a2aError("VersionNotSupported", `unsupported A2A-Version: ${version}`);
      return c.json(body, status as 400);
    }
    const origin = new URL(c.req.url).origin;
    const card = toDirectoryCard({ origin });
    return c.json(card, 200, cardHeaders(`dir-${CARD_MAX_AGE}`, 0));
  });

  app.get("/v1/a2a/:handle/agent-card.json", async (c) => {
    const version = c.req.header(A2A_VERSION_HEADER);
    if (!isSupportedA2AVersion(version)) {
      const { status, body } = a2aError("VersionNotSupported", `unsupported A2A-Version: ${version}`);
      return c.json(body, status as 400);
    }

    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) {
      const { status, body } = standardError(401, "unauthorized");
      return c.json(body, status as 401);
    }
    const { org, handle: viewer } = identity;

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.READ_RL.limit({ key: ip })).success) {
      const { status, body } = standardError(429, "rate limited");
      return c.json(body, status as 429);
    }

    const handle = c.req.param("handle");
    const row = await c.env.DB.prepare(
      "SELECT card_json, updated_at FROM cards WHERE org = ? AND handle = ?",
    ).bind(org, handle).first<{ card_json: string; updated_at: number }>();

    // §3.3.2 Resource category — a plain 404, NOT TaskNotFoundError, which is
    // an A2A-specific error about tasks and would be semantically wrong for a
    // missing agent. The same section requires that servers MUST NOT reveal
    // the existence of resources the client is not authorized to access and
    // SHOULD NOT distinguish "does not exist" from "not authorized", so an
    // unknown handle and a blocked caller must be indistinguishable here. Keep
    // the message generic for that reason.
    if (!row) {
      const { status, body } = standardError(404, "no such agent");
      return c.json(body, status as 404);
    }

    const upload = CardUpload.parse(JSON.parse(row.card_json));
    if (upload.blocked.includes(viewer)) {
      const { status, body } = standardError(404, "no such agent");
      return c.json(body, status as 404);
    }
    const origin = new URL(c.req.url).origin;
    const card = toAgentCard({
      handle,
      description: upload.description,
      tasks: visibleTasks(upload, viewer, await sharedRosterIds(c.env.DB, org, viewer, handle)),
      baseUrl: `${origin}/v1/a2a/${handle}`,
    });

    return c.json(card, 200, privateCardHeaders(`${org}-${viewer}-${handle}-${row.updated_at}`, row.updated_at));
  });
}
