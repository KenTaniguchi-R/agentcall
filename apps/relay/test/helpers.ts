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

export function wsAuth(handle: string, token: string, org = "acme"): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-AgentCall-Org": org, "X-AgentCall-Handle": handle };
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
