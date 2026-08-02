import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_PRUNE_MAX_PAGES, RATE_LIMIT_WINDOW_MS, continueRateLimitMaintenance,
  readLiveRateLimitStamps, readRateLimitMaintenance, recordRateLimitHit,
} from "../src/do.js";

class MemoryRateLimitStorage {
  readonly data = new Map<string, unknown>();
  listCalls = 0;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async list<T>(options: DurableObjectListOptions = {}): Promise<Map<string, T>> {
    this.listCalls++;
    const entries = [...this.data.entries()]
      .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
      .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options.limit ?? Infinity);
    return new Map(entries) as Map<string, T>;
  }

  async delete(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.data.delete(key)) deleted++;
    return deleted;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

describe("HandleDO rate-limit retention", () => {
  it("deletes an expired caller key when a different caller records a hit", async () => {
    const now = 2 * RATE_LIMIT_WINDOW_MS;
    const storage = new MemoryRateLimitStorage();
    storage.data.set("rl:departed-caller", [now - RATE_LIMIT_WINDOW_MS]);
    storage.data.set("rl:malformed-array", [Number.POSITIVE_INFINITY, "not-a-timestamp"]);
    storage.data.set("rl:recent-caller", [now - RATE_LIMIT_WINDOW_MS + 1]);

    await recordRateLimitHit(storage, "new-caller", [], now);

    expect(storage.data.has("rl:departed-caller")).toBe(false);
    expect(storage.data.has("rl:malformed-array")).toBe(false);
    expect(storage.data.get("rl:recent-caller")).toEqual([now - RATE_LIMIT_WINDOW_MS + 1]);
    expect(storage.data.get("rl:new-caller")).toEqual([now]);
  });

  it("caps work per event and resumes an aged-out backlog from its cursor", async () => {
    const now = 2 * RATE_LIMIT_WINDOW_MS;
    const storage = new MemoryRateLimitStorage();
    for (let i = 0; i < 700; i++) {
      storage.data.set(`rl:old-${String(i).padStart(3, "0")}`, [now - RATE_LIMIT_WINDOW_MS]);
    }

    const needsContinuation = await recordRateLimitHit(storage, "fresh", [], now);

    expect(needsContinuation).toBe(true);
    expect(storage.listCalls).toBe(RATE_LIMIT_PRUNE_MAX_PAGES);
    expect([...storage.data.keys()].filter((key) => key.startsWith("rl:")).length).toBe(189);

    const complete = await recordRateLimitHit(storage, "next", [], now + 1_000);

    expect(complete).toBe(false);
    expect([...storage.data.keys()].filter((key) => key.startsWith("rl:")).sort()).toEqual([
      "rl:fresh", "rl:next",
    ]);
    expect(storage.data.has("meta:rl-maintenance")).toBe(false);
  });

  it("runs at most once per minute and resumes at the exact interval boundary", async () => {
    const now = 2 * RATE_LIMIT_WINDOW_MS;
    const storage = new MemoryRateLimitStorage();
    await recordRateLimitHit(storage, "first", [], now);
    expect(storage.listCalls).toBe(1);

    storage.data.set("rl:became-stale", [now - RATE_LIMIT_WINDOW_MS]);
    await recordRateLimitHit(storage, "second", [], now + 59_999);
    expect(storage.listCalls).toBe(1);
    expect(storage.data.has("rl:became-stale")).toBe(true);

    await recordRateLimitHit(storage, "third", [], now + 60_000);
    expect(storage.listCalls).toBe(2);
    expect(storage.data.has("rl:became-stale")).toBe(false);
  });

  it("treats malformed current-caller state as empty instead of throwing", async () => {
    const storage = new MemoryRateLimitStorage();
    storage.data.set("rl:broken", { stamps: "not-an-array" });
    expect(await readLiveRateLimitStamps(storage, "broken", RATE_LIMIT_WINDOW_MS)).toEqual([]);

    storage.data.set("rl:mixed", [1, Number.NaN, "2", Infinity]);
    expect(await readLiveRateLimitStamps(storage, "mixed", RATE_LIMIT_WINDOW_MS)).toEqual([1]);
  });

  it("atomically validates continuation metadata used by alarms and scheduling", async () => {
    const storage = new MemoryRateLimitStorage();
    storage.data.set("meta:rl-maintenance", { cursor: "rl:old" });
    expect(await readRateLimitMaintenance(storage)).toBeUndefined();
    expect(storage.data.has("meta:rl-maintenance")).toBe(false);

    storage.data.set("meta:rl-maintenance", { due: 1_000 });
    expect(await readRateLimitMaintenance(storage)).toBeUndefined();
    expect(storage.data.has("meta:rl-maintenance")).toBe(false);

    storage.data.set("meta:rl-maintenance", { cursor: "rl:old", due: 1_000 });
    expect(await readRateLimitMaintenance(storage)).toEqual({ cursor: "rl:old", due: 1_000 });
  });

  it("does not run maintenance on an earlier call alarm, then resumes when due", async () => {
    const maintenanceDue = 2 * RATE_LIMIT_WINDOW_MS;
    const storage = new MemoryRateLimitStorage();
    storage.data.set("rl:old", [0]);
    storage.data.set("meta:rl-maintenance", { cursor: "rl:before-old", due: maintenanceDue });

    expect(await continueRateLimitMaintenance(storage, maintenanceDue - 1_000)).toBe(false);
    expect(storage.listCalls).toBe(0);
    expect(storage.data.has("rl:old")).toBe(true);

    expect(await continueRateLimitMaintenance(storage, maintenanceDue)).toBe(false);
    expect(storage.listCalls).toBe(1);
    expect(storage.data.has("rl:old")).toBe(false);
    expect(storage.data.has("meta:rl-maintenance")).toBe(false);
  });
});
