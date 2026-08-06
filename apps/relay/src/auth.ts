import { randomBase64Url } from "@benree/agentcall-shared";

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  return randomBase64Url(32);
}

// Workers runtime doesn't expose Node's crypto.timingSafeEqual, so this
// compares two same-length hex digests byte-by-byte with no early exit on
// content (only on length, which reveals nothing since both sides are
// always 64-char SHA-256 hex here).
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Still looked up by the caller-supplied (org, handle) — the token proves
// knowledge of this row's secret, it does not select the principal. #154
// slice 3 inverts that by finding the credential first and taking agent_id
// from it. This slice only carries the id outward so slices 4-7 can key on
// identity.agentId without each re-querying handles.
export async function authenticatedHandle(
  db: D1Database, org: string, handle: string, token: string,
): Promise<{ agentId: string; role: OrgRoleType; recoveryGeneration: number } | null> {
  const row = await db.prepare(
    "SELECT token_hash, org_role, recovery_generation, agent_id FROM handles WHERE org = ? AND handle = ?",
  ).bind(org, handle).first<{
    token_hash: string; org_role: OrgRoleType; recovery_generation: number; agent_id: string | null;
  }>();
  if (!row || !constantTimeEqual(row.token_hash, await sha256Hex(token))) return null;
  // Unreachable while 0019's trigger holds. Refused rather than coerced
  // anyway: an authenticated identity with no principal is the state every
  // later slice keys off, so it must not be constructible even if some
  // future write path bypasses the trigger.
  if (!row.agent_id) return null;
  return { agentId: row.agent_id, role: row.org_role, recoveryGeneration: row.recovery_generation };
}
import type { OrgRoleType } from "@benree/agentcall-shared";
