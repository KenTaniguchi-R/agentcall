import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { BundleEntry, ROSTER_ID_RE } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

// Two stores with DELIBERATELY OPPOSITE corruption policies, kept in one file
// so the contrast is visible where someone might get it wrong:
//
//   rosters.json      user data  -> THROWS. The join secret is discarded at
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

// Temp-then-rename: a killed process can leave a partial .tmp behind, but the
// real file is only ever replaced atomically, so a reader never sees a
// half-written cache.
function writeAtomic(file: string, dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function loadMemberships(p: Paths): Membership[] {
  if (!existsSync(p.rostersFile)) return [];
  try {
    return MembershipsFile.parse(JSON.parse(readFileSync(p.rostersFile, "utf8"))).rosters;
  } catch (e) {
    throw new Error(
      `Corrupt rosters.json at ${p.rostersFile}: ${e instanceof Error ? e.message : String(e)}. ` +
        `This file holds the roster ids you joined; the join secrets are not recoverable, so it is not reset automatically.`,
    );
  }
}

export function saveMembership(p: Paths, m: Membership): void {
  const rosters = loadMemberships(p).filter((r) => r.name.toLowerCase() !== m.name.toLowerCase());
  rosters.push(m);
  writeAtomic(p.rostersFile, p.dir, { rosters });
}

export function forgetMembership(p: Paths, name: string): void {
  const rosters = loadMemberships(p);
  const next = rosters.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
  if (next.length === rosters.length) {
    throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
  }
  writeAtomic(p.rostersFile, p.dir, { rosters: next });
}

export function loadCache(p: Paths): Record<string, CachedBundle> {
  if (!existsSync(p.rosterCacheFile)) return {};
  try {
    return CacheFile.parse(JSON.parse(readFileSync(p.rosterCacheFile, "utf8"))).rosters;
  } catch {
    // Derived data: a corrupt cache costs a refetch, not user data.
    return {};
  }
}

// Identity-validating read. A cached bundle is only ever served back to the
// exact (relay, caller) that fetched it, because it contains tasks granted
// privately to that caller. Any mismatch is a miss, never a downgrade.
export function readCached(
  p: Paths, name: string, identity: { relay: string; caller: string },
): CachedBundle | null {
  const hit = loadCache(p)[name];
  if (!hit) return null;
  if (hit.relay !== identity.relay || hit.caller !== identity.caller) return null;
  return hit;
}

export function writeCached(p: Paths, name: string, bundle: CachedBundle): void {
  writeAtomic(p.rosterCacheFile, p.dir, { version: 1, rosters: { ...loadCache(p), [name]: bundle } });
}
