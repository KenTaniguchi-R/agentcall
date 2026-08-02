import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../src/auth.js";
import { registerHandle, wsAuth } from "./helpers.js";

describe("constantTimeEqual", () => {
  it("matches equal strings", () => {
    expect(constantTimeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("does not match a single-character difference", () => {
    const a = "0123456789abcdef".repeat(4);
    const b = "0123456789abcdee".repeat(4);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("does not match strings of different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

async function rotate(handle: string, token: string) {
  return SELF.fetch("https://relay.test/v1/token/rotate", {
    method: "POST",
    headers: { ...wsAuth(handle, token), "cf-connecting-ip": `rot-${handle}` },
  });
}

describe("POST /v1/token/rotate concurrency", () => {
  it("only one of two concurrent rotations succeeds", async () => {
    const token = await registerHandle("rot-race");
    const [a, b] = await Promise.all([rotate("rot-race", token), rotate("rot-race", token)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("the winning rotation's token actually works", async () => {
    const token = await registerHandle("rot-live");
    const res = await rotate("rot-live", token);
    expect(res.status).toBe(200);
    const next = (await res.json<{ token: string }>()).token;
    // The new token authenticates; the old one no longer does.
    expect((await rotate("rot-live", next)).status).toBe(200);
    expect((await rotate("rot-live", token)).status).toBe(401);
  });
});
