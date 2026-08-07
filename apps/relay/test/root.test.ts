import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /", () => {
  it("serves the product landing page and its assets", async () => {
    const response = await SELF.fetch("https://relay.test/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("I got a question,");
    expect(body).toContain("let me ask <em class=\"accent\">your</em> Claude.");

    const favicon = await SELF.fetch("https://relay.test/assets/favicon.svg");
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
  });
});
