import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
    const res = await register({ handle: "ken", agent_kind: "claude" }, "203.0.113.10");
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("ken@agentcall.benree.tech");
  });
  it("409s on duplicate handle", async () => {
    await register({ handle: "dup", agent_kind: "claude" }, "203.0.113.11");
    const res = await register({ handle: "dup", agent_kind: "codex" }, "203.0.113.11");
    expect(res.status).toBe(409);
  });
  it("400s on invalid handle and reserved handle", async () => {
    expect((await register({ handle: "Bad_Handle", agent_kind: "claude" }, "203.0.113.12")).status).toBe(400);
    expect((await register({ handle: "admin", agent_kind: "claude" }, "203.0.113.12")).status).toBe(400);
    expect((await register({ handle: "ok-handle", agent_kind: "vim" }, "203.0.113.12")).status).toBe(400);
  });
  it("registers caller-only (no agent_kind) and stores NULL", async () => {
    const res = await register({ handle: "solo" }, "203.0.113.13");
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("solo@agentcall.benree.tech");
    const row = await env.DB.prepare("SELECT agent_kind FROM handles WHERE handle = ?")
      .bind("solo").first<{ agent_kind: string | null }>();
    expect(row?.agent_kind).toBeNull();
  });
  it("409s a duplicate caller-only handle", async () => {
    await register({ handle: "solo-dup" }, "203.0.113.14");
    expect((await register({ handle: "solo-dup" }, "203.0.113.14")).status).toBe(409);
  });

  it("rate limits registration attempts from the same source past the configured burst limit", async () => {
    const ip = "203.0.113.99";
    for (let i = 0; i < 5; i++) {
      const res = await register({ handle: `rl-reg-${i}`, agent_kind: "claude" }, ip);
      expect(res.status).toBe(200);
    }
    const sixth = await register({ handle: "rl-reg-6th", agent_kind: "claude" }, ip);
    expect(sixth.status).toBe(429);
  });
});
