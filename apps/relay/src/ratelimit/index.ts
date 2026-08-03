export type RateLimitEnv = {
  RATE_LIMITER_DO: DurableObjectNamespace;
  CARD_RL: RateLimit;
  READ_RL: RateLimit;
  ROSTER_READ_RL: RateLimit;
  /** Fixed only by the isolated test runtime; production always uses Date.now(). */
  RATE_LIMIT_NOW?: number;
};

type DurablePolicy = {
  backend: "durable";
  namespace: string;
  limit: number;
  windowMs: number;
};

type NativePolicy = {
  backend: "native";
  binding: "CARD_RL" | "READ_RL" | "ROSTER_READ_RL";
};

export type RateLimitPolicy = DurablePolicy | NativePolicy;

export const REGISTER = {
  backend: "durable", namespace: "register", limit: 5, windowMs: 60_000,
} as const satisfies DurablePolicy;
export const ROSTER_WRITE = {
  backend: "durable", namespace: "roster-write", limit: 10, windowMs: 60_000,
} as const satisfies DurablePolicy;
export const AUDIT_READ = {
  backend: "durable", namespace: "audit-read", limit: 120, windowMs: 60_000,
} as const satisfies DurablePolicy;
export const AUDIT_WRITE = {
  backend: "durable", namespace: "audit-write", limit: 30, windowMs: 60_000,
} as const satisfies DurablePolicy;
export const NATIVE_CARD = { backend: "native", binding: "CARD_RL" } as const satisfies NativePolicy;
export const NATIVE_READ = { backend: "native", binding: "READ_RL" } as const satisfies NativePolicy;
export const NATIVE_ROSTER_READ = {
  backend: "native", binding: "ROSTER_READ_RL",
} as const satisfies NativePolicy;

const DURABLE_SHARDS = 64;

function shardFor(key: string): number {
  // FNV-1a is sufficient here: the full key remains in SQLite, so hash
  // collisions only share serialization work and never share a budget.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % DURABLE_SHARDS;
}

export async function checkLimit(env: RateLimitEnv, key: string, policy: RateLimitPolicy): Promise<boolean> {
  if (policy.backend === "native") return (await env[policy.binding].limit({ key })).success;

  // A bounded shard set avoids creating permanent DO identities for an
  // unbounded stream of attacker-controlled IPs or credential targets.
  const id = env.RATE_LIMITER_DO.idFromName(`${policy.namespace}:${shardFor(key)}`);
  const response = await env.RATE_LIMITER_DO.get(id).fetch("https://rate-limit/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      limit: policy.limit,
      windowMs: policy.windowMs,
      now: env.RATE_LIMIT_NOW ?? Date.now(),
      key,
    }),
  });
  if (!response.ok) throw new Error(`rate limiter failed with HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || typeof (result as { success?: unknown }).success !== "boolean") {
    throw new Error("rate limiter returned an invalid response");
  }
  return (result as { success: boolean }).success;
}
