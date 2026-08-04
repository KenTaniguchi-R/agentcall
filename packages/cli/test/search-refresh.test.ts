import { describe, expect, it, vi } from "vitest";
import { readCached, saveMembership, writeCached } from "../src/rosters.js";
import { ApiError } from "../src/api.js";
import { refreshRoster } from "../src/searchRefresh.js";
import { tempLine } from "./helpers.js";

const setup = () => {
  const p = tempLine("claude", "agentcall-refresh-");
  saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
  return p;
};
const AUTH = { org: "acme", handle: "ken", token: "t" };
const IDENTITY = { relay: "https://r.test", caller: "ken" };
const cached = (fetchedAt: number) => ({
  relay: "https://r.test", caller: "ken", roster_id: "a".repeat(22),
  etag: '"e1"', fetched_at: fetchedAt, entries: [], skipped: 0,
});

describe("refreshRoster", () => {
  it("does not touch the network when the cache is fresh", async () => {
    const p = setup();
    writeCached(p, "acme", cached(Date.now()));
    const fetcher = vi.fn();
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.stale).toBe(false);
  });

  it("refreshes a stale cache", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockResolvedValue({
      bundle: { roster_id: "a".repeat(22), entries: [], skipped: 0 }, etag: '"e2"',
    });
    await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps cached entries on a 304", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockResolvedValue("not-modified");
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(out.stale).toBe(false);
    expect(out.entries).toEqual([]);
  });

  // Fail OPEN: search decides what to PRINT, not whether code runs. Failing
  // closed here protects nothing — the relay still gates the actual call —
  // while silently deleting the feature.
  it("serves a stale cache with a warning when the relay is unreachable", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockRejectedValue(new ApiError("down", "network"));
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(out.stale).toBe(true);
    expect(out.entries).toEqual([]);
  });

  // The ONE place fail-closed is right: the relay is reporting that your
  // ACCESS changed. Serving stale results would advertise people you can no
  // longer reach.
  it("refuses to serve results on a 404, and drops the stale cache entry", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockRejectedValue(new ApiError("gone", "unknown_handle"));
    await expect(refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() }))
      .rejects.toThrow(/no longer a member|gone/i);
    // Otherwise --offline (which reads the cache directly, before any
    // network call) would keep serving these results indefinitely — exactly
    // the outcome the fail-closed 404 handling exists to prevent.
    expect(readCached(p, "acme", { ...IDENTITY, roster_id: "a".repeat(22) })).toBeNull();
  });

  it("errors on a cold cache with no network", async () => {
    const p = setup();
    const fetcher = vi.fn().mockRejectedValue(new ApiError("down", "network"));
    await expect(refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() }))
      .rejects.toThrow(/never been fetched|agentcall roster join/i);
  });

  it("never refreshes when offline is set", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn();
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now(), offline: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.stale).toBe(true);
  });
});
