import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const dataMap = (env as unknown as { DATA_RESIDENCY_DOC: string }).DATA_RESIDENCY_DOC;

describe("cloud data map", () => {
  it("enumerates every table produced by the current D1 migrations", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "AND name NOT IN ('d1_migrations', '_cf_METADATA') ORDER BY name",
    ).all<{ name: string }>();
    const tables = (results ?? []).map((row) => row.name);

    expect(tables).toEqual([
      "cards", "encryption_keys", "handles", "identity_keys", "invites", "org_events",
      "roster_events", "roster_join_keys", "roster_members", "rosters", "telemetry_health",
    ]);
    for (const table of tables) expect(dataMap).toContain(`| \`${table}\` |`);
  });

  it("names every non-D1 persisted relay surface", () => {
    for (const surface of [
      "`call:*`", "`audit:*`", "`rl:*`", "`hits`", "`agentcall_status_reads`",
      "`HANDLE_DO`", "`RATE_LIMITER_DO`", "`CARD_RL`", "`READ_RL`", "`ROSTER_READ_RL`",
    ]) {
      expect(dataMap).toContain(surface);
    }
  });
});
