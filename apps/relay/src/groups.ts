import { MAX_CALLER_GROUPS } from "@benree/agentcall-shared";

// Group identity is relay-owned roster membership. Call admission and direct
// card projections use this query. The bundle performs the same computation
// for every member in one query; its ROW_NUMBER ordering and cap must remain
// identical to this ORDER BY/LIMIT pair.
export async function sharedRosterIds(
  db: D1Database, org: string, caller: string, callee: string,
): Promise<string[]> {
  const { results } = await db.prepare(
    "SELECT caller.roster_id FROM roster_members caller " +
      "JOIN roster_members callee ON callee.roster_id = caller.roster_id AND callee.org = caller.org " +
      "WHERE caller.org = ? AND caller.handle = ? AND callee.handle = ? " +
      // Deterministic truncation is part of the policy contract. Keep this in
      // lockstep with ranked_shared in roster.ts.
      "ORDER BY caller.roster_id LIMIT ?",
  ).bind(org, caller, callee, MAX_CALLER_GROUPS).all<{ roster_id: string }>();
  return (results ?? []).map((row) => row.roster_id);
}
