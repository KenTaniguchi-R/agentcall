import type { BundleEntryType } from "@benree/agentcall-shared";
import { ApiError, fetchRosterBundle, type Auth } from "./api.js";
import { CACHE_TTL_MS, deleteCached, readCached, writeCached } from "./rosters.js";
import type { LinePaths } from "./paths.js";

interface RefreshOptions {
  fetcher?: typeof fetchRosterBundle;
  now?: number;
  offline?: boolean;
}

interface RefreshResult {
  entries: BundleEntryType[];
  ageSeconds: number;
  stale: boolean;
}

// The failure policy is deliberately fail-OPEN, the opposite of the
// PreToolUse guard's stance, with exactly one exception. The guard decides
// whether code runs; this decides what gets printed. Failing closed on a
// network blip protects nothing — the relay still enforces membership on the
// actual call, and the callee's policy still enforces disclosure — while
// silently deleting the feature. The exception is a 404: there the relay is
// telling us the caller's ACCESS changed, and serving stale results would
// advertise people they can no longer reach.
export async function refreshRoster(
  p: LinePaths,
  name: string,
  rosterId: string,
  identity: { relay: string; caller: string },
  auth: Auth,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetchRosterBundle;
  const hit = readCached(p, name, { ...identity, roster_id: rosterId });
  const ageMs = hit ? now - hit.fetched_at : Infinity;

  if (hit && !opts.offline && ageMs < CACHE_TTL_MS) {
    return { entries: hit.entries, ageSeconds: Math.floor(ageMs / 1000), stale: false };
  }
  if (opts.offline) {
    if (!hit) {
      throw new Error(`Roster "${name}" has never been fetched and --offline was set. Drop --offline, or run \`agentcall roster join\`.`);
    }
    return { entries: hit.entries, ageSeconds: Math.floor(ageMs / 1000), stale: true };
  }

  try {
    const out = await fetcher(identity.relay, auth, rosterId, hit?.etag);
    if (out === "not-modified") {
      // Nothing changed; re-stamp so the TTL restarts without a refetch.
      writeCached(p, name, { ...hit!, fetched_at: now });
      return { entries: hit!.entries, ageSeconds: 0, stale: false };
    }
    writeCached(p, name, {
      relay: identity.relay, caller: identity.caller, roster_id: rosterId,
      etag: out.etag, fetched_at: now, entries: out.bundle.entries, skipped: out.bundle.skipped,
    });
    return { entries: out.bundle.entries, ageSeconds: 0, stale: false };
  } catch (e) {
    // The relay says the roster is gone or membership ended: fail closed.
    // Drop the cache entry rather than merely refusing to return it here —
    // --offline reads the cache directly and returns before any network
    // call, so a stale entry left in place would keep serving exactly the
    // results this fail-closed rule exists to suppress, indefinitely.
    if (e instanceof ApiError && e.code === "unknown_handle") {
      deleteCached(p, name);
      throw e;
    }
    if (!hit) {
      throw new Error(
        `Roster "${name}" has never been fetched and the relay is unreachable (${e instanceof Error ? e.message : String(e)}). ` +
          `Retry when online, or run \`agentcall roster join\`.`,
      );
    }
    return { entries: hit.entries, ageSeconds: Math.floor(ageMs / 1000), stale: true };
  }
}
