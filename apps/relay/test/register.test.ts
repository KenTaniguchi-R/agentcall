import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth.js";
import app from "../src/index.js";
import { issueInvite, registerHandle, wsAuth } from "./helpers.js";
import { resolveAgentId } from "../src/identity.js";
import { authenticatedHandle } from "../src/auth.js";

// Each test uses its own synthetic source IP so the per-IP register rate
// limit (5/60s, see REGISTER in src/ratelimit) doesn't make unrelated
// tests in this file collide with each other's budget.
async function register(body: unknown, ip = "203.0.113.1") {
  const input = body as { org?: string; invite?: string; handle?: string; agent_kind?: string };
  const invite = input.invite ?? await issueInvite(input.org ?? "acme", input.handle ?? "request");
  return SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ invite, handle: input.handle, agent_kind: input.agent_kind }),
  });
}

describe("POST /v1/register", () => {
  // #319, first slice of #154. agent_id is the stable principal that later
  // slices move DO naming, cards, roster membership, policy, and audit
  // subjects onto. Nothing reads it yet, so these tests pin the properties
  // the rest of the cutover will depend on before anything relies on them.
  describe("stable agent identity", () => {
    async function agentIdOf(org: string, handle: string): Promise<string | null> {
      const row = await env.DB.prepare("SELECT agent_id FROM handles WHERE org = ? AND handle = ?")
        .bind(org, handle).first<{ agent_id: string | null }>();
      return row?.agent_id ?? null;
    }

    it("mints a distinct opaque agent_id per registration", async () => {
      await register({ org: "acme", handle: "id-one" }, "203.0.113.60");
      await register({ org: "acme", handle: "id-two" }, "203.0.113.61");
      const one = await agentIdOf("acme", "id-one");
      const two = await agentIdOf("acme", "id-two");
      expect(one).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(two).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(one).not.toBe(two);
    });

    // The spec forbids deriving the identity from the handle, credential,
    // device, or signing key, and requires two organizations to be able to
    // hold the same handle without sharing an identity.
    it("does not derive the identity from the handle: same handle, two orgs", async () => {
      await register({ org: "org-alpha", handle: "shared" }, "203.0.113.62");
      await register({ org: "org-beta", handle: "shared" }, "203.0.113.63");
      const alpha = await agentIdOf("org-alpha", "shared");
      const beta = await agentIdOf("org-beta", "shared");
      expect(alpha).not.toBeNull();
      expect(alpha).not.toBe(beta);
    });

    it("never leaves a registered handle without an identity", async () => {
      await register({ org: "acme", handle: "always-identified" }, "203.0.113.64");
      const unidentified = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM handles WHERE agent_id IS NULL",
      ).first<{ n: number }>();
      expect(unidentified?.n).toBe(0);
    });

    // Storage-level, not call-site-level. The decision's own argument is that
    // remembering to do this at every write site is not an identity boundary.
    it("refuses an insert with no agent_id", async () => {
      await expect(env.DB.prepare(
        "INSERT INTO handles (org, handle, token_hash, created_at, org_role) VALUES (?, ?, ?, ?, ?)",
      ).bind("acme", "no-identity", "x".repeat(64), Date.now(), "member").run()).rejects.toThrow();
    });

    it("refuses to repoint an existing handle at another identity", async () => {
      await register({ org: "acme", handle: "immutable-id" }, "203.0.113.65");
      await expect(env.DB.prepare(
        "UPDATE handles SET agent_id = ? WHERE org = ? AND handle = ?",
      ).bind("agt_" + "9".repeat(32), "acme", "immutable-id").run()).rejects.toThrow();
    });

    it("refuses two handles in one org sharing an identity", async () => {
      await register({ org: "acme", handle: "unique-a" }, "203.0.113.66");
      const taken = await agentIdOf("acme", "unique-a");
      await expect(env.DB.prepare(
        "INSERT INTO handles (org, handle, token_hash, created_at, org_role, agent_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("acme", "unique-b", "y".repeat(64), Date.now(), "member", taken).run()).rejects.toThrow();
    });

    // Slice 2 (#321): the id now travels on the authenticated Identity, so
    // slices 4-7 can key on it without re-querying handles. The lookup is
    // still by the caller-supplied handle -- slice 3 inverts that.
    it("carries agentId on an authenticated identity", async () => {
      const token = await registerHandle("authed", "claude", "acme");
      const authed = await authenticatedHandle(env.DB, "acme", "authed", token);
      expect(authed?.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(authed?.agentId).toBe(await agentIdOf("acme", "authed"));
    });

    it("gives the same handle in two orgs different authenticated principals", async () => {
      const alpha = await registerHandle("twin", "claude", "org-one");
      const beta = await registerHandle("twin", "claude", "org-two");
      const a = await authenticatedHandle(env.DB, "org-one", "twin", alpha);
      const b = await authenticatedHandle(env.DB, "org-two", "twin", beta);
      expect(a?.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(b?.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(a?.agentId).not.toBe(b?.agentId);
    });

    it("returns no identity at all for a wrong token", async () => {
      await registerHandle("wrong-token", "claude", "acme");
      expect(await authenticatedHandle(env.DB, "acme", "wrong-token", "not-the-token")).toBeNull();
    });

    // One handle's credential must not authenticate another row, which is the
    // property slice 3 has to preserve when it stops looking the row up by
    // the caller-supplied handle at all.
    it("does not let one handle's token authenticate another handle", async () => {
      await registerHandle("victim", "claude", "acme");
      const attacker = await registerHandle("attacker", "claude", "acme");
      expect(await authenticatedHandle(env.DB, "acme", "victim", attacker)).toBeNull();
    });

    // The shim slice 9 deletes. Tested rather than shipped uncalled: slices 4
    // to 7 route their handle-keyed call sites through it while they move.
    it("resolveAgentId maps an address to its identity, and misses to null", async () => {
      await register({ org: "acme", handle: "resolvable" }, "203.0.113.69");
      const direct = await agentIdOf("acme", "resolvable");
      expect(await resolveAgentId(env.DB, "acme", "resolvable")).toBe(direct);
      expect(await resolveAgentId(env.DB, "acme", "no-such-handle")).toBeNull();
      // Scoped by org: the same handle elsewhere is a different principal.
      expect(await resolveAgentId(env.DB, "other-org", "resolvable")).toBeNull();
    });

    it("writes no identity when registration fails", async () => {
      const invite = await issueInvite("acme", "doomed");
      await register({ invite, handle: "consumed" }, "203.0.113.67");
      const replay = await register({ invite, handle: "never-created" }, "203.0.113.68");
      expect(replay.status).toBe(404);
      expect(await agentIdOf("acme", "never-created")).toBeNull();
    });
  });

  it("registers a handle and returns org + token", async () => {
    const invite = await issueInvite("acme", "successful-registration");
    const res = await register({ invite, handle: "ken", agent_kind: "claude" }, "203.0.113.10");
    expect(res.status).toBe(200);
    const json = await res.json<{ org: string; token: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    // No address on the wire: it is formatAddress(org, handle) and the caller
    // already holds both.
    expect(json).not.toHaveProperty("address");
    const inviteRow = await env.DB.prepare("SELECT used_at, used_by FROM invites WHERE org = ? AND used_by = ?")
      .bind("acme", "ken").first<{ used_at: number | null; used_by: string | null }>();
    expect(inviteRow?.used_at).toEqual(expect.any(Number));
    expect(inviteRow?.used_by).toBe("ken");
  });
  it("requires a valid, unused invite and derives the tenant from it", async () => {
    const missing = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.160" },
      body: JSON.stringify({ handle: "ken" }),
    });
    expect(missing.status).toBe(400);

    const invite = await issueInvite("invite-org", "tenant-proof");
    const first = await register({ invite, org: "attacker-choice", handle: "invited" }, "203.0.113.161");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ org: "invite-org" });
    const replay = await register({ invite, handle: "replay" }, "203.0.113.162");
    expect(replay.status).toBe(404);
  });

  it("does not consume an invite when the requested handle is already taken", async () => {
    await register({ org: "acme", handle: "occupied" }, "203.0.113.163");
    const invite = await issueInvite("acme", "retryable");
    expect((await register({ invite, handle: "occupied" }, "203.0.113.164")).status).toBe(409);
    expect((await register({ invite, handle: "available" }, "203.0.113.165")).status).toBe(200);
  });

  it("logs non-conflict database failures as retryable without consuming the invite", async () => {
    const invite = await issueInvite("acme", "database-failure");
    const inviteHash = await sha256Hex(invite);
    const failure = new Error("D1_ERROR: no such table: handles; bound=invite-super-secret");
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async () => { throw failure; },
    } as unknown as D1Database;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await app.request("https://relay.test/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.174" },
        body: JSON.stringify({ invite, handle: "retry-after-d1" }),
      }, { ...env, DB: db });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.json()).toEqual({ error: "registration temporarily unavailable" });
      expect(log).toHaveBeenCalledWith("registration database failure", {
        name: "Error", kind: "schema",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("invite-super-secret");
      const row = await env.DB.prepare("SELECT used_at FROM invites WHERE token_hash = ?")
        .bind(inviteHash).first<{ used_at: number | null }>();
      expect(row?.used_at).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("handles invite-lookup outages as logged, retryable failures", async () => {
    const failure = new Error("D1_ERROR: connection unavailable");
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => { throw failure; } }) }),
    } as unknown as D1Database;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await app.request("https://relay.test/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.175" },
        body: JSON.stringify({ invite: "x".repeat(40), handle: "retry-lookup" }),
      }, { ...env, DB: db });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(log).toHaveBeenCalledWith("registration database failure", {
        name: "Error", kind: "unavailable",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("allows exactly one concurrent registration per invite", async () => {
    const invite = await issueInvite("race-org", "concurrent");
    const [a, b] = await Promise.all([
      register({ invite, handle: "racer-a" }, "203.0.113.171"),
      register({ invite, handle: "racer-b" }, "203.0.113.172"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM handles WHERE org = ?")
      .bind("race-org").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("rejects expired invites", async () => {
    const invite = await issueInvite("expired-org", "expired");
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE org = ?").bind(Date.now() - 1, "expired-org").run();
    expect((await register({ invite, handle: "late" }, "203.0.113.173")).status).toBe(404);
  });
  it("409s on duplicate handle", async () => {
    await register({ org: "acme", handle: "dup", agent_kind: "claude" }, "203.0.113.11");
    const res = await register({ org: "acme", handle: "dup", agent_kind: "codex" }, "203.0.113.11");
    expect(res.status).toBe(409);
  });
  it("400s on invalid handles and agent kinds", async () => {
    expect((await register({ org: "acme", handle: "Bad_Handle", agent_kind: "claude" }, "203.0.113.12")).status).toBe(400);
    expect((await register({ org: "acme", handle: "ok-handle", agent_kind: "vim" }, "203.0.113.12")).status).toBe(400);
  });
  it("allows formerly global system names inside each tenant", async () => {
    expect((await register({ org: "acme", handle: "admin" }, "203.0.113.167")).status).toBe(200);
    expect((await register({ org: "beta", handle: "admin" }, "203.0.113.168")).status).toBe(200);
  });
  it("registers caller-only (no agent_kind) and stores NULL", async () => {
    const res = await register({ org: "acme", handle: "solo" }, "203.0.113.13");
    expect(res.status).toBe(200);
    const json = await res.json<{ org: string; token: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    
    const row = await env.DB.prepare("SELECT agent_kind FROM handles WHERE org = ? AND handle = ?")
      .bind("acme", "solo").first<{ agent_kind: string | null }>();
    expect(row?.agent_kind).toBeNull();
  });
  it("409s a duplicate caller-only handle", async () => {
    await register({ org: "acme", handle: "solo-dup" }, "203.0.113.14");
    expect((await register({ org: "acme", handle: "solo-dup" }, "203.0.113.14")).status).toBe(409);
  });

  it("rate limits registration attempts from the same source past the configured burst limit", async () => {
    const ip = "203.0.113.99";
    for (let i = 0; i < 5; i++) {
      const invite = await issueInvite("acme", `rl-reg-${i}`);
      const res = await SELF.fetch("https://relay.test/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ invite, handle: `rl-reg-${i}`, agent_kind: "claude" }),
      });
      expect(res.status).toBe(200);
    }
    const sixth = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ invite: await issueInvite("acme", "rl-reg-6th"), handle: "rl-reg-6th", agent_kind: "claude" }),
    });
    expect(sixth.status).toBe(429);
  });

  it("allows the same handle in two tenants and keeps their tokens isolated", async () => {
    const acme = await register({ org: "acme", handle: "shared", agent_kind: "claude" }, "203.0.113.151");
    const beta = await register({ org: "beta", handle: "shared", agent_kind: "codex" }, "203.0.113.152");
    expect(acme.status).toBe(200);
    expect(beta.status).toBe(200);
    const acmeToken = (await acme.json<{ token: string }>()).token;
    expect((await SELF.fetch("https://relay.test/v1/token/rotate", {
      method: "POST", headers: wsAuth("shared", acmeToken, "beta"),
    })).status).toBe(401);
  });

  // Was: the response carries `person@hosted.agentcall.benree.tech`. There is
  // no address on the wire now, and the tenant comes from the invite rather
  // than from any hostname, so what is asserted is the org.
  it("returns the invite's tenant on the hosted relay", async () => {
    const invite = await issueInvite("hosted", "hosted-address");
    const res = await SELF.fetch("https://agentcall.benree.tech/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.153" },
      body: JSON.stringify({ invite, handle: "person", agent_kind: "claude" }),
    });
    expect(await res.json()).toMatchObject({ org: "hosted" });
  });

  it("uses the invite tenant rather than a conflicting hosted tenant subdomain", async () => {
    const invite = await issueInvite("bob", "host-mismatch");
    const res = await SELF.fetch("https://acme.agentcall.benree.tech/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.213" },
      body: JSON.stringify({ invite, handle: "person" }),
    });
    expect(await res.json()).toMatchObject({ org: "bob" });
  });
});

describe("POST /v1/admin/invite", () => {
  it("bootstraps the first tenant invite with the operator secret", async () => {
    const res = await SELF.fetch("https://relay.test/v1/admin/invite", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-bootstrap-token",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.169",
      },
      body: JSON.stringify({ org: "first-org" }),
    });
    expect(res.status).toBe(200);
    const { invite } = await res.json<{ invite: string }>();
    const enrolled = await register({ invite, handle: "founder" }, "203.0.113.170");
    expect(await enrolled.json()).toMatchObject({ org: "first-org" });
  });

  it("rejects a wrong operator secret without minting an invite", async () => {
    const res = await SELF.fetch("https://relay.test/v1/admin/invite", {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ org: "forged" }),
    });
    expect(res.status).toBe(401);
  });
});

// A leaked token used to be permanent: register was the only write to the
// handles table anywhere in the codebase, and `uninstall --purge` clears the
// local copy while the relay row and its hash live on forever.
//
// Token validity is probed with another rotate rather than with /v1/status:
// status wakes a Durable Object, and this file otherwise touches only D1 --
// dragging the DO in blows vitest-pool-workers isolated storage.
describe("POST /v1/token/rotate", () => {
  const rotate = (handle: string, token: string) =>
    SELF.fetch("https://relay.test/v1/token/rotate", { method: "POST", headers: wsAuth(handle, token) });

  it("issues a new token and retires the old one", async () => {
    const old = await registerHandle("rot");
    const res = await rotate("rot", old);
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    expect(token).not.toBe(old);
    // The old token is dead -- the whole point of rotating.
    expect((await rotate("rot", old)).status).toBe(401);
    // The new one works.
    expect((await rotate("rot", token)).status).toBe(200);
  });

  it("401s an unauthenticated rotate", async () => {
    await registerHandle("rot2");
    expect((await SELF.fetch("https://relay.test/v1/token/rotate", { method: "POST" })).status).toBe(401);
  });

  it("401s a rotate bearing the wrong token, leaving the real one working", async () => {
    const real = await registerHandle("rot3");
    expect((await rotate("rot3", "not-the-token")).status).toBe(401);
    expect((await rotate("rot3", real)).status).toBe(200);
  });

  it("does not create a handle that was never registered", async () => {
    expect((await rotate("ghost-handle", "whatever")).status).toBe(401);
    const row = await env.DB.prepare("SELECT 1 FROM handles WHERE org = ? AND handle = ?")
      .bind("acme", "ghost-handle").first();
    expect(row).toBeNull();
  });

  it("elects only one token when two rotations race", async () => {
    const old = await registerHandle("rot-race");
    const results = await Promise.all([rotate("rot-race", old), rotate("rot-race", old)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = results.find((res) => res.status === 200)!;
    const { token } = await winner.json<{ token: string }>();
    expect((await rotate("rot-race", token)).status).toBe(200);
  });
});
