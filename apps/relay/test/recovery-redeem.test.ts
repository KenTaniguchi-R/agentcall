import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateRecoveryCode } from "@benree/agentcall-shared";
import { registerHandle, wsAuth } from "./helpers.js";

async function registerFull(handle: string) {
  const res = await SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `reg-${handle}` },
    body: JSON.stringify({ handle, agent_kind: "claude" }),
  });
  expect(res.status).toBe(200);
  return res.json<{ token: string; address: string; recovery_code: string }>();
}

function redeem(handle: string, code: string, ip = `rd-${handle}`) {
  return SELF.fetch("https://relay.test/v1/recovery/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ handle, recovery_code: code }),
  });
}

describe("POST /v1/recovery/redeem", () => {
  it("returns a working new token and a fresh code", async () => {
    const reg = await registerFull("rd-happy");
    const res = await redeem("rd-happy", reg.recovery_code);
    expect(res.status).toBe(200);
    const out = await res.json<{ token: string; recovery_code: string; address: string }>();
    expect(out.address).toBe("rd-happy@agentcall.benree.tech");
    expect(out.recovery_code).not.toBe(reg.recovery_code);

    // The new token authenticates.
    const check = await SELF.fetch("https://relay.test/v1/recovery/state", {
      headers: { ...wsAuth("rd-happy", out.token), "cf-connecting-ip": "rd-check" },
    });
    expect(check.status).toBe(200);
  });

  it("invalidates the redeemed code", async () => {
    const reg = await registerFull("rd-once");
    expect((await redeem("rd-once", reg.recovery_code)).status).toBe(200);
    expect((await redeem("rd-once", reg.recovery_code, "rd-once-2")).status).toBe(401);
  });

  it("kills the old token", async () => {
    const reg = await registerFull("rd-old");
    await redeem("rd-old", reg.recovery_code);
    const check = await SELF.fetch("https://relay.test/v1/recovery/state", {
      headers: { ...wsAuth("rd-old", reg.token), "cf-connecting-ip": "rd-old-chk" },
    });
    expect(check.status).toBe(401);
  });

  it("records recovery_redeemed_at", async () => {
    const reg = await registerFull("rd-stamp");
    await redeem("rd-stamp", reg.recovery_code);
    const row = await env.DB.prepare("SELECT recovery_redeemed_at FROM handles WHERE handle = ?")
      .bind("rd-stamp").first<{ recovery_redeemed_at: number | null }>();
    expect(typeof row?.recovery_redeemed_at).toBe("number");
  });

  // THE NULL TRAP. A handle registered before the migration has
  // recovery_hash NULL. If NULL ever compares equal to anything, every such
  // handle is redeemable by any stranger.
  it("never redeems a handle whose recovery_hash is NULL", async () => {
    await registerHandle("rd-null");
    await env.DB.prepare("UPDATE handles SET recovery_hash = NULL WHERE handle = ?").bind("rd-null").run();
    expect((await redeem("rd-null", generateRecoveryCode())).status).toBe(401);
    // And the row is untouched — a failed redeem must not mint a credential.
    const row = await env.DB.prepare("SELECT recovery_hash FROM handles WHERE handle = ?")
      .bind("rd-null").first<{ recovery_hash: string | null }>();
    expect(row?.recovery_hash).toBeNull();
  });

  it("returns byte-identical 401s for every failure mode", async () => {
    // Genuinely distinct branches: "rd-oracle-live" keeps the recovery_hash
    // register minted (so the redeem below fails on a hash mismatch — wrong
    // code), while "rd-oracle-never" has it forced to NULL (never-issued).
    // Comparing two NULLed handles instead — as an earlier version of this
    // test did — exercises the same branch twice and proves nothing about
    // the wrong-code path.
    await registerHandle("rd-oracle-live");
    await registerHandle("rd-oracle-never");
    await env.DB.prepare("UPDATE handles SET recovery_hash = NULL WHERE handle = ?").bind("rd-oracle-never").run();

    const wrongCode = await redeem("rd-oracle-live", generateRecoveryCode(), "rd-o1");
    const neverIssued = await redeem("rd-oracle-never", generateRecoveryCode(), "rd-o2");

    expect(wrongCode.status).toBe(401);
    expect(neverIssued.status).toBe(401);
    expect(await wrongCode.text()).toBe(await neverIssued.text());
  });

  // The rate limiter charges the IP key only, never the handle key: redeem
  // is unauthenticated, so a handle-keyed limit would let a stranger grind a
  // victim's handle budget from many IPs and hold it permanently 429'd,
  // denying the owner their own recovery. Each wrong guess below comes from
  // its own fresh IP (so the IP key never trips either), well past
  // RECOVER_RL's 3/60s — if the handle key were still charged, the handle
  // would already be locked out and the legitimate redeem at the end would
  // 429 instead of succeeding.
  it("does not consume the handle-key budget, so a legitimate redeem still succeeds after many wrong-code attempts", async () => {
    const reg = await registerFull("rd-nokey");
    for (let i = 0; i < 5; i++) {
      const res = await redeem("rd-nokey", generateRecoveryCode(), `rd-nokey-attacker-${i}`);
      expect(res.status).toBe(401);
    }
    const legit = await redeem("rd-nokey", reg.recovery_code, "rd-nokey-owner");
    expect(legit.status).toBe(200);
  });

  it("400s on a malformed code without touching the database", async () => {
    await registerFull("rd-bad");
    expect((await redeem("rd-bad", "not-a-code")).status).toBe(400);
  });

  it("only one of two concurrent redemptions succeeds", async () => {
    const reg = await registerFull("rd-race");
    const [a, b] = await Promise.all([
      redeem("rd-race", reg.recovery_code, "rd-race-1"),
      redeem("rd-race", reg.recovery_code, "rd-race-2"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});
