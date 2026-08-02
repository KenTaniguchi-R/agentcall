import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

async function snapshot(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    // Only headers a client can observe and that could differ per path.
    etag: res.headers.get("ETag"),
    cacheControl: res.headers.get("Cache-Control"),
    contentType: res.headers.get("content-type"),
  };
}

describe("roster guards: the enumeration invariant", () => {
  it("returns an identical response for an unknown roster and a non-member", async () => {
    const owner = await registerHandle("rg1");
    const outsider = await registerHandle("rg2");

    const created = await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST",
      headers: { "cf-connecting-ip": "test-rg1", ...wsAuth("rg1", owner) },
    });
    const { roster_id } = await created.json<{ roster_id: string }>();

    // Real roster, but the viewer is not a member.
    const nonMember = await SELF.fetch(`https://relay.test/v1/roster/${roster_id}/bundle`, {
      headers: { "cf-connecting-ip": "test-rg2", ...wsAuth("rg2", outsider) },
    });
    // Well-formed but nonexistent roster id (22 chars, inside ROSTER_ID_RE).
    const unknown = await SELF.fetch("https://relay.test/v1/roster/AAAAAAAAAAAAAAAAAAAAAA/bundle", {
      headers: { "cf-connecting-ip": "test-rg2", ...wsAuth("rg2", outsider) },
    });

    expect(await snapshot(nonMember)).toEqual(await snapshot(unknown));
    expect(nonMember.status).toBe(404);
  });

  it("returns an identical response for a wrong secret and an unknown roster on join", async () => {
    const owner = await registerHandle("rg3");
    const joiner = await registerHandle("rg4");

    const created = await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST",
      headers: { "cf-connecting-ip": "test-rg3", ...wsAuth("rg3", owner) },
    });
    const { roster_id } = await created.json<{ roster_id: string }>();

    const wrongSecret = await SELF.fetch(`https://relay.test/v1/roster/${roster_id}/join`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "test-rg4", ...wsAuth("rg4", joiner) },
      body: JSON.stringify({ secret: "not-the-secret" }),
    });
    const unknownRoster = await SELF.fetch("https://relay.test/v1/roster/BBBBBBBBBBBBBBBBBBBBBB/join", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "test-rg4", ...wsAuth("rg4", joiner) },
      body: JSON.stringify({ secret: "not-the-secret" }),
    });

    expect(await snapshot(wrongSecret)).toEqual(await snapshot(unknownRoster));
    expect(wrongSecret.status).toBe(404);
  });

  it("rejects a malformed roster id before any lookup, with 400 not 404", async () => {
    const token = await registerHandle("rg5");
    const res = await SELF.fetch("https://relay.test/v1/roster/short/bundle", {
      headers: { "cf-connecting-ip": "test-rg5", ...wsAuth("rg5", token) },
    });
    expect(res.status).toBe(400);
  });

  it("401s before revealing anything about the roster", async () => {
    const res = await SELF.fetch("https://relay.test/v1/roster/AAAAAAAAAAAAAAAAAAAAAA/bundle");
    expect(res.status).toBe(401);
  });
});
