import type { Hono } from "hono";
// Type-only, so the index -> a2a -> index cycle is erased at compile time and
// never exists at runtime. Do not turn this into a value import.
import type { Env } from "./index.js";
import {
  A2A_VERSION_HEADER, CardUpload, a2aError, isSupportedA2AVersion,
  standardError, toAgentCard, toDirectoryCard,
} from "@benree/agentcall-shared";

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

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.READ_RL.limit({ key: ip })).success) {
      const { status, body } = standardError(429, "rate limited");
      return c.json(body, status as 429);
    }

    const handle = c.req.param("handle");
    const row = await c.env.DB.prepare(
      "SELECT card_json, updated_at FROM cards WHERE handle = ?",
    ).bind(handle).first<{ card_json: string; updated_at: number }>();

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
    // Public view only in this plan: default_offer, never per-caller grants.
    // The authenticated extended view is GetExtendedAgentCard, which arrives
    // with the operations in Plan 2.
    const visible = new Set(upload.default_offer);
    const origin = new URL(c.req.url).origin;
    const card = toAgentCard({
      handle,
      description: upload.description,
      tasks: upload.tasks.filter((t) => visible.has(t.id)),
      baseUrl: `${origin}/v1/a2a/${handle}`,
    });

    return c.json(card, 200, cardHeaders(`${handle}-${row.updated_at}`, row.updated_at));
  });
}
