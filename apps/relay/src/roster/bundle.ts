import type { Context } from "hono";
import type { Env } from "../index.js";
import { CardUpload, MAX_BUNDLE_TASKS_PER_CARD, visibleTasks } from "@benree/agentcall-shared";
import { requireMember } from "./guards.js";

export async function handleBundle(
  c: Context<{ Bindings: Env }>,
  id: string,
  viewer: string,
): Promise<Response> {
  const denied = await requireMember(c, id, viewer);
  if (denied) return denied;

  // One bounded join, never N queries. Bounded by MAX_ROSTER_MEMBERS,
  // which join enforces.
  const { results } = await c.env.DB.prepare(
    "SELECT c.handle, c.card_json, c.updated_at FROM roster_members m " +
      "JOIN cards c ON c.handle = m.handle WHERE m.roster_id = ? ORDER BY c.handle",
  ).bind(id).all<{ handle: string; card_json: string; updated_at: number }>();

  const entries = [];
  let skipped = 0;
  let newest = 0;
  for (const row of results ?? []) {
    let upload;
    try {
      upload = CardUpload.parse(JSON.parse(row.card_json));
    } catch {
      // One bad legacy card must not 500 the bundle for everyone else.
      skipped++;
      continue;
    }
    const visible = visibleTasks(upload, viewer);
    // Zero visible tasks means omitted entirely, not an empty entry: an
    // entry carrying a handle would disclose membership. This endpoint is
    // a search index, not an org directory.
    if (visible.length === 0) continue;
    entries.push({
      handle: row.handle,
      agent_kind: upload.agent_kind,
      // `examples` are deliberately dropped — see BundleTask in
      // packages/shared/src/roster.ts.
      tasks: visible.slice(0, MAX_BUNDLE_TASKS_PER_CARD).map((t) => ({
        id: t.id, name: t.name, description: t.description, keywords: t.keywords,
      })),
      updated_at: row.updated_at,
      truncated: visible.length > MAX_BUNDLE_TASKS_PER_CARD,
    });
    if (row.updated_at > newest) newest = row.updated_at;
  }

  // Varies by caller (grants differ), so the ETag must include the viewer
  // and the response must never enter a shared cache.
  const etag = `"${id}-${viewer}-${newest}-${entries.length}-${skipped}"`;
  if (c.req.header("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
  }
  return c.json({ roster_id: id, entries, skipped }, 200, {
    ETag: etag,
    "Cache-Control": "private, no-store",
  });
}
