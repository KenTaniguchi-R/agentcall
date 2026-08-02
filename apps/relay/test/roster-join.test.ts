import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_ROSTER_MEMBERS } from "@benree/agentcall-shared";
import { registerHandle, wsAuth } from "./helpers.js";

async function newRoster(handle: string) {
  const token = await registerHandle(handle);
  const res = await SELF.fetch("https://relay.test/v1/roster", {
    method: "POST",
    headers: { "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
  });
  return { token, ...(await res.json<{ roster_id: string; join_secret: string; admin_secret: string }>()) };
}

async function join(id: string, handle: string, token: string, secret: string) {
  return SELF.fetch(`https://relay.test/v1/roster/${id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
    body: JSON.stringify({ join_secret: secret }),
  });
}

describe("POST /v1/roster/:id/join", () => {
  it("admits a handle with the correct secret", async () => {
    const r = await newRoster("rj1");
    const token = await registerHandle("rj1b");
    expect((await join(r.roster_id, "rj1b", token, r.join_secret)).status).toBe(200);
  });

  it("401s without credentials", async () => {
    const r = await newRoster("rj2");
    const res = await SELF.fetch(`https://relay.test/v1/roster/${r.roster_id}/join`, {
      method: "POST", body: JSON.stringify({ join_secret: r.join_secret }),
    });
    expect(res.status).toBe(401);
  });

  // THE load-bearing test: an unknown roster and a wrong secret must be
  // indistinguishable, or roster ids are enumerable by probing. Asserted as
  // equality of status AND body, not as two separate 404 checks.
  it("makes a wrong secret byte-identical to an unknown roster", async () => {
    const r = await newRoster("rj3");
    const token = await registerHandle("rj3b");
    const wrong = await join(r.roster_id, "rj3b", token, "not-the-secret");
    const missing = await join("A".repeat(22), "rj3b", token, "not-the-secret");
    expect(wrong.status).toBe(missing.status);
    expect(await wrong.text()).toBe(await missing.text());
    expect(wrong.status).toBe(404);
  });

  it("400s on a malformed roster id rather than querying for it", async () => {
    const token = await registerHandle("rj4");
    // Not "../etc/passwd": the URL parser collapses "roster/../etc" to "etc"
    // via ordinary dot-segment removal before a Request object even exists
    // (verified: `new URL(...).pathname` never contains the "roster" segment
    // again), so that input would never reach this route at all — it would
    // silently exercise Hono's own no-route 404 instead of our guard. A
    // same-segment string that still fails ROSTER_ID_RE (length/charset)
    // actually reaches the handler.
    expect((await join("short!", "rj4", token, "x")).status).toBe(400);
  });

  it("400s on a percent-encoded traversal id, the form that actually reaches the route", async () => {
    // %2E%2E%2Fetc survives URL parsing as a single path segment (unlike the
    // literal ".."), so it reaches the router; Hono decodes path params, and
    // ROSTER_ID_RE's character class has no "." or "/" to reject the
    // decoded "../etc".
    const token = await registerHandle("rj4b");
    const res = await join("%2E%2E%2Fetc", "rj4b", token, "x");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid roster id" });
  });

  it("is idempotent: rejoining does not duplicate membership", async () => {
    const r = await newRoster("rj5");
    const token = await registerHandle("rj5b");
    expect((await join(r.roster_id, "rj5b", token, r.join_secret)).status).toBe(200);
    expect((await join(r.roster_id, "rj5b", token, r.join_secret)).status).toBe(200);
  });

  it("409s when the roster is full, since the caller already proved the secret", async () => {
    // Seeding MAX_ROSTER_MEMBERS - 1 handles through the API would blow the
    // register rate limit, so insert membership rows directly.
    const r = await newRoster("rj6");
    const stmt = env.DB.prepare("INSERT OR IGNORE INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, ?, ?, ?)");
    await env.DB.batch(Array.from(
      { length: MAX_ROSTER_MEMBERS - 1 },
      (_, i) => stmt.bind(r.roster_id, "acme", `filler${i}`, 1),
    ));
    const token = await registerHandle("rj6b");
    expect((await join(r.roster_id, "rj6b", token, r.join_secret)).status).toBe(409);
    // Existing members remain idempotent even when there is no free slot.
    expect((await join(r.roster_id, "rj6", r.token, r.join_secret)).status).toBe(200);
  });

  it("admits exactly one of two concurrent distinct joins at 199 members", async () => {
    const r = await newRoster("rj7");
    const stmt = env.DB.prepare("INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, ?, ?, ?)");
    await env.DB.batch(Array.from(
      { length: MAX_ROSTER_MEMBERS - 2 },
      (_, i) => stmt.bind(r.roster_id, "acme", `race-filler${i}`, 1),
    ));
    const [tokenA, tokenB] = await Promise.all([registerHandle("rj7a"), registerHandle("rj7b")]);
    const [a, b] = await Promise.all([
      join(r.roster_id, "rj7a", tokenA, r.join_secret),
      join(r.roster_id, "rj7b", tokenB, r.join_secret),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_members WHERE roster_id = ?")
      .bind(r.roster_id).first<{ n: number }>();
    expect(count?.n).toBe(MAX_ROSTER_MEMBERS);
  });
});
