import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  checkLimit, NATIVE_CARD, NATIVE_READ, NATIVE_ROSTER_READ, REGISTER,
} from "../src/ratelimit/index.js";

async function durableCheck(
  shard: string, key: string, now: number, limit = 2, windowMs = 1_000,
): Promise<boolean> {
  const id = env.RATE_LIMITER_DO.idFromName(shard);
  const response = await env.RATE_LIMITER_DO.get(id).fetch("https://rate-limit/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, now, limit, windowMs }),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ success: boolean }>()).success;
}

describe("RateLimiterDO", () => {
  it("enforces a sliding window with an exact, deterministic boundary", async () => {
    const name = crypto.randomUUID();
    expect(await durableCheck(name, "same-key", 10_000)).toBe(true);
    expect(await durableCheck(name, "same-key", 10_100)).toBe(true);
    expect(await durableCheck(name, "same-key", 10_999)).toBe(false);
    expect(await durableCheck(name, "same-key", 11_000)).toBe(true);
  });

  it("isolates independently keyed limiters", async () => {
    const prefix = crypto.randomUUID();
    expect(await durableCheck(prefix, "a", 1_000, 1)).toBe(true);
    expect(await durableCheck(prefix, "a", 1_000, 1)).toBe(false);
    expect(await durableCheck(prefix, "b", 1_000, 1)).toBe(true);
  });

  it("admits no more than the limit under concurrent requests", async () => {
    const name = crypto.randomUUID();
    const results = await Promise.all(Array.from(
      { length: 8 }, () => durableCheck(name, "same-key", 5_000, 3),
    ));
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});

describe("checkLimit", () => {
  it("loads every native rate-limit binding from wrangler.jsonc", async () => {
    const key = crypto.randomUUID();
    for (const policy of [NATIVE_CARD, NATIVE_READ, NATIVE_ROSTER_READ]) {
      expect(await checkLimit(env, key, policy)).toBe(true);
    }
  });

  it("routes credential policies through the Durable Object", async () => {
    const key = crypto.randomUUID();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await checkLimit(env, key, REGISTER)).toBe(true);
    }
    expect(await checkLimit(env, key, REGISTER)).toBe(false);
  });

  it("retains every non-credential policy on its native binding", async () => {
    const calls: string[] = [];
    const native = { limit: async ({ key }: { key: string }) => {
      calls.push(key);
      return { success: true };
    } } as RateLimit;
    const nativeEnv = {
      ...env, CARD_RL: native, READ_RL: native, ROSTER_READ_RL: native,
    };
    expect(await checkLimit(nativeEnv, "card", NATIVE_CARD)).toBe(true);
    expect(await checkLimit(nativeEnv, "read", NATIVE_READ)).toBe(true);
    expect(await checkLimit(nativeEnv, "roster-read", NATIVE_ROSTER_READ)).toBe(true);
    expect(calls).toEqual(["card", "read", "roster-read"]);
  });
});
