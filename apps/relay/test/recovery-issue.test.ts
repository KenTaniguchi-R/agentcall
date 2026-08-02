import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

function issue(handle: string, token: string, ip = `iss-${handle}`) {
  return SELF.fetch("https://relay.test/v1/recovery/issue", {
    method: "POST",
    headers: { ...wsAuth(handle, token), "cf-connecting-ip": ip },
  });
}

function state(handle: string, token: string, ip = `st-${handle}`) {
  return SELF.fetch("https://relay.test/v1/recovery/state", {
    headers: { ...wsAuth(handle, token), "cf-connecting-ip": ip },
  });
}

describe("POST /v1/recovery/issue", () => {
  it("mints a code and replaces the previous hash", async () => {
    const token = await registerHandle("iss-one");
    const before = await env.DB.prepare("SELECT recovery_hash FROM handles WHERE handle = ?")
      .bind("iss-one").first<{ recovery_hash: string }>();

    const res = await issue("iss-one", token);
    expect(res.status).toBe(200);
    const { recovery_code } = await res.json<{ recovery_code: string }>();
    expect(recovery_code.startsWith("agcr_")).toBe(true);

    const after = await env.DB.prepare("SELECT recovery_hash FROM handles WHERE handle = ?")
      .bind("iss-one").first<{ recovery_hash: string }>();
    expect(after?.recovery_hash).not.toBe(before?.recovery_hash);
  });

  it("401s without a valid token", async () => {
    await registerHandle("iss-auth");
    expect((await issue("iss-auth", "wrong-token")).status).toBe(401);
    expect((await issue("nobody-here", "wrong-token")).status).toBe(401);
  });
});

describe("GET /v1/recovery/state", () => {
  it("reports issued=true and a null redeemed_at for a fresh handle", async () => {
    const token = await registerHandle("st-fresh");
    const res = await state("st-fresh", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issued: true, redeemed_at: null });
  });

  it("reports issued=false for a handle predating the migration", async () => {
    const token = await registerHandle("st-legacy");
    await env.DB.prepare("UPDATE handles SET recovery_hash = NULL WHERE handle = ?").bind("st-legacy").run();
    expect(await (await state("st-legacy", token)).json()).toEqual({ issued: false, redeemed_at: null });
  });

  it("never returns the hash", async () => {
    const token = await registerHandle("st-secret");
    const body = await (await state("st-secret", token)).text();
    expect(body).not.toContain("recovery_hash");
    expect(body.length).toBeLessThan(100);
  });

  it("401s without a valid token", async () => {
    await registerHandle("st-auth");
    expect((await state("st-auth", "wrong-token")).status).toBe(401);
  });
});

describe("RECOVER_RL", () => {
  // Both keys are charged per request, so exceeding either one alone is
  // enough to trip. Four requests against a limit of 3 — deliberately only
  // one over, so this does not depend on a long burst landing inside one
  // ambient 60s window the way register.test.ts's known flake does.
  it("trips on the handle key when one handle is hit from many IPs", async () => {
    const token = await registerHandle("rl-handle");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await issue("rl-handle", token, `rl-ip-${i}`));
    expect(results.some((r) => r.status === 429)).toBe(true);
  });

  it("trips on the IP key when one IP hits many handles", async () => {
    const tokens = await Promise.all([0, 1, 2, 3].map((i) => registerHandle(`rl-ip-h${i}`)));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await issue(`rl-ip-h${i}`, tokens[i], "rl-shared-ip"));
    expect(results.some((r) => r.status === 429)).toBe(true);
  });
});
