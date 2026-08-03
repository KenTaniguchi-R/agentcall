import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { fixedRateLimit, registerHandle, issueInvite, wsAuth, openWs, closed, nextFrame } from "./helpers.js";

describe("listener attach + status", () => {
  it("401s a listener with a bad token", async () => {
    await registerHandle("bob");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=listen", {
      headers: { Upgrade: "websocket", ...wsAuth("bob", "wrong-token") },
    });
    expect(res.status).toBe(401);
  });

  it("status flips online when a listener attaches", async () => {
    const token = await registerHandle("carol");
    let status = await SELF.fetch("https://relay.test/v1/status/carol", { headers: wsAuth("carol", token) });
    expect((await status.json<{ online: boolean }>()).online).toBe(false);

    await openWs("/v1/ws?role=listen", wsAuth("carol", token));
    status = await SELF.fetch("https://relay.test/v1/status/carol", { headers: wsAuth("carol", token) });
    expect((await status.json<{ online: boolean }>()).online).toBe(true);
  });

  it("404s status for unknown handle", async () => {
    const token = await registerHandle("nobody-asker");
    const res = await SELF.fetch("https://relay.test/v1/status/nobody", { headers: wsAuth("nobody-asker", token) });
    expect(res.status).toBe(404);
  });

  it("replaces an existing listener (old socket closed with 4000)", async () => {
    const token = await registerHandle("dave");
    const first = await openWs("/v1/ws?role=listen", wsAuth("dave", token));
    const firstClosed = closed(first);
    await openWs("/v1/ws?role=listen", wsAuth("dave", token));
    expect((await firstClosed).code).toBe(4000);
  });

  it("404s a call to an unregistered target", async () => {
    const token = await registerHandle("erin");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=call&to=ghost", {
      headers: { Upgrade: "websocket", ...wsAuth("erin", token) },
    });
    expect(res.status).toBe(404);
  });

  it("426s a websocket request without the Upgrade header", async () => {
    const token = await registerHandle("frank");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=listen", { headers: wsAuth("frank", token) });
    expect(res.status).toBe(426);
  });

  it("400s a bogus role", async () => {
    const token = await registerHandle("gina");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=bogus", {
      headers: { Upgrade: "websocket", ...wsAuth("gina", token) },
    });
    expect(res.status).toBe(400);
  });

  it("a caller-only handle can authenticate and place a call", async () => {
    // Callee: a normal, callable registration with a listener attached.
    const hostToken = await registerHandle("host1");
    const listener = await openWs("/v1/ws?role=listen", wsAuth("host1", hostToken));
    const incoming = nextFrame(listener);

    // Caller: registered with no agent_kind at all.
    const res = await SELF.fetch("https://relay.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: await issueInvite("acme", "solo2"), handle: "solo2" }),
    });
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();

    const caller = await openWs("/v1/ws?role=call&to=host1", wsAuth("solo2", token));
    caller.send(JSON.stringify({ type: "call_request", to: "host1", message: "hi" }));
    const frame = await incoming;
    expect(frame.type).toBe("incoming_call");
    expect(frame.from).toBe("solo2");
  });

  it("attests only rosters shared by caller and callee and ignores caller-asserted groups", async () => {
    const targetToken = await registerHandle("group-target");
    const callerToken = await registerHandle("group-caller");
    const listener = await openWs("/v1/ws?role=listen", wsAuth("group-target", targetToken));
    const shared = "s".repeat(22);
    const callerOnly = "c".repeat(22);
    const roster = env.DB.prepare(
      "INSERT INTO rosters (id, org, admin_secret_hash, created_at) VALUES (?, 'acme', 'a', 1)",
    );
    const member = env.DB.prepare(
      "INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, 'acme', ?, 1)",
    );
    await env.DB.batch([
      roster.bind(shared), roster.bind(callerOnly),
      member.bind(shared, "group-target"), member.bind(shared, "group-caller"),
      member.bind(callerOnly, "group-caller"),
    ]);

    const incoming = nextFrame(listener);
    const caller = await openWs("/v1/ws?role=call&to=group-target", wsAuth("group-caller", callerToken));
    caller.send(JSON.stringify({
      type: "call_request", to: "group-target", message: "hi", groups: [callerOnly, "attacker-chosen"],
    }));

    expect(await incoming).toMatchObject({
      type: "incoming_call", from: "group-caller", groups: [shared],
    });
  });

  it("keeps same-organization calls reachable when caller and callee share no roster", async () => {
    const targetToken = await registerHandle("open-target");
    const callerToken = await registerHandle("open-caller");
    const listener = await openWs("/v1/ws?role=listen", wsAuth("open-target", targetToken));
    const callerRoster = "q".repeat(22);
    const targetRoster = "u".repeat(22);
    const roster = env.DB.prepare(
      "INSERT INTO rosters (id, org, admin_secret_hash, created_at) VALUES (?, 'acme', 'a', 1)",
    );
    const member = env.DB.prepare(
      "INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, 'acme', ?, 1)",
    );
    await env.DB.batch([
      roster.bind(callerRoster), roster.bind(targetRoster),
      member.bind(callerRoster, "open-caller"), member.bind(targetRoster, "open-target"),
    ]);

    const incoming = nextFrame(listener);
    const caller = await openWs("/v1/ws?role=call&to=open-target", wsAuth("open-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "open-target", message: "hello" }));

    expect(await incoming).toMatchObject({
      type: "incoming_call", from: "open-caller", groups: [],
    });
  });

  it("does not route a caller to the same handle in another tenant", async () => {
    const betaToken = await registerHandle("tenant-target", "claude", "beta");
    await openWs("/v1/ws?role=listen", wsAuth("tenant-target", betaToken, "beta"));
    const callerToken = await registerHandle("tenant-caller", "claude", "acme");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=call&to=tenant-target", {
      headers: { Upgrade: "websocket", ...wsAuth("tenant-caller", callerToken, "acme") },
    });
    expect(res.status).toBe(404);
  });

  it("keeps Durable Object state separate for identical handles in two tenants", async () => {
    const acmeTarget = await registerHandle("same-person", "claude", "acme-do");
    const betaTarget = await registerHandle("same-person", "claude", "beta-do");
    const acmeListener = await openWs("/v1/ws?role=listen", wsAuth("same-person", acmeTarget, "acme-do"));
    await openWs("/v1/ws?role=listen", wsAuth("same-person", betaTarget, "beta-do"));

    const acmeCaller = await registerHandle("caller", "claude", "acme-do");
    const incoming = nextFrame(acmeListener);
    const caller = await openWs("/v1/ws?role=call&to=same-person", wsAuth("caller", acmeCaller, "acme-do"));
    caller.send(JSON.stringify({ type: "call_request", to: "same-person", message: "acme only" }));
    expect(await incoming).toMatchObject({ type: "incoming_call", from: "caller", message: "acme only" });
  });
  // /v1/status was anonymous and unthrottled, which made it a presence
  // oracle: 404-vs-200 enumerates registered handles (the namespace is
  // first-name shaped), and polling `online` gives anyone a live "is this
  // person at their desk" feed. Callers already need a token to place a call,
  // so requiring one to observe presence costs a legitimate caller nothing.
  it("401s an anonymous status probe", async () => {
    await registerHandle("s-target");
    expect((await SELF.fetch("https://relay.test/v1/status/s-target")).status).toBe(401);
  });

  it("401s a status probe bearing a bad token", async () => {
    await registerHandle("s-target2");
    const res = await SELF.fetch("https://relay.test/v1/status/s-target2", { headers: wsAuth("s-target2", "wrong") });
    expect(res.status).toBe(401);
  });

  it("makes an unrelated target byte-identical to an unknown handle", async () => {
    await registerHandle("s-target3");
    const viewer = await registerHandle("s-viewer");
    const known = await SELF.fetch("https://relay.test/v1/status/s-target3", {
      headers: wsAuth("s-viewer", viewer),
    });
    const unknown = await SELF.fetch("https://relay.test/v1/status/s-missing3", {
      headers: wsAuth("s-viewer", viewer),
    });
    expect(known.status).toBe(404);
    expect(known.status).toBe(unknown.status);
    expect([...known.headers]).toEqual([...unknown.headers]);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("serves a peer that shares a roster with the target", async () => {
    await registerHandle("s-target4");
    const viewer = await registerHandle("s-viewer4");
    const roster = "p".repeat(22);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rosters (id, org, admin_secret_hash, created_at) VALUES (?, 'acme', 'a', 1)",
      ).bind(roster),
      env.DB.prepare(
        "INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, 'acme', ?, 1)",
      ).bind(roster, "s-target4"),
      env.DB.prepare(
        "INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES (?, 'acme', ?, 1)",
      ).bind(roster, "s-viewer4"),
    ]);
    const res = await SELF.fetch("https://relay.test/v1/status/s-target4", {
      headers: wsAuth("s-viewer4", viewer),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ online: boolean }>()).online).toBe(false);
  });

  it("records only identity-unlinked allowed and denied status-read points", async () => {
    await registerHandle("s-log-target");
    const viewer = await registerHandle("s-log-viewer");
    const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
    const STATUS_READS = {
      writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) {
        points.push(point);
      },
    } as AnalyticsEngineDataset;
    const bindings = { ...env, STATUS_READS };
    const headers = {
      ...wsAuth("s-log-viewer", viewer),
      "cf-connecting-ip": "203.0.113.116",
    };

    await app.request("https://relay.test/v1/status/s-log-target", { headers }, bindings);
    await app.request("https://relay.test/v1/status/s-log-missing", { headers }, bindings);
    await app.request("https://relay.test/v1/status/s-log-viewer", { headers }, bindings);
    await app.request(`https://relay.test/v1/status/${"x".repeat(300)}`, { headers }, bindings);

    expect(points).toEqual([
      {
        indexes: ["denied"],
        doubles: [expect.any(Number)],
      },
      {
        indexes: ["denied"],
        doubles: [expect.any(Number)],
      },
      {
        indexes: ["allowed"],
        doubles: [expect.any(Number)],
      },
      {
        indexes: ["denied"],
        doubles: [expect.any(Number)],
      },
    ]);
  });

  it("durably counts locally observable analytics failures without blocking status reads", async () => {
    const viewer = await registerHandle("s-log-failure");
    const STATUS_READS = {
      writeDataPoint() {
        throw new Error("binding exposed sensitive internals");
      },
    } as AnalyticsEngineDataset;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bindings = { ...env, STATUS_READS };
      const headers = wsAuth("s-log-failure", viewer);
      const allowed = await app.request("https://relay.test/v1/status/s-log-failure", { headers }, bindings);
      const denied = await app.request("https://relay.test/v1/status/s-log-failure-other", { headers }, bindings);
      expect(allowed.status).toBe(200);
      expect(denied.status).toBe(404);
      expect(await env.DB.prepare(
        "SELECT failure_count, first_failure_at, last_failure_at FROM telemetry_health WHERE sink = ?",
      ).bind("agentcall_status_reads").first()).toMatchObject({
        failure_count: 2,
        first_failure_at: expect.any(Number),
        last_failure_at: expect.any(Number),
      });
      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenNthCalledWith(1, "status read analytics failure", {
        name: "Error", counter_recorded: true,
      });
      expect(log).toHaveBeenNthCalledWith(2, "status read analytics failure", {
        name: "Error", counter_recorded: true,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("keeps status available when both analytics and its durable health counter fail", async () => {
    const viewer = await registerHandle("s-log-double-failure");
    const STATUS_READS = {
      writeDataPoint() {
        throw new Error("analytics unavailable");
      },
    } as AnalyticsEngineDataset;
    const DB = new Proxy(env.DB, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property, target);
        return (query: string) => {
          if (query.startsWith("INSERT INTO telemetry_health")) throw new Error("health store unavailable");
          return target.prepare(query);
        };
      },
    }) as D1Database;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request("https://relay.test/v1/status/s-log-double-failure", {
        headers: wsAuth("s-log-double-failure", viewer),
      }, { ...env, DB, STATUS_READS });
      expect(res.status).toBe(200);
      expect(log).toHaveBeenCalledWith("status read analytics failure", {
        name: "Error", counter_recorded: false,
      });
    } finally {
      log.mockRestore();
    }
  });

  // Existence must not leak to an unauthenticated prober: a 404 here would
  // still answer "does this handle exist?" without any credential.
  it("401s rather than 404s when the probed handle does not exist", async () => {
    expect((await SELF.fetch("https://relay.test/v1/status/never-registered")).status).toBe(401);
  });

  // Probes an unregistered handle on purpose: the limiter runs before the
  // existence check, so this exercises it without waking a Durable Object 60
  // times over (which blows vitest-pool-workers isolated storage).
  it("throttles status reads from one source past the burst limit", async () => {
    const token = await registerHandle("rl-reader");
    const headers = { ...wsAuth("rl-reader", token), "cf-connecting-ip": "203.0.113.9" };
    const limiter = fixedRateLimit(60);
    for (let i = 0; i < 60; i++) {
      expect((await app.request("https://relay.test/v1/status/rl-absent", { headers }, { ...env, READ_RL: limiter })).status).toBe(404);
    }
    expect((await app.request("https://relay.test/v1/status/rl-absent", { headers }, { ...env, READ_RL: limiter })).status).toBe(429);
  });
});
