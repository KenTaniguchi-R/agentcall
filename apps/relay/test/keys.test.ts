import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("key publication schema", () => {
  it("creates identity_keys with a composite primary key", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
    ).bind("acme", "ken", "PUB", 1).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
      ).bind("acme", "ken", "OTHER", 2).run(),
    ).rejects.toThrow();
  });

  it("allows the same handle in a different org", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
    ).bind("beta", "ken", "PUB", 1).run();
    const row = await env.DB.prepare(
      "SELECT identity_pub FROM identity_keys WHERE org = ? AND handle = ?",
    ).bind("beta", "ken").first<{ identity_pub: string }>();
    expect(row?.identity_pub).toBe("PUB");
  });

  it("rejects two encryption keys at the same epoch for one identity", async () => {
    const insert = (epoch: number) => env.DB.prepare(
      "INSERT INTO encryption_keys (org, handle, key_id, suite, pub, epoch, not_before, not_after, prev, signature, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("acme", "dup", `k${epoch}`, "SUITE", "PUB", epoch, 1, 2, null, "SIG", 1).run();

    await insert(1);
    await expect(insert(1)).rejects.toThrow();
  });
});
