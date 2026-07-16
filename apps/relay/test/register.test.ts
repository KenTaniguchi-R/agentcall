import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function register(body: unknown) {
  return SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/register", () => {
  it("registers a handle and returns token + address", async () => {
    const res = await register({ handle: "ken", agent_kind: "claude" });
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("ken@agentcall.benree.tech");
  });
  it("409s on duplicate handle", async () => {
    await register({ handle: "dup", agent_kind: "claude" });
    const res = await register({ handle: "dup", agent_kind: "codex" });
    expect(res.status).toBe(409);
  });
  it("400s on invalid handle and reserved handle", async () => {
    expect((await register({ handle: "Bad_Handle", agent_kind: "claude" })).status).toBe(400);
    expect((await register({ handle: "admin", agent_kind: "claude" })).status).toBe(400);
    expect((await register({ handle: "ok-handle", agent_kind: "vim" })).status).toBe(400);
  });
  it("registers caller-only (no agent_kind) and stores NULL", async () => {
    const res = await register({ handle: "solo" });
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("solo@agentcall.benree.tech");
    const row = await env.DB.prepare("SELECT agent_kind FROM handles WHERE handle = ?")
      .bind("solo").first<{ agent_kind: string | null }>();
    expect(row?.agent_kind).toBeNull();
  });
  it("409s a duplicate caller-only handle", async () => {
    await register({ handle: "solo-dup" });
    expect((await register({ handle: "solo-dup" })).status).toBe(409);
  });
});
