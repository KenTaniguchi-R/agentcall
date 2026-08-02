import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        BOOTSTRAP_TOKEN: "test-bootstrap-token",
        RATE_LIMIT_NOW: 1_000_000,
      },
    },
  }))],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
