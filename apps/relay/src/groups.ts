import { MAX_CALLER_GROUPS } from "@benree/agentcall-shared";

// Group identity is relay-owned roster membership. This query is the only
// source of caller groups used by call admission and both card projections;
// keeping it shared prevents discovery and enforcement from drifting.
export async function sharedRosterIds(
  db: D1Database, org: string, caller: string, callee: string,
): Promise<string[]> {
  const { results } = await db.prepare(
    "SELECT caller.roster_id FROM roster_members caller " +
      "JOIN roster_members callee ON callee.roster_id = caller.roster_id AND callee.org = caller.org " +
      "WHERE caller.org = ? AND caller.handle = ? AND callee.handle = ? " +
      "ORDER BY caller.roster_id LIMIT ?",
  ).bind(org, caller, callee, MAX_CALLER_GROUPS).all<{ roster_id: string }>();
  return (results ?? []).map((row) => row.roster_id);
}
