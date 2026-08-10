import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { sha256Hex } from "../src/auth.js";

let inviteCounter = 0;
export async function issueInvite(
  org = "acme", label = "test", role: "admin" | "member" = "admin",
): Promise<string> {
  const invite = `${label}-${++inviteCounter}-${"x".repeat(40)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO invites (token_hash, org, created_at, expires_at, org_role) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256Hex(invite), org, now, now + 60_000, role).run();
  return invite;
}

export async function registerHandle(
  handle: string, kind: "claude" | "codex" = "claude", org = "acme",
  role: "admin" | "member" = "admin",
): Promise<string> {
  const res = await SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    // Synthetic per-handle source IP: without it every call in a test file
    // shares the same "unknown" fallback key and would collide with the
    // register-endpoint rate limit across unrelated tests.
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}` },
    body: JSON.stringify({ invite: await issueInvite(org, handle, role), handle, agent_kind: kind }),
  });
  expect(res.status).toBe(200);
  return (await res.json<{ token: string }>()).token;
}

// Cards and policy are keyed by the stable
// identity rather than the address (#154). Tests that seed those rows
// directly need the id the relay minted at registration.
export async function agentIdFor(handle: string, org = "acme"): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT agent_id FROM handles WHERE org = ? AND handle = ?",
  ).bind(org, handle).first<{ agent_id: string }>();
  if (!row) throw new Error(`no identity for ${handle}@${org} - register it first`);
  return row.agent_id;
}

export function wsAuth(handle: string, token: string, org = "acme"): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-AgentCall-Org": org, "X-AgentCall-Handle": handle };
}

function envelope(direction: "request" | "response", from: string, to: string, org = "acme") {
  return {
    v: 1 as const, direction, relay_origin: "relay.test",
    from: `@${org}/${from}`, to: `@${org}/${to}`, key_id: "a".repeat(32),
    epoch: 1, enc: "A", ct: "Q2lwaGVydGV4dA",
  };
}

export function encryptedCallRequest(
  from: string, to: string, metadata: { correlation_id?: string; traceparent?: string; org?: string } = {},
) {
  return {
    type: "call_request" as const,
    envelope: envelope("request", from, to, metadata.org),
    correlation_id: metadata.correlation_id ?? "f".repeat(32),
    ...(metadata.traceparent ? { traceparent: metadata.traceparent } : {}),
  };
}

export function encryptedCallOutcome(
  callId: string, from: string, to: string, terminal: "completed" | "failed" = "completed", org = "acme",
) {
  return {
    type: "call_outcome" as const, call_id: callId, terminal,
    envelope: envelope("response", from, to, org),
  };
}

export function fixedRateLimit(limit: number): RateLimit {
  let used = 0;
  return {
    limit: async () => ({ success: ++used <= limit }),
  } as unknown as RateLimit;
}

export async function openWs(path: string, headers: Record<string, string>): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test${path}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

export function nextFrame(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("nextFrame timeout")), timeoutMs);
    ws.addEventListener("message", (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); }, { once: true });
  });
}

export function closed(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (e) => { clearTimeout(t); resolve({ code: e.code }); }, { once: true });
  });
}
