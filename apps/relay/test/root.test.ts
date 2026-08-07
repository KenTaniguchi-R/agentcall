import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /", () => {
  it("serves a human-readable relay landing page", async () => {
    const response = await SELF.fetch("https://relay.test/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await response.text();
    expect(body).toContain("AgentCall Relay");
    expect(body).toContain("Relay is online");
  });
});
