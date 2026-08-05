import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth.js";
import { drainRecoveryEvictions } from "../src/recovery.js";
import { identityObjectName } from "../src/tenant.js";
import { closed, issueInvite, openWs, registerHandle, wsAuth } from "./helpers.js";

const proof = (seed: string) => `${seed}-${"x".repeat(40)}`;
const publicId = (kind: "act" | "agr", digest: string) => `${kind}_${digest.slice(0, 16)}`;

async function issueAt(handle: string, token: string, value: string, expected: number, org = "acme") {
  const digest = await sha256Hex(value);
  return SELF.fetch("https://relay.test/v1/recovery/issue", {
    method: "POST",
    headers: { ...wsAuth(handle, token, org), "content-type": "application/json" },
    body: JSON.stringify({
      expected_generation: expected,
      successor_recovery_digest: digest,
      successor_recovery_public_id: publicId("agr", digest),
    }),
  });
}

async function issue(handle: string, token: string, value: string, org = "acme") {
  const status = await SELF.fetch("https://relay.test/v1/recovery/status", { headers: wsAuth(handle, token, org) });
  const { generation } = await status.json<{ generation: number }>();
  return issueAt(handle, token, value, generation, org);
}

async function redeem(input: {
  org?: string; handle: string; generation: number; current: string; operation?: string;
  token: string; successor: string;
}) {
  const tokenDigest = await sha256Hex(input.token);
  const successorDigest = await sha256Hex(input.successor);
  return SELF.fetch("https://relay.test/v1/recovery/redeem", {
    method: "POST", headers: {
      "content-type": "application/json", "cf-connecting-ip": `recovery-${input.org ?? "acme"}-${input.handle}`,
    },
    body: JSON.stringify({
      org: input.org ?? "acme", handle: input.handle, generation: input.generation,
      current_recovery_proof: input.current, operation_id: input.operation ?? "A".repeat(22),
      client_token_digest: tokenDigest, client_public_id: publicId("act", tokenDigest),
      successor_recovery_digest: successorDigest,
      successor_recovery_public_id: publicId("agr", successorDigest),
    }),
  });
}

describe("recovery v2", () => {
  it("issues generation-versioned proofs and invalidates reissued predecessors", async () => {
    const token = await registerHandle("reissue");
    expect(await (await SELF.fetch("https://relay.test/v1/recovery/status", {
      headers: wsAuth("reissue", token),
    })).json()).toEqual({ issued: false, generation: 0 });
    expect(await (await issue("reissue", token, proof("first"))).json()).toMatchObject({ generation: 1 });
    expect(await (await SELF.fetch("https://relay.test/v1/recovery/status", {
      headers: wsAuth("reissue", token),
    })).json()).toMatchObject({ issued: true, generation: 1 });
    expect(await (await issue("reissue", token, proof("second"))).json()).toMatchObject({ generation: 2 });
    expect((await redeem({ handle: "reissue", generation: 1, current: proof("first"), token: proof("token"), successor: proof("third") })).status).toBe(401);
    expect(await env.DB.prepare(
      "SELECT 1 FROM recovery_evictions WHERE org = ? AND handle = ?",
    ).bind("acme", "reissue").first()).toBeNull();
  });

  it("atomically replaces the token and proof and replays only an exact receipt", async () => {
    const oldToken = await registerHandle("recover");
    const current = proof("current");
    expect((await issue("recover", oldToken, current)).status).toBe(200);
    const nextToken = proof("candidate");
    const successor = proof("successor");
    const first = await redeem({ handle: "recover", generation: 1, current, token: nextToken, successor });
    expect(first.status).toBe(200);
    const receipt = await first.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({ consumed_generation: 1, recovery_generation: 2, operation_id: "A".repeat(22) });
    expect((await issue("recover", oldToken, proof("nope"))).status).toBe(401);
    expect((await issue("recover", nextToken, proof("fourth"))).status).toBe(200);

    const events = await env.DB.prepare(
      "SELECT event, actor_type FROM org_events WHERE org = ? AND target_id = ? ORDER BY id",
    ).bind("acme", "recover").all<{ event: string; actor_type: string }>();
    expect(events.results).toEqual([
      { event: "org.invite.redeem", actor_type: "invite" },
      { event: "credential.recovery.issue", actor_type: "handle" },
      { event: "credential.recovery.redeem", actor_type: "recovery" },
      { event: "credential.recovery.issue", actor_type: "handle" },
    ]);

    const replay = await redeem({ handle: "recover", generation: 1, current, token: nextToken, successor });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject(receipt);
    expect((await redeem({ handle: "recover", generation: 1, current, operation: "B".repeat(22), token: nextToken, successor })).status).toBe(401);
    expect((await redeem({ handle: "recover", generation: 1, current, token: proof("changed"), successor })).status).toBe(401);
  });

  it("isolates the same handle across organizations", async () => {
    const acmeToken = await registerHandle("same-rec", "claude", "acme");
    await registerHandle("same-rec", "claude", "beta");
    const current = proof("tenant");
    await issue("same-rec", acmeToken, current, "acme");
    expect((await redeem({ org: "beta", handle: "same-rec", generation: 1, current, token: proof("new"), successor: proof("next") })).status).toBe(401);
  });

  it("evicts sockets after commit", async () => {
    const oldToken = await registerHandle("evict-rec");
    const current = proof("evict-current");
    await issue("evict-rec", oldToken, current);
    const ws = await openWs("/v1/ws?role=listen", wsAuth("evict-rec", oldToken));
    const closing = closed(ws);
    const nextToken = proof("evict-token");
    const successor = proof("evict-next");
    const input = { handle: "evict-rec", generation: 1, current, token: nextToken, successor };
    const res = await redeem(input);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ eviction_confirmed: true });
    expect((await closing).code).toBe(4001);
    expect(await env.DB.prepare(
      "SELECT 1 FROM recovery_evictions WHERE org = ? AND handle = ?",
    ).bind("acme", "evict-rec").first()).toBeNull();

    // Exact receipt replay and a delayed old-generation job must not evict a
    // socket authenticated after recovery committed.
    const currentWs = await openWs("/v1/ws?role=listen", wsAuth("evict-rec", nextToken));
    expect((await redeem(input)).status).toBe(200);
    await env.DB.prepare(
      "INSERT INTO recovery_evictions (org, handle, recovery_generation, next_attempt) VALUES (?, ?, ?, ?)",
    ).bind("acme", "evict-rec", 2, 0).run();
    await drainRecoveryEvictions(env);
    expect(await (await SELF.fetch("https://relay.test/v1/status/evict-rec", {
      headers: wsAuth("evict-rec", nextToken),
    })).json()).toEqual({ online: true });
    currentWs.close();
  });

  it("rejects a stale authenticated handshake that arrives after eviction", async () => {
    const handle = "stale-handshake";
    const oldToken = await registerHandle(handle);
    const callerToken = await registerHandle("post-recovery-caller");
    const current = proof("stale-current");
    await issue(handle, oldToken, current);
    const nextToken = proof("stale-token");
    expect((await redeem({
      handle, generation: 1, current, token: nextToken, successor: proof("stale-next"),
    })).status).toBe(200);

    const currentWs = await openWs("/v1/ws?role=listen", wsAuth(handle, nextToken));
    // #154 slice 4: both the object name and the credential floor are keyed
    // by the stable identity now, so this has to address the same identity
    // the relay would rather than reconstructing a name from the handle.
    const agentId = (await env.DB.prepare(
      "SELECT agent_id FROM handles WHERE org = ? AND handle = ?",
    ).bind("acme", handle).first<{ agent_id: string }>())!.agent_id;
    const stub = env.HANDLE_DO.get(
      env.HANDLE_DO.idFromName(identityObjectName({ org: "acme", agentId })),
    );
    const stale = await stub.fetch("https://do/ws?role=listen", {
      headers: {
        Upgrade: "websocket",
        "X-Verified-From": handle,
        "X-Verified-Agent-Id": agentId,
        "X-Verified-Org": "acme",
        "X-Verified-Target": handle,
        "X-Verified-Credential-Generation": "1",
      },
    });
    expect(stale.status).toBe(401);
    expect(await (await SELF.fetch(`https://relay.test/v1/status/${handle}`, {
      headers: wsAuth(handle, nextToken),
    })).json()).toEqual({ online: true });
    const callerWs = await openWs(
      `/v1/ws?role=call&to=${handle}`,
      wsAuth("post-recovery-caller", callerToken),
    );
    callerWs.close();
    currentWs.close();
  });

  it("leaves no partial receipt when the proof is wrong", async () => {
    const token = await registerHandle("atomic-rec");
    await issue("atomic-rec", token, proof("right"));
    const res = await redeem({ handle: "atomic-rec", generation: 1, current: proof("wrong"), token: proof("new"), successor: proof("next") });
    expect(res.status).toBe(401);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM recovery_receipts WHERE org = ? AND handle = ?")
      .bind("acme", "atomic-rec").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("elects one proof when two issue operations expect the same generation", async () => {
    const token = await registerHandle("issue-race");
    const [a, b] = await Promise.all([
      issueAt("issue-race", token, proof("issue-a"), 0),
      issueAt("issue-race", token, proof("issue-b"), 0),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await env.DB.prepare(
      "SELECT recovery_generation FROM handles WHERE org = ? AND handle = ?",
    ).bind("acme", "issue-race").first()).toEqual({ recovery_generation: 1 });
  });

  it("gives concurrent identical attempts the same committed receipt", async () => {
    const token = await registerHandle("race-rec");
    const current = proof("race-current");
    await issue("race-rec", token, current);
    const input = { handle: "race-rec", generation: 1, current, token: proof("race-token"), successor: proof("race-next") };
    const [a, b] = await Promise.all([redeem(input), redeem(input)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json<Record<string, unknown>>()).toMatchObject(await b.json<Record<string, unknown>>());
  });

  it("drains due durable eviction jobs idempotently", async () => {
    await registerHandle("alarm-rec");
    await env.DB.prepare(
      "INSERT INTO recovery_evictions (org, handle, recovery_generation, next_attempt) VALUES (?, ?, ?, ?)",
    ).bind("acme", "alarm-rec", 1, 0).run();
    await drainRecoveryEvictions(env);
    expect(await env.DB.prepare(
      "SELECT 1 FROM recovery_evictions WHERE org = ? AND handle = ?",
    ).bind("acme", "alarm-rec").first()).toBeNull();
  });

  it("reports the registered agent_kind in the redeem receipt, null for a caller-only handle (regression #346)", async () => {
    // #346: a recovering CLI with no local config.json to preserve agent_kind
    // from has only this receipt to learn it from. Before this fix the receipt
    // never carried it at all, so a callable line recovered from a genuine
    // config loss silently came back caller-only.
    const callableToken = await registerHandle("recover-callable", "claude");
    const callableCurrent = proof("callable-current");
    await issue("recover-callable", callableToken, callableCurrent);
    const callable = await redeem({
      handle: "recover-callable", generation: 1, current: callableCurrent,
      token: proof("callable-next"), successor: proof("callable-successor"),
    });
    expect(callable.status).toBe(200);
    expect(await callable.json()).toMatchObject({ agent_kind: "claude" });

    const invite = await issueInvite("acme", "recover-caller-only");
    const registerRes = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "test-recover-caller-only" },
      body: JSON.stringify({ invite, handle: "recover-caller-only" }),
    });
    expect(registerRes.status).toBe(200);
    const { token: callerOnlyToken } = await registerRes.json<{ token: string }>();
    const callerOnlyCurrent = proof("caller-only-current");
    await issue("recover-caller-only", callerOnlyToken, callerOnlyCurrent);
    const callerOnly = await redeem({
      handle: "recover-caller-only", generation: 1, current: callerOnlyCurrent,
      token: proof("caller-only-next"), successor: proof("caller-only-successor"),
    });
    expect(callerOnly.status).toBe(200);
    expect(await callerOnly.json()).toMatchObject({ agent_kind: null });
  });
});
