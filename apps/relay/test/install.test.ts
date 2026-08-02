import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /install.sh", () => {
  it("is not exposed publicly", async () => {
    const res = await SELF.fetch("https://relay.test/install.sh");
    expect(res.status).toBe(404);
  });
});
