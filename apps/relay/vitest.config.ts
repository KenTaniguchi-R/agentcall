import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        DATA_RESIDENCY_DOC: await readFile(
          new URL("../../docs/security/data-residency.md", import.meta.url), "utf8",
        ),
        HOSTED_WRANGLER_CONFIG: await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
        SELF_HOST_WRANGLER_CONFIG: await readFile(
          new URL("./wrangler.self-host.example.jsonc", import.meta.url), "utf8",
        ),
        BOOTSTRAP_TOKEN: "test-bootstrap-token",
        DEPLOYMENT_MODE: "hosted",
        RATE_LIMIT_NOW: 1_000_000,
      },
    },
  }))],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
