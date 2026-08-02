import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { BundleEntry, ROSTER_ID_RE } from "@benree/agentcall-shared";
import { NAME_RE } from "./contacts.js";
import { writeJsonAtomic } from "./json-store.js";
import type { LinePaths } from "./paths.js";

// Two stores with DELIBERATELY OPPOSITE corruption policies, kept in one file
// so the contrast is visible where someone might get it wrong:
//
//   rosters.json      user data  -> THROWS. Join keys are discarded at
//                                   join time, so this is the only surviving
//                                   route back into a roster you belong to.
//                                   Resetting it locks the user out for good.
//   roster-cache.json derived    -> REBUILDS. Losing it costs one refetch.

export const CACHE_TTL_MS = 15 * 60 * 1000;

const Membership = z.object({
  name: z.string().min(1),
  relay: z.string().min(1),
  roster_id: z.string().regex(ROSTER_ID_RE),
});
// .loose() so unknown top-level keys survive a load+save round-trip under an
// older CLI, matching contacts.json.
const MembershipsFile = z.object({ rosters: z.array(Membership).default([]) }).loose();
export type Membership = z.infer<typeof Membership>;

const CachedBundle = z.object({
  relay: z.string(),
  caller: z.string(),
  roster_id: z.string(),
  etag: z.string().optional(),
  fetched_at: z.number(),
  entries: z.array(BundleEntry),
  skipped: z.number().default(0),
});
const CacheFile = z.object({ version: z.literal(1), rosters: z.record(z.string(), CachedBundle) });
export type CachedBundle = z.infer<typeof CachedBundle>;

export function loadMemberships(p: LinePaths): Membership[] {
  if (!existsSync(p.rostersFile)) return [];
  try {
    return MembershipsFile.parse(JSON.parse(readFileSync(p.rostersFile, "utf8"))).rosters;
  } catch (e) {
    throw new Error(
      `Corrupt rosters.json at ${p.rostersFile}: ${e instanceof Error ? e.message : String(e)}. ` +
        `This file holds the roster ids you joined; join keys are not recoverable, so it is not reset automatically.`,
    );
  }
}

// Mirrors addContact's NAME_RE check in contacts.ts. UX and consistency only
// (typo-catching, unambiguous CLI arguments) — not a security boundary. A
// computed __proto__ key does not trigger prototype mutation here, and a
// builtin-shadowing name like "constructor" is caught downstream by
// readCached's mandatory relay/caller check.
export function saveMembership(p: LinePaths, m: Membership): void {
  if (!NAME_RE.test(m.name)) {
    throw new Error(`Invalid roster name "${m.name}" — start with a letter or digit, then letters, digits, ".", "_", "-" (no @).`);
  }
  const existing = loadMemberships(p);
  const prior = existing.find((r) => r.name.toLowerCase() === m.name.toLowerCase());
  // `--as` defaults to the literal "roster" for both `roster create` and
  // `roster join`, so the happy path for joining a SECOND roster without
  // `--as` would otherwise silently destroy the first one's roster_id here —
  // unrecoverable, because join keys are discarded at join time. Same
  // name + same id + same relay stays idempotent (rejoining what you already
  // belong to); any other reuse of the name is the collision this throws on.
  //
  // Relay is part of the comparison for the same reason readCached validates
  // all three of (relay, caller, roster_id): a roster is identified by its id
  // *on a relay*, not by its id alone. `relayUrl(cfg)` moves between
  // invocations via AGENTCALL_RELAY or an edited config, so without this a
  // re-save silently rewrites the relay field — and since `agentcall search`
  // filters memberships by the current relay, the roster just quietly stops
  // appearing in results instead of reporting anything.
  if (prior && (prior.roster_id !== m.roster_id || prior.relay !== m.relay)) {
    const what = prior.roster_id !== m.roster_id ? "a different roster" : `a different relay (${prior.relay})`;
    throw new Error(
      `"${m.name}" is already recorded for ${what}. Run \`agentcall roster forget ${m.name}\` first, or pick a different --as name.`,
    );
  }
  const rosters = existing.filter((r) => r.name.toLowerCase() !== m.name.toLowerCase());
  rosters.push(m);
  writeJsonAtomic(p.rostersFile, { rosters });
}

export function forgetMembership(p: LinePaths, name: string): void {
  const rosters = loadMemberships(p);
  const next = rosters.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
  if (next.length === rosters.length) {
    throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
  }
  writeJsonAtomic(p.rostersFile, { rosters: next });
}

export function loadCache(p: LinePaths): Record<string, CachedBundle> {
  if (!existsSync(p.rosterCacheFile)) return {};
  try {
    return CacheFile.parse(JSON.parse(readFileSync(p.rosterCacheFile, "utf8"))).rosters;
  } catch {
    // Derived data: a corrupt cache costs a refetch, not user data.
    return {};
  }
}

// Identity-validating read. A cached bundle is only ever served back to the
// exact (relay, caller, roster_id) that fetched it, because it contains
// tasks granted privately to that caller under that roster. Any mismatch is
// a miss, never a downgrade. roster_id matters because rosters.json — not
// this cache — is keyed by local name only: `roster forget acme` followed by
// rejoining a *different* roster as `--as acme` must not resurrect the old
// roster's bundle under the reused name.
export function readCached(
  p: LinePaths, name: string, identity: { relay: string; caller: string; roster_id: string },
): CachedBundle | null {
  const hit = loadCache(p)[name];
  if (!hit) return null;
  if (hit.relay !== identity.relay || hit.caller !== identity.caller || hit.roster_id !== identity.roster_id) {
    return null;
  }
  return hit;
}

export function writeCached(p: LinePaths, name: string, bundle: CachedBundle): void {
  writeJsonAtomic(p.rosterCacheFile, { version: 1, rosters: { ...loadCache(p), [name]: bundle } });
}

// Derived data: dropping an entry costs one refetch, never user data. Used
// on a 404 (see searchRefresh.ts) so a revoked roster's cache cannot outlive
// the revocation under --offline.
export function deleteCached(p: LinePaths, name: string): void {
  const rosters = { ...loadCache(p) };
  delete rosters[name];
  writeJsonAtomic(p.rosterCacheFile, { version: 1, rosters });
}
