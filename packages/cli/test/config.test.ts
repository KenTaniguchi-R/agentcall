import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { loadConfig, saveConfig, relayUrl, assertCallableConfig, resolveWorkdir } from "../src/config.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-test-")); }

describe("paths", () => {
  it("derives everything from home", () => {
    const p = getPaths("/tmp/fakehome");
    expect(p.configFile).toBe("/tmp/fakehome/.agentcall/config.json");
    expect(p.publicDir).toBe("/tmp/fakehome/AgentCall/public");
  });
});

describe("config", () => {
  it("round-trips and sets 0600/0700 perms", () => {
    const p = getPaths(tempHome());
    const cfg = { handle: "ken", token: "t".repeat(43), agent_kind: "claude" as const, relay: "https://agentcall.benree.tech" };
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
    expect(statSync(p.configFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });
  it("throws a friendly error when config missing", () => {
    const p = getPaths(tempHome());
    expect(() => loadConfig(p)).toThrow(/agentcall setup/);
  });
  it("relayUrl: env > config > default", () => {
    const cfg = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example" };
    expect(relayUrl(cfg)).toBe("https://custom.example");
    expect(relayUrl(undefined)).toBe("https://agentcall.benree.tech");
    process.env.AGENTCALL_RELAY = "http://localhost:8787";
    try { expect(relayUrl(cfg)).toBe("http://localhost:8787"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
  it("relayUrl strips a trailing slash from env, config, and default", () => {
    const cfg = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example/" };
    expect(relayUrl(cfg)).toBe("https://custom.example");
    process.env.AGENTCALL_RELAY = "http://localhost:8787/";
    try { expect(relayUrl(cfg)).toBe("http://localhost:8787"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
  it("relayUrl treats an empty-string env var as unset", () => {
    const cfg = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example" };
    process.env.AGENTCALL_RELAY = "";
    try { expect(relayUrl(cfg)).toBe("https://custom.example"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
  it("round-trips a caller-only config (no agent_kind)", () => {
    const p = getPaths(tempHome());
    const cfg = { handle: "solo", token: "t".repeat(43), relay: "https://agentcall.benree.tech" };
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
    expect(loadConfig(p).agent_kind).toBeUndefined();
  });
  it("assertCallableConfig passes a full config and rejects caller-only", () => {
    const full = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };
    expect(() => assertCallableConfig(full)).not.toThrow();
    expect(() => assertCallableConfig({ handle: "k", token: "t", relay: "https://x.y" }))
      .toThrow(/caller-only.*agentcall setup/);
  });
});

// `workdir` is an opt-in override, never prompted for during setup: a
// developer points it at a real project so calls answer with real context,
// and everyone else silently keeps ~/AgentCall/public.
describe("resolveWorkdir", () => {
  const base = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };

  it("defaults to publicDir and reports it as confined", () => {
    const p = getPaths("/tmp/fakehome");
    expect(resolveWorkdir(base, p)).toEqual({ dir: p.publicDir, confined: true });
  });

  it("uses an explicit workdir and drops the confinement claim", () => {
    const home = tempHome();
    const p = getPaths(home);
    const project = join(home, "code", "payments-api");
    mkdirSync(project, { recursive: true });
    expect(resolveWorkdir({ ...base, workdir: project }, p)).toEqual({ dir: project, confined: false });
  });

  // Both of these would otherwise surface as a cryptic spawn ENOENT on every
  // inbound call, so they fail loudly at listener start instead.
  it("rejects a relative workdir", () => {
    const p = getPaths("/tmp/fakehome");
    expect(() => resolveWorkdir({ ...base, workdir: "code/api" }, p)).toThrow(/absolute/i);
  });

  it("rejects a workdir that does not exist", () => {
    const p = getPaths("/tmp/fakehome");
    expect(() => resolveWorkdir({ ...base, workdir: "/no/such/dir" }, p)).toThrow(/does not exist/i);
  });

  it("rejects a workdir that is a file rather than a directory", () => {
    const home = tempHome();
    const p = getPaths(home);
    saveConfig(p, base); // any real file will do
    expect(() => resolveWorkdir({ ...base, workdir: p.configFile }, p)).toThrow(/not a directory/i);
  });
});
