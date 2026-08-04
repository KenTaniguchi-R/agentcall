// Per-callee inbound call-frame admission window, keyed off the RATE_LIMIT_PER_HOUR
// budget from @benree/agentcall-shared. This is unrelated to apps/relay/src/ratelimit/,
// which throttles HTTP requests per route (RateLimiterDO shards / native CF bindings,
// REGISTER/ROSTER_WRITE/AUDIT_* policies). This module instead tracks a sliding window
// of call timestamps in the callee's own HandleDO storage under the `rl:` prefix, and
// is called from HandleDO.webSocketMessage and HandleDO.alarm, not from rateLimit(...)
// middleware.

export const RATE_LIMIT_WINDOW_MS = 3_600_000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 60_000;
const RATE_LIMIT_PRUNE_PAGE_SIZE = 128;
export const RATE_LIMIT_PRUNE_MAX_PAGES = 4;
const RATE_LIMIT_PREFIX = "rl:";
const RATE_LIMIT_PRUNED_AT_KEY = "meta:rl-pruned-at";
const RATE_LIMIT_MAINTENANCE_KEY = "meta:rl-maintenance";
const RATE_LIMIT_PRUNE_CONTINUE_DELAY_MS = 1_000;

type RateLimitMaintenance = { cursor: string; due: number };

export interface RateLimitStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
  put<T>(key: string, value: T): Promise<void>;
}

export async function readRateLimitMaintenance(
  storage: RateLimitStorage,
): Promise<RateLimitMaintenance | undefined> {
  const stored = await storage.get<unknown>(RATE_LIMIT_MAINTENANCE_KEY);
  if (stored === undefined) return undefined;
  if (
    typeof stored === "object" && stored !== null &&
    typeof (stored as Partial<RateLimitMaintenance>).cursor === "string" &&
    typeof (stored as Partial<RateLimitMaintenance>).due === "number" &&
    Number.isFinite((stored as Partial<RateLimitMaintenance>).due)
  ) {
    return stored as RateLimitMaintenance;
  }
  await storage.delete([RATE_LIMIT_MAINTENANCE_KEY]);
  return undefined;
}

async function pruneStaleRateLimitKeys(storage: RateLimitStorage, now: number): Promise<boolean> {
  const storedLastPrunedAt = await storage.get<unknown>(RATE_LIMIT_PRUNED_AT_KEY);
  const lastPrunedAt = typeof storedLastPrunedAt === "number" && Number.isFinite(storedLastPrunedAt)
    ? storedLastPrunedAt
    : undefined;
  const maintenance = await readRateLimitMaintenance(storage);
  const cursor = maintenance?.cursor;
  if (cursor === undefined && lastPrunedAt !== undefined && now - lastPrunedAt < RATE_LIMIT_PRUNE_INTERVAL_MS) {
    return false;
  }

  let startAfter = cursor;
  let complete = false;
  for (let pageNumber = 0; pageNumber < RATE_LIMIT_PRUNE_MAX_PAGES; pageNumber++) {
    const page = await storage.list<number[]>({
      prefix: RATE_LIMIT_PREFIX,
      startAfter,
      limit: RATE_LIMIT_PRUNE_PAGE_SIZE,
    });
    if (page.size === 0) {
      complete = true;
      break;
    }

    const keys = [...page.keys()];
    startAfter = keys[keys.length - 1]!;
    const stale = [...page.entries()]
      .filter(([, stamps]) => !Array.isArray(stamps) || !stamps.some(
        (stamp) => typeof stamp === "number" && Number.isFinite(stamp) && now - stamp < RATE_LIMIT_WINDOW_MS,
      ))
      .map(([key]) => key);
    if (stale.length > 0) await storage.delete(stale);
    if (page.size < RATE_LIMIT_PRUNE_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  await storage.put(RATE_LIMIT_PRUNED_AT_KEY, now);
  if (complete) {
    await storage.delete([RATE_LIMIT_MAINTENANCE_KEY]);
    return false;
  }

  // The cursor can temporarily contain one `rl:<handle>` key, but only while
  // a scheduled bounded continuation is draining the sweep. It is deleted as
  // soon as the end of the prefix is reached, never retained as an audit log.
  await storage.put<RateLimitMaintenance>(RATE_LIMIT_MAINTENANCE_KEY, {
    cursor: startAfter!,
    due: now + RATE_LIMIT_PRUNE_CONTINUE_DELAY_MS,
  });
  return true;
}

export async function readLiveRateLimitStamps(
  storage: RateLimitStorage, caller: string, now: number,
): Promise<number[]> {
  const stored = await storage.get<unknown>(`${RATE_LIMIT_PREFIX}${caller}`);
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (stamp): stamp is number => typeof stamp === "number" && Number.isFinite(stamp) && now - stamp < RATE_LIMIT_WINDOW_MS,
  );
}

export async function recordRateLimitHit(
  storage: RateLimitStorage, caller: string, liveStamps: number[], now: number,
): Promise<boolean> {
  const needsContinuation = await pruneStaleRateLimitKeys(storage, now);
  await storage.put(`${RATE_LIMIT_PREFIX}${caller}`, [...liveStamps, now]);
  return needsContinuation;
}

export async function continueRateLimitMaintenance(
  storage: RateLimitStorage, now: number,
): Promise<boolean> {
  const maintenance = await readRateLimitMaintenance(storage);
  if (!maintenance || maintenance.due > now) return false;
  return pruneStaleRateLimitKeys(storage, now);
}
