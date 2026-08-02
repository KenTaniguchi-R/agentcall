import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

// Each test uses its own synthetic source IP so the per-IP register rate
// limit (5/60s, see wrangler.jsonc's REGISTER_RL) doesn't make unrelated
// tests in this file collide with each other's budget.
async function register(body: unknown, ip = "203.0.113.1") {
  return SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/register", () => {
  it("registers a handle and returns token + address", async () => {
    const res = await register({ org: "acme", handle: "ken", agent_kind: "claude" }, "203.0.113.10");
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("ken@relay.test");
  });
  it("409s on duplicate handle", async () => {
    await register({ org: "acme", handle: "dup", agent_kind: "claude" }, "203.0.113.11");
    const res = await register({ org: "acme", handle: "dup", agent_kind: "codex" }, "203.0.113.11");
    expect(res.status).toBe(409);
  });
  it("400s on invalid handle and reserved handle", async () => {
    expect((await register({ org: "acme", handle: "Bad_Handle", agent_kind: "claude" }, "203.0.113.12")).status).toBe(400);
    expect((await register({ org: "acme", handle: "admin", agent_kind: "claude" }, "203.0.113.12")).status).toBe(400);
    expect((await register({ org: "acme", handle: "ok-handle", agent_kind: "vim" }, "203.0.113.12")).status).toBe(400);
  });
  it("registers caller-only (no agent_kind) and stores NULL", async () => {
    const res = await register({ org: "acme", handle: "solo" }, "203.0.113.13");
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("solo@relay.test");
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
      const res = await register({ org: "acme", handle: `rl-reg-${i}`, agent_kind: "claude" }, ip);
      expect(res.status).toBe(200);
    }
    const sixth = await register({ org: "acme", handle: "rl-reg-6th", agent_kind: "claude" }, ip);
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

  it("returns the tenant hostname on the hosted relay", async () => {
    const res = await SELF.fetch("https://agentcall.benree.tech/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.153" },
      body: JSON.stringify({ org: "hosted", handle: "person", agent_kind: "claude" }),
    });
    expect((await res.json<{ address: string }>()).address).toBe("person@hosted.agentcall.benree.tech");
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
});
