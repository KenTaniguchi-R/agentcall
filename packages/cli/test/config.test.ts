import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { assertCallableLine, relayUrl, resolveLineWorkdir } from "../src/config.js";
import { saveLineConfig } from "../src/lines.js";
import { tempDir } from "./helpers.js";

function tempHome() { return tempDir("agentcall-test-"); }
function linePaths(home: string) { return getLinePaths(getMachinePaths(home, home), "line"); }

// The legacy round-trip and permission-bits coverage now lives in
// lines.test.ts's loadLineConfig/saveLineConfig tests, since Config was
// replaced by LineConfig — this file keeps only what's still specific to
// config.ts: relayUrl, resolveLineWorkdir, assertCallableLine.

describe("relayUrl", () => {
  it("env > config > default", () => {
    const cfg = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example" };
    expect(relayUrl(cfg)).toBe("https://custom.example");
    expect(relayUrl(undefined)).toBe("https://agent-call.app");
    process.env.AGENTCALL_RELAY = "http://localhost:8787";
    try { expect(relayUrl(cfg)).toBe("http://localhost:8787"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
  it("strips a trailing slash from env, config, and default", () => {
    const cfg = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example/" };
    expect(relayUrl(cfg)).toBe("https://custom.example");
    process.env.AGENTCALL_RELAY = "http://localhost:8787/";
    try { expect(relayUrl(cfg)).toBe("http://localhost:8787"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
  it("treats an empty-string env var as unset", () => {
    const cfg = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example" };
    process.env.AGENTCALL_RELAY = "";
    try { expect(relayUrl(cfg)).toBe("https://custom.example"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
});

describe("assertCallableLine", () => {
  it("passes a full config and rejects caller-only", () => {
    const full = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };
    expect(() => assertCallableLine(full)).not.toThrow();
    expect(() => assertCallableLine({ org: "acme", handle: "k", token: "t", relay: "https://x.y" }))
      .toThrow(/caller-only.*line add/);
  });
});

// `workdir` is an opt-in override, never prompted for during setup: a
// developer points it at a real project so calls answer with real context,
// and everyone else silently keeps ~/AgentCall/<line>/public.
describe("resolveLineWorkdir", () => {
  const base = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };

  it("defaults to shareDir and reports it as confined", () => {
    const p = linePaths("/tmp/fakehome");
    expect(resolveLineWorkdir(base, p)).toEqual({ dir: p.shareDir, confined: true });
  });

  it("uses an explicit workdir and drops the confinement claim", () => {
    const home = tempHome();
    const p = linePaths(home);
    const project = join(home, "code", "payments-api");
    mkdirSync(project, { recursive: true });
    expect(resolveLineWorkdir({ ...base, workdir: project }, p)).toEqual({ dir: project, confined: false });
  });

  // Both of these would otherwise surface as a cryptic spawn ENOENT on every
  // inbound call, so they fail loudly at listener start instead.
  it("rejects a relative workdir", () => {
    const p = linePaths("/tmp/fakehome");
    expect(() => resolveLineWorkdir({ ...base, workdir: "code/api" }, p)).toThrow(/absolute/i);
  });

  it("rejects a workdir that does not exist", () => {
    const p = linePaths("/tmp/fakehome");
    expect(() => resolveLineWorkdir({ ...base, workdir: "/no/such/dir" }, p)).toThrow(/does not exist/i);
  });

  it("rejects a workdir that is a file rather than a directory", () => {
    const home = tempHome();
    const p = linePaths(home);
    saveLineConfig(p, base); // any real file will do
    expect(() => resolveLineWorkdir({ ...base, workdir: p.configFile }, p)).toThrow(/not a directory/i);
  });
});
