import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const ORIGIN = "https://example.com";
let viewerToken: string;

async function seedCard(handle: string) {
  await registerHandle(handle);
  await env.DB.prepare("INSERT OR REPLACE INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?)")
    .bind(
      "acme",
      handle,
      JSON.stringify({
        description: "Ken's agent",
        agent_kind: "claude",
        tasks: [{ id: "ask", name: "Ask", description: "Answer a question.", examples: [] }],
        default_offer: ["ask"],
        grants: { someoneelse: ["secret-task"] },
      }),
      1,
    )
    .run();
}

beforeAll(async () => {
  await seedCard("ken");
  viewerToken = await registerHandle("viewer");
});

const viewerHeaders = () => wsAuth("viewer", viewerToken);

describe("GET /.well-known/agent-card.json", () => {
  it("serves the relay directory card", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json<any>();
    expect(card.name).toBe("agentcall relay");
    expect(card.supportedInterfaces[0].protocolBinding).toBe("HTTP+JSON");
  });

  it("sets the caching headers the TCK checks", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-card.json`);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("last-modified")).toBeTruthy();
  });
});

describe("GET /v1/a2a/:handle/agent-card.json", () => {
  it("serves a conformant card for a known handle", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, { headers: viewerHeaders() });
    expect(res.status).toBe(200);
    const card = await res.json<any>();
    expect(card.name).toBe("ken");
    expect(card.skills.map((s: any) => s.id)).toEqual(["ask"]);
    expect(card.supportedInterfaces[0].url).toBe(`${ORIGIN}/v1/a2a/ken`);
    // The handle is already the leading path segment of `url`; `tenant`
    // would double-specify it, so it must be absent.
    expect(card.supportedInterfaces[0].tenant).toBeUndefined();
  });

  it("never exposes grants or agent_kind", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, { headers: viewerHeaders() });
    const body = await res.text();
    expect(body).not.toContain("grants");
    expect(body).not.toContain("secret-task");
    expect(body).not.toContain("agent_kind");
  });

  it("sets caching headers", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, { headers: viewerHeaders() });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("returns an AIP-193 404 for an unknown handle", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/nobody/agent-card.json`, { headers: viewerHeaders() });
    expect(res.status).toBe(404);
    const body = await res.json<any>();
    expect(body.error.code).toBe(404);
    expect(typeof body.error.code).toBe("number");
  });

  it("rejects an unsupported A2A-Version with VersionNotSupported", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, {
      headers: { "A2A-Version": "0.3", ...viewerHeaders() },
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error.details[0].reason).toBe("VERSION_NOT_SUPPORTED");
    expect(body.error.details[0].domain).toBe("a2a-protocol.org");
  });

  it("accepts the advertised A2A-Version", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, {
      headers: { "A2A-Version": "1.0", ...viewerHeaders() },
    });
    expect(res.status).toBe(200);
  });

  it("derives the tenant from the hosted request hostname", async () => {
    const res = await SELF.fetch("https://acme.agentcall.benree.tech/v1/a2a/ken/agent-card.json", {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-AgentCall-Handle": "viewer" },
    });
    expect(res.status).toBe(200);
  });

  it("401s an anonymous per-agent card read", async () => {
    expect((await SELF.fetch("https://acme.agentcall.benree.tech/v1/a2a/ken/agent-card.json")).status).toBe(401);
  });
});
