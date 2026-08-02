import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROSTER_ID_RE } from "@benree/agentcall-shared";
import { registerHandle, wsAuth } from "./helpers.js";

async function createRoster(handle: string, token: string) {
  return SELF.fetch("https://relay.test/v1/roster", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
  });
}

describe("POST /v1/roster", () => {
  it("returns an opaque id and separate join/admin secrets to an authenticated handle", async () => {
    const token = await registerHandle("rc1");
    const res = await createRoster("rc1", token);
    expect(res.status).toBe(200);
    const body = await res.json<{ roster_id: string; join_secret: string; admin_secret: string }>();
    expect(ROSTER_ID_RE.test(body.roster_id)).toBe(true);
    expect(body.join_secret.length).toBeGreaterThan(20);
    expect(body.admin_secret.length).toBeGreaterThan(20);
    expect(body.admin_secret).not.toBe(body.join_secret);
  });

  it("401s without credentials", async () => {
    expect((await SELF.fetch("https://relay.test/v1/roster", { method: "POST" })).status).toBe(401);
  });

  it("401s on a bad token", async () => {
    await registerHandle("rc2");
    expect((await createRoster("rc2", "wrong-token")).status).toBe(401);
  });

  it("gives each roster a distinct id", async () => {
    const token = await registerHandle("rc3");
    const a = await (await createRoster("rc3", token)).json<{ roster_id: string }>();
    const b = await (await createRoster("rc3", token)).json<{ roster_id: string }>();
    expect(a.roster_id).not.toBe(b.roster_id);
  });

  it("does not derive the id from the creating handle", async () => {
    const token = await registerHandle("rc4");
    const { roster_id } = await (await createRoster("rc4", token)).json<{ roster_id: string }>();
    expect(roster_id).not.toContain("rc4");
  });
});
