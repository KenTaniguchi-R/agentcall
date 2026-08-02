import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import {
  CACHE_TTL_MS, forgetMembership, loadCache, loadMemberships, readCached,
  saveMembership, writeCached,
} from "../src/rosters.js";

const paths = () => getPaths(mkdtempSync(join(tmpdir(), "agentcall-roster-")));
const IDENTITY = { relay: "https://r.test", caller: "ken" };
const BUNDLE = {
  relay: "https://r.test", caller: "ken", roster_id: "a".repeat(22),
  fetched_at: 1_000, entries: [], skipped: 0,
};

describe("memberships (user data)", () => {
  it("round-trips", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(loadMemberships(p)).toEqual([{ name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) }]);
  });

  it("is empty before anything is saved", () => {
    expect(loadMemberships(paths())).toEqual([]);
  });

  // The join secret is discarded after join, so this file is the ONLY way
  // back to a roster you still belong to. Silently resetting it would lock
  // the user out permanently — same reasoning as loadContacts.
  it("throws on corruption instead of resetting", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    writeFileSync(p.rostersFile, "{not json");
    expect(() => loadMemberships(p)).toThrow(/rosters\.json/);
  });

  it("forgets a local record", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    forgetMembership(p, "acme");
    expect(loadMemberships(p)).toEqual([]);
  });

  it("writes 0600 — memberships are personal data", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(statSync(p.rostersFile).mode & 0o777).toBe(0o600);
  });

  // Mirrors addContact's own NAME_RE check in contacts.ts: UX and
  // consistency (typo-catching, unambiguous CLI arguments), not a security
  // boundary — readCached's relay/caller check is what actually gates access.
  it("rejects an invalid local name", () => {
    const p = paths();
    expect(() => saveMembership(p, { name: "not valid!", relay: "https://r.test", roster_id: "a".repeat(22) }))
      .toThrow(/invalid roster name/i);
  });
});

describe("bundle cache (derived data)", () => {
  it("round-trips and writes 0600", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", IDENTITY)!.roster_id).toBe("a".repeat(22));
    expect(statSync(p.rosterCacheFile).mode & 0o777).toBe(0o600);
  });

  it("rebuilds on corruption rather than throwing", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    writeFileSync(p.rosterCacheFile, "{not json");
    expect(loadCache(p)).toEqual({});
  });

  // Without this, switching relays or handles could serve one identity the
  // tasks another identity was privately granted.
  it("refuses to serve a bundle fetched by a different caller", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", { relay: "https://r.test", caller: "someone-else" })).toBeNull();
  });

  it("refuses to serve a bundle fetched from a different relay", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", { relay: "https://other.test", caller: "ken" })).toBeNull();
  });

  it("does not leave the previous cache corrupt if a write is interrupted", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    // A temp file left behind by a killed process must not be mistaken for
    // the cache: the real file is only ever replaced by an atomic rename.
    writeFileSync(`${p.rosterCacheFile}.tmp`, "{not json");
    expect(readCached(p, "acme", IDENTITY)).not.toBeNull();
  });

  it("exposes a 15 minute TTL", () => {
    expect(CACHE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
