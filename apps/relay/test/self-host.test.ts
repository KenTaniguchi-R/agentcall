import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index.js";
import { sha256Hex } from "../src/auth.js";
import { deploymentOrgAllows, requestOrg } from "../src/tenant.js";
import { issueInvite, wsAuth } from "./helpers.js";

const requestLike = (org?: string) => ({
  header: (name: string) => name === "X-AgentCall-Org" ? org : undefined,
});
const selfHostEnv = (org: string) => ({
  ...env, DEPLOYMENT_MODE: "self-hosted" as const, SELF_HOSTED_ORG: org,
});

describe("single-organization self-host boundary", () => {
  it("uses the configured organization without encoding it in the hostname", () => {
    expect(requestOrg(requestLike(), "self-hosted", "acme")).toBe("acme");
    expect(requestOrg(requestLike("acme"), "self-hosted", "acme")).toBe("acme");
  });

  it("fails closed on a conflicting header or malformed deployment organization", () => {
    expect(requestOrg(requestLike("other"), "self-hosted", "acme")).toBe("");
    expect(requestOrg(requestLike(), "self-hosted", "Not Valid")).toBe("");
    expect(requestOrg(requestLike(), undefined, "acme")).toBe("");
  });

  it("prevents bootstrap and invite redemption from creating another tenant", () => {
    expect(deploymentOrgAllows(undefined, undefined, "any-valid-org")).toBe(false);
    expect(deploymentOrgAllows("hosted", undefined, "any-valid-org")).toBe(true);
    expect(deploymentOrgAllows("hosted", "acme", "acme")).toBe(false);
    expect(deploymentOrgAllows("self-hosted", "acme", "acme")).toBe(true);
    expect(deploymentOrgAllows("self-hosted", "acme", "other")).toBe(false);
    expect(deploymentOrgAllows("self-hosted", "Not Valid", "Not Valid")).toBe(false);
  });

  // Was: a hosted request derives its org from the tenant subdomain. That
  // fallback is deleted, and `RequestLike` no longer carries a URL at all — a
  // hostname cannot reach `requestOrg` to be trusted, so the subdomain case is
  // unrepresentable rather than merely asserted against. What is still worth
  // asserting is that the header is the only source: no header, no org.
  it("resolves no org for a hosted request without the org header", () => {
    expect(requestOrg(requestLike(), "hosted")).toBe("");
  });

  it("rejects an invite from another tenant without consuming it", async () => {
    const invite = await issueInvite("other", "self-host-cross-tenant");
    const response = await app.request("https://agents.acme.example/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.230" },
      body: JSON.stringify({ invite, handle: "outsider" }),
    }, selfHostEnv("acme"));
    expect(response.status).toBe(404);
    expect(await env.DB.prepare("SELECT used_at FROM invites WHERE org = ? AND token_hash = ?")
      .bind("other", await sha256Hex(invite)).first()).toEqual({ used_at: null });
  });

  it("registers and authenticates the configured tenant on one customer hostname", async () => {
    const invite = await issueInvite("acme", "self-host-registration");
    const registered = await app.request("https://agents.acme.example/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.231" },
      body: JSON.stringify({ invite, handle: "customer-user" }),
    }, selfHostEnv("acme"));
    const body = await registered.json<{ org: string; token: string }>();
    expect(registered.status).toBe(200);
    // Self-hosted or hosted, the org is the same value and the address is
    // rendered from it: the customer hostname does not appear.
    expect(body.org).toBe("acme");

    const firstRotation = await app.request("https://agents.acme.example/v1/token/rotate", {
      method: "POST", headers: wsAuth("customer-user", body.token, "acme"),
    }, selfHostEnv("acme"));
    expect(firstRotation.status).toBe(200);
    const firstToken = (await firstRotation.json<{ token: string }>()).token;

    const headerlessRotation = await app.request("https://agents.acme.example/v1/token/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${firstToken}`, "X-AgentCall-Handle": "customer-user" },
    }, selfHostEnv("acme"));
    expect(headerlessRotation.status).toBe(200);
    const currentToken = (await headerlessRotation.json<{ token: string }>()).token;
    expect((await app.request("https://agents.acme.example/v1/token/rotate", {
      method: "POST", headers: wsAuth("customer-user", currentToken, "other"),
    }, selfHostEnv("acme"))).status).toBe(401);
    expect((await app.request("https://agents.acme.example/v1/token/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${currentToken}`, "X-AgentCall-Handle": "customer-user" },
    }, selfHostEnv("Not Valid"))).status).toBe(401);
  });

  it("rejects bootstrap for any organization except the configured one", async () => {
    const response = await app.request("https://agents.acme.example/v1/admin/invite", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-bootstrap-token", "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.232",
      },
      body: JSON.stringify({ org: "other" }),
    }, selfHostEnv("acme"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "organization does not match this relay" });
  });

  it("bootstraps, enrolls, and delegates another invite within the configured tenant", async () => {
    const issued = await app.request("https://agents.customer.example/v1/admin/invite", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-bootstrap-token", "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.233",
      },
      body: JSON.stringify({ org: "customer-org" }),
    }, selfHostEnv("customer-org"));
    expect(issued.status).toBe(200);
    const invite = (await issued.json<{ invite: string }>()).invite;
    const registered = await app.request("https://agents.customer.example/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.234" },
      body: JSON.stringify({ invite, handle: "founder" }),
    }, selfHostEnv("customer-org"));
    const token = (await registered.json<{ token: string }>()).token;
    expect(registered.status).toBe(200);

    const delegated = await app.request("https://agents.customer.example/v1/invites", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "X-AgentCall-Handle": "founder",
        "content-type": "application/json",
      },
      body: "{}",
    }, selfHostEnv("customer-org"));
    expect(delegated.status).toBe(200);
  });

  it("opens listen and call WebSockets inside the configured tenant", async () => {
    const register = async (handle: string, ip: string) => {
      const invite = await issueInvite("socket-org", `self-host-${handle}`);
      const response = await app.request("https://agents.socket.example/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ invite, handle }),
      }, selfHostEnv("socket-org"));
      expect(response.status).toBe(200);
      return (await response.json<{ token: string }>()).token;
    };
    const calleeToken = await register("self-host-callee", "203.0.113.235");
    const callerToken = await register("self-host-caller", "203.0.113.236");

    const listener = await app.request("https://agents.socket.example/v1/ws?role=listen", {
      headers: { Upgrade: "websocket", ...wsAuth("self-host-callee", calleeToken, "socket-org") },
    }, selfHostEnv("socket-org"));
    expect(listener.status).toBe(101);
    listener.webSocket?.accept();

    const caller = await app.request(
      "https://agents.socket.example/v1/ws?role=call&to=self-host-callee",
      { headers: { Upgrade: "websocket", ...wsAuth("self-host-caller", callerToken, "socket-org") } },
      selfHostEnv("socket-org"),
    );
    expect(caller.status).toBe(101);
    caller.webSocket?.accept();
    caller.webSocket?.close(1000, "test complete");
    listener.webSocket?.close(1000, "test complete");
  });
});
