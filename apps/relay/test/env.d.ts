declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    HANDLE_DO: DurableObjectNamespace;
    TEST_MIGRATIONS: import("wrangler").D1Migration[];
  }
}
