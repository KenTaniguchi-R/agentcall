// Stable agent identity (#154). An agent_id is one principal lifetime inside
// one organization; handle@host is the routing address currently bound to it.
// Later slices move Durable Object naming, cards, roster membership, policy,
// and audit subjects onto this identifier.

// Opaque and random, never derived from the handle, credential, device, or
// signing key -- deriving it would make credential rotation look like a new
// principal, and would make the same handle in two organizations look like
// one. Same prefixed shape as the ids in audit.ts.
export function generateAgentId(): string {
  return `agt_${crypto.randomUUID().replaceAll("-", "")}`;
}

// TEMPORARY (#154 slice 9 deletes this).
//
// The cutover is sequenced as several slices, so for a while some call sites
// key by agent_id while others still key by (org, handle). This resolves the
// old key to the new one so a slice can move without waiting for the rest.
//
// It is a migration aid, not architecture. It does the exact thing the
// decision rejects -- selecting a principal from a caller-supplied handle --
// and every remaining caller of it is remaining work. Authentication must
// never route through it: slice 3 derives agent_id from the verified
// credential, which is the point of the whole change.
export async function resolveAgentId(
  db: D1Database, org: string, handle: string,
): Promise<string | null> {
  const row = await db.prepare(
    "SELECT agent_id FROM handles WHERE org = ? AND handle = ?",
  ).bind(org, handle).first<{ agent_id: string | null }>();
  return row?.agent_id ?? null;
}
