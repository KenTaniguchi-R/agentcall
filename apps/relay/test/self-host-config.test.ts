import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const readJsonc = (raw: string) => JSON.parse(
  raw.replace(/^\s*\/\/.*$/gm, ""),
);

function liveExports(exports: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(exports).filter(([, value]) => value.state !== "deleted"),
  );
}

function normalizedRuntimeConfig(input: any): any {
  const config = structuredClone(input);
  // The official hosted relay also serves the AgentCall product site. A
  // customer-owned relay intentionally does not publish those brand assets.
  for (const key of ["name", "account_id", "assets", "routes", "workers_dev", "preview_urls"]) delete config[key];
  if (config.vars) {
    if (config.vars.DEPLOYMENT_MODE) config.vars.DEPLOYMENT_MODE = "<deployment-mode>";
    delete config.vars.SELF_HOSTED_ORG;
    if (Object.keys(config.vars).length === 0) delete config.vars;
  }
  for (const database of config.d1_databases ?? []) {
    database.database_name = "<customer-d1-name>";
    database.database_id = "<customer-d1-id>";
  }
  for (const dataset of config.analytics_engine_datasets ?? []) dataset.dataset = "<customer-dataset>";
  for (const rateLimit of config.ratelimits ?? []) rateLimit.namespace_id = "<customer-rate-namespace>";
  // Hosted deletion tombstones retire namespaces provisioned by earlier
  // releases. A fresh self-hosted account never owned those namespaces.
  if (config.exports) config.exports = liveExports(config.exports);
  return config;
}

describe("self-host Wrangler distribution", () => {
  it("ships a customer-owned config with every runtime binding", () => {
    const hosted = readJsonc(env.HOSTED_WRANGLER_CONFIG);
    const selfHosted = readJsonc(env.SELF_HOST_WRANGLER_CONFIG);

    expect(selfHosted).toMatchObject({
      main: hosted.main,
      compatibility_date: hosted.compatibility_date,
      workers_dev: false,
      preview_urls: false,
      vars: { DEPLOYMENT_MODE: "self-hosted", SELF_HOSTED_ORG: "replace-with-org" },
      d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
      analytics_engine_datasets: [{ binding: "STATUS_READS" }],
      durable_objects: hosted.durable_objects,
      exports: liveExports(hosted.exports),
      routes: [{ pattern: "relay.example.com", custom_domain: true }],
    });
    expect(hosted.exports.RoomDO).toEqual({ type: "durable-object", state: "deleted" });
    expect(selfHosted.exports).not.toHaveProperty("RoomDO");
    expect(hosted.assets).toEqual({
      directory: "../landing",
      binding: "ASSETS",
      run_worker_first: ["/v1/*", "/.well-known/*"],
    });
    expect(selfHosted).not.toHaveProperty("assets");
    expect(selfHosted.ratelimits.map((binding: any) => ({
      name: binding.name, simple: binding.simple,
    }))).toEqual(hosted.ratelimits.map((binding: any) => ({
      name: binding.name, simple: binding.simple,
    })));
    // Compare every other current and future top-level runtime field, not a
    // hand-maintained binding-category allowlist. Only customer-owned resource
    // identities and routing differ between the two manifests.
    expect(normalizedRuntimeConfig(selfHosted)).toEqual(normalizedRuntimeConfig(hosted));
    const namespaceIds = selfHosted.ratelimits.map((binding: any) => binding.namespace_id);
    expect(namespaceIds).toHaveLength(new Set(namespaceIds).size);
    expect(namespaceIds.every((id: string) => /^[1-9]\d*$/.test(id))).toBe(true);
  });

  it("contains no hosted account resource identifiers or bypass route", () => {
    const hosted = readJsonc(env.HOSTED_WRANGLER_CONFIG);
    const selfHosted = readJsonc(env.SELF_HOST_WRANGLER_CONFIG);
    const raw = env.SELF_HOST_WRANGLER_CONFIG;
    expect(selfHosted).not.toHaveProperty("account_id");
    expect(selfHosted.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(selfHosted.d1_databases[0].database_id).not.toBe(hosted.d1_databases[0].database_id);
    expect(raw).not.toContain(hosted.account_id);
    expect(raw).not.toContain("agent-call.app");
  });
});
