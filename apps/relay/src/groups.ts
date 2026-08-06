import { MAX_CALLER_GROUPS } from "@benree/agentcall-shared";

// Group identity is relay-owned roster membership. Call admission uses this
// query; the bundle performs the same computation for every member in one
// query, and that ORDER BY/LIMIT pair must stay identical to this one.
//
// Takes stable agent ids, not addresses (#154 slice 6). This is the function
// that turns membership into AUTHORITY — the rosters it returns are attested to
// the callee, which raises the caller's clearance. Keyed by address, a
// reclaimed handle inherited the previous holder's group grants without any row
// being rewritten, which is precisely the transfer the identity/address
// separation exists to prevent.
export async function sharedRosterIds(
  db: D1Database, org: string, callerAgentId: string, calleeAgentId: string,
): Promise<string[]> {
  const { results } = await db.prepare(
    "SELECT caller.roster_id FROM roster_members caller " +
      "JOIN roster_members callee ON callee.roster_id = caller.roster_id AND callee.org = caller.org " +
      "WHERE caller.org = ? AND caller.agent_id = ? AND callee.agent_id = ? " +
      // Deterministic truncation is part of the policy contract. Keep this in
      // lockstep with the bundle's ORDER BY in roster.ts.
      "ORDER BY caller.roster_id LIMIT ?",
  ).bind(org, callerAgentId, calleeAgentId, MAX_CALLER_GROUPS).all<{ roster_id: string }>();
  return (results ?? []).map((row) => row.roster_id);
}
