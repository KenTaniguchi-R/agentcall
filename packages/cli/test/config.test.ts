import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertCallable, loadInstallation, relayUrl, saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";


// The legacy round-trip and permission-bits coverage now lives in
// lines.test.ts's loadConfig/saveConfig tests, since Config was
// replaced by Config — this file keeps only what's still specific to
// config.ts: relayUrl and assertCallable.
//
// resolveLineWorkdir's tests went with the function in #372. Its behaviour is
// now sensitivity.ts's workdirFor, tested there — including the two properties
// worth keeping: a path that does not exist must not become a cwd, and neither
// must a relative one.

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

describe("installation config", () => {
  it("round-trips one config at the installation root", () => {
    const paths = getPaths(tempDir("agentcall-config-"));
    const config = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };
    saveConfig(paths, config);
    expect(loadInstallation(paths)).toEqual({ paths, config });
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
  });

  it("refuses to choose among legacy lines", () => {
    const paths = getPaths(tempDir("agentcall-legacy-"));
    mkdirSync(`${paths.dir}/lines/claude`, { recursive: true });
    writeFileSync(`${paths.dir}/lines/claude/config.json`, "{}");
    expect(() => loadInstallation(paths)).toThrow(/legacy multi-line.*migration/i);
  });

  it("passes a full config and rejects caller-only", () => {
    const full = { org: "acme", handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };
    expect(() => assertCallable(full)).not.toThrow();
    expect(() => assertCallable({ org: "acme", handle: "k", token: "t", relay: "https://x.y" }))
      .toThrow(/caller-only.*setup/);
  });
});
