declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    HANDLE_DO: DurableObjectNamespace;
    RATE_LIMITER_DO: DurableObjectNamespace;
    CARD_RL: RateLimit;
    READ_RL: RateLimit;
    RATE_LIMIT_NOW: number;
    BOOTSTRAP_TOKEN: string;
    DEPLOYMENT_MODE: "hosted" | "self-hosted";
    HOSTED_WRANGLER_CONFIG: string;
    SELF_HOST_WRANGLER_CONFIG: string;
    TEST_MIGRATIONS: import("wrangler").D1Migration[];
  }
}
