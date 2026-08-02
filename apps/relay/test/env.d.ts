declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    HANDLE_DO: DurableObjectNamespace;
    REGISTER_RL: RateLimit;
    CARD_RL: RateLimit;
    BOOTSTRAP_TOKEN: string;
    TEST_MIGRATIONS: import("wrangler").D1Migration[];
  }
}
