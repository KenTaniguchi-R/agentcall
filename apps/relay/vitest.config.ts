import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          // wrangler.jsonc's own "ratelimits" field isn't recognized by this
          // tool's wrangler.jsonc ingestion (it warns "Unexpected fields" and
          // drops it), so the bindings are declared directly here instead —
          // same binding names/limits, just wired through miniflare options.
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
            ratelimits: {
              REGISTER_RL: { namespace_id: "1001", simple: { limit: 5, period: 60 } },
              CARD_RL: { namespace_id: "1002", simple: { limit: 20, period: 60 } },
              READ_RL: { namespace_id: "1003", simple: { limit: 60, period: 60 } },
              ROSTER_RL: { namespace_id: "1004", simple: { limit: 10, period: 60 } },
            },
          },
        },
      },
    },
  };
});
