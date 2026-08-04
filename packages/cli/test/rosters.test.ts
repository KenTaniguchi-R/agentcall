import { readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS, forgetMembership, loadCache, loadMemberships, readCached,
  saveMembership, writeCached,
} from "../src/rosters.js";
import { tempLine } from "./helpers.js";

const paths = () => tempLine("claude", "agentcall-roster-");
const IDENTITY = { relay: "https://r.test", caller: "ken", roster_id: "a".repeat(22) };
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

  // The join key is discarded after join, so this file is the ONLY way
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

  it("writes only fields owned by the current membership schema", () => {
    const p = paths();
    saveMembership(p, { name: "first", relay: "https://r.test", roster_id: "b".repeat(22) });
    const existing = JSON.parse(readFileSync(p.rostersFile, "utf8"));
    writeFileSync(p.rostersFile, JSON.stringify({ ...existing, future_field: "x" }));
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(JSON.parse(readFileSync(p.rostersFile, "utf8"))).not.toHaveProperty("future_field");
  });

  // Mirrors addContact's own NAME_RE check in contacts.ts: UX and
  // consistency (typo-catching, unambiguous CLI arguments), not a security
  // boundary — readCached's relay/caller check is what actually gates access.
  it("rejects an invalid local name", () => {
    const p = paths();
    expect(() => saveMembership(p, { name: "not valid!", relay: "https://r.test", roster_id: "a".repeat(22) }))
      .toThrow(/invalid roster name/i);
  });

  // `--as` defaults to the literal "roster" for both `roster create` and
  // `roster join`, so re-saving the SAME name with the SAME roster_id (e.g.
  // re-running `roster join` for a roster you already belong to) must stay
  // idempotent rather than tripping the conflict guard below.
  it("re-saving the same name with the same roster_id is idempotent", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(() => saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) }))
      .not.toThrow();
    expect(loadMemberships(p)).toEqual([{ name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) }]);
  });

  // The exact loss this file's throw-on-corruption policy exists to
  // prevent, arriving through the front door: since --as defaults to
  // "roster" for both create and join, the happy path for joining a SECOND
  // roster without an explicit --as would otherwise silently destroy the
  // first roster's id — unrecoverable, since the join key is discarded at
  // join time.
  it("throws rather than silently overwriting a name with a different roster_id", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(() => saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "b".repeat(22) }))
      .toThrow(/already recorded|different roster/i);
    // The original membership must survive the rejected write.
    expect(loadMemberships(p)).toEqual([{ name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) }]);
  });

  // Same name and same roster_id but a DIFFERENT relay is not idempotent —
  // it is a different roster that happens to share an id. `relayUrl(cfg)`
  // moves between invocations via AGENTCALL_RELAY or an edited config, so
  // this is reachable without a genuine 16-byte id collision. Treated as a
  // conflict for the same reason readCached validates all three of
  // (relay, caller, roster_id): the symptom of overwriting the relay is the
  // roster quietly vanishing from `agentcall search`, which filters by the
  // current relay — confusing, and silent.
  it("throws rather than silently overwriting a name's relay", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(() => saveMembership(p, { name: "acme", relay: "https://other.test", roster_id: "a".repeat(22) }))
      .toThrow(/already recorded|different roster/i);
    expect(loadMemberships(p)).toEqual([{ name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) }]);
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
    expect(readCached(p, "acme", { ...IDENTITY, caller: "someone-else" })).toBeNull();
  });

  it("refuses to serve a bundle fetched from a different relay", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", { ...IDENTITY, relay: "https://other.test" })).toBeNull();
  });

  // Without this, `roster forget acme` (which drops rosters.json but leaves
  // the cache) followed by rejoining a DIFFERENT roster as `--as acme` would
  // serve the old roster's bundle under the reused local name.
  it("refuses to serve a bundle fetched under a different roster_id", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", { ...IDENTITY, roster_id: "b".repeat(22) })).toBeNull();
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
