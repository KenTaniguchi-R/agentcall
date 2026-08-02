declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    HANDLE_DO: DurableObjectNamespace;
    RATE_LIMITER_DO: DurableObjectNamespace;
    CARD_RL: RateLimit;
    READ_RL: RateLimit;
    ROSTER_READ_RL: RateLimit;
    RATE_LIMIT_NOW: number;
    BOOTSTRAP_TOKEN: string;
    TEST_MIGRATIONS: import("wrangler").D1Migration[];
  }
}
