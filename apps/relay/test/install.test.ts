import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /install.sh", () => {
  it("serves a shell script", async () => {
    const res = await SELF.fetch("https://relay.test/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const body = await res.text();
    expect(body).toContain("#!/bin/sh");
    expect(body).toContain("npm install -g @benree/agentcall");
    expect(body).toContain("npm prefix -g");
    expect(body).toContain('"$AGENTCALL_BIN" setup');
    expect(body).toContain("/dev/tty");
    expect(body).toContain("Darwin");
  });
});
