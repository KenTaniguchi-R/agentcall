import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { fixedRateLimit, registerHandle, wsAuth } from "./helpers.js";

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
        tasks: [{ id: "ask", name: "Ask", description: "Answer a question.", examples: [], keywords: [] }],
        default_offer: ["ask"],
        grants: { someoneelse: ["secret-task"] },
        group_grants: {},
        blocked: [],
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
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
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

  it("uses the A2A media type for protocol errors", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-card.json`, {
      headers: { "A2A-Version": "0.3" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
  });
});

describe("GET /v1/a2a/:handle/agent-card.json", () => {
  it("serves a conformant card for a known handle", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, { headers: viewerHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
    const card = await res.json<any>();
    expect(card.name).toBe("ken");
    expect(card.skills.map((s: any) => s.id)).toEqual(["ask"]);
    expect(card.supportedInterfaces[0].url).toBe(`${ORIGIN}/v1/a2a/ken`);
    // The handle is already the leading path segment of `url`; `tenant`
    // would double-specify it, so it must be absent.
    expect(card.supportedInterfaces[0].tenant).toBeUndefined();
  });

  it("treats a stored card that no longer validates as an unavailable agent", async () => {
    await registerHandle("legacy-card");
    await env.DB.prepare("INSERT INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?)")
      .bind("acme", "legacy-card", JSON.stringify({ description: "stale" }), 1).run();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invalid = await SELF.fetch(`${ORIGIN}/v1/a2a/legacy-card/agent-card.json`, {
        headers: viewerHeaders(),
      });
      const missing = await SELF.fetch(`${ORIGIN}/v1/a2a/nobody/agent-card.json`, {
        headers: viewerHeaders(),
      });
      expect(invalid.status).toBe(404);
      expect(invalid.headers.get("content-type")).toBe("application/a2a+json");
      expect(await invalid.text()).toBe(await missing.text());
      expect(log).toHaveBeenCalledWith("invalid stored card", {
        org: "acme", handle: "legacy-card", error: "ZodError",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("never exposes grants or agent_kind", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, { headers: viewerHeaders() });
    const body = await res.text();
    expect(body).not.toContain("grants");
    expect(body).not.toContain("secret-task");
    expect(body).not.toContain("agent_kind");
  });

  it("projects skills granted by relay-attested shared roster membership", async () => {
    const targetToken = await registerHandle("a2a-group");
    const created = await (await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST", headers: wsAuth("a2a-group", targetToken),
    })).json<{ roster_id: string; join_key: string }>();
    await SELF.fetch(`https://relay.test/v1/roster/${created.roster_id}/join`, {
      method: "POST", headers: { "content-type": "application/json", ...viewerHeaders() },
      body: JSON.stringify({ join_key: created.join_key }),
    });
    await env.DB.prepare("INSERT OR REPLACE INTO cards (org, handle, card_json, updated_at) VALUES (?, ?, ?, ?)")
      .bind("acme", "a2a-group", JSON.stringify({
        description: "grouped", agent_kind: "claude",
        tasks: [{ id: "eng", name: "Eng", description: "Engineering", examples: [], keywords: [] }],
        default_offer: [], grants: {}, group_grants: { [created.roster_id]: ["eng"] }, blocked: [],
      }), 2).run();

    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/a2a-group/agent-card.json`, { headers: viewerHeaders() });
    expect((await res.json<any>()).skills.map((skill: any) => skill.id)).toEqual(["eng"]);
  });

  it("makes an individual block indistinguishable from an unknown A2A agent", async () => {
    await registerHandle("a2a-blocked");
    await env.DB.prepare("INSERT INTO cards (org, handle, card_json, updated_at) VALUES ('acme', ?, ?, 3)")
      .bind("a2a-blocked", JSON.stringify({
        description: "blocked", agent_kind: "claude",
        tasks: [{ id: "ask", name: "Ask", description: "Ask", examples: [], keywords: [] }],
        default_offer: ["ask"], grants: {}, group_grants: {}, blocked: ["viewer"],
      })).run();
    const blocked = await SELF.fetch(`${ORIGIN}/v1/a2a/a2a-blocked/agent-card.json`, { headers: viewerHeaders() });
    const missing = await SELF.fetch(`${ORIGIN}/v1/a2a/nobody/agent-card.json`, { headers: viewerHeaders() });
    expect(blocked.headers.get("content-type")).toBe("application/a2a+json");
    expect(blocked.status).toBe(missing.status);
    expect(await blocked.text()).toBe(await missing.text());
  });

  it("sets caching headers", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, { headers: viewerHeaders() });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("uses the A2A media type when rate limited", async () => {
    const res = await app.request(`${ORIGIN}/v1/a2a/ken/agent-card.json`, {
      headers: viewerHeaders(),
    }, { ...env, READ_RL: fixedRateLimit(0) });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
  });

  it("returns an AIP-193 404 for an unknown handle", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/nobody/agent-card.json`, { headers: viewerHeaders() });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
    const body = await res.json<any>();
    expect(body.error.code).toBe(404);
    expect(typeof body.error.code).toBe("number");
  });

  it("rejects an unsupported A2A-Version with VersionNotSupported", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, {
      headers: { "A2A-Version": "0.3", ...viewerHeaders() },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
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
    const res = await SELF.fetch("https://acme.agent-call.app/v1/a2a/ken/agent-card.json", {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-AgentCall-Handle": "viewer" },
    });
    expect(res.status).toBe(200);
  });

  it("401s an anonymous per-agent card read", async () => {
    const res = await SELF.fetch("https://acme.agent-call.app/v1/a2a/ken/agent-card.json");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/a2a+json");
  });
});
