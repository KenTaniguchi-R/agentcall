import { existsSync, mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import { runSetup, warnIfEphemeralServiceBin, type SetupOpts } from "../src/setup.js";
import { tempDir } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempDir("agentcall-setup-");
  process.env.AGENTCALL_HOME = home;
});
afterEach(() => { delete process.env.AGENTCALL_HOME; });

const base = (overrides: Partial<SetupOpts> = {}): SetupOpts => ({
  paths: getPaths(home, home),
  invite: "invite", handle: "ken", agent: "claude", verify: false, snippet: false,
  skipService: true, resolveBin: (name) => `/usr/local/bin/${name}`,
  registerFn: async () => ({ org: "acme", token: "token" }),
  publishKeysFn: async () => {}, publishCardFn: async () => {}, log: () => {},
  ...overrides,
});

describe("runSetup", () => {
  it("creates one root identity and authored content", async () => {
    await runSetup(base());
    const paths = getPaths(home, home);
    expect(loadConfig(paths)).toMatchObject({ org: "acme", handle: "ken", agent_kind: "claude" });
    expect(existsSync(paths.identityKeyFile)).toBe(true);
    expect(existsSync(paths.tasksDir)).toBe(true);
    expect(existsSync(paths.shareDir)).toBe(true);
    expect(paths.configFile).not.toContain("/lines/");
  });

  it("is idempotent and never registers a second identity", async () => {
    await runSetup(base());
    const registerFn = vi.fn(async () => ({ org: "acme", token: "other" }));
    await runSetup(base({ registerFn }));
    expect(registerFn).not.toHaveBeenCalled();
    expect(loadConfig(getPaths(home, home)).token).toBe("token");
  });

  it("refuses to repoint an existing identity even when AGENTCALL_RELAY is set", async () => {
    await runSetup(base());
    process.env.AGENTCALL_RELAY = "https://override.example";
    try {
      await expect(runSetup(base({ relay: "https://other.example" }))).rejects.toThrow(/cannot move/);
    } finally {
      delete process.env.AGENTCALL_RELAY;
    }
  });

  it("upgrades a caller-only installation in place", async () => {
    const paths = getPaths(home, home);
    saveConfig(paths, { org: "acme", handle: "ken", token: "token", relay: "https://r.example" });
    await runSetup(base({ invite: undefined }));
    expect(loadConfig(paths).agent_kind).toBe("claude");
  });

  it("refuses legacy multi-line state before spending an invite", async () => {
    const paths = getPaths(home, home);
    mkdirSync(`${paths.dir}/lines/claude`, { recursive: true });
    const registerFn = vi.fn(async () => ({ org: "acme", token: "token" }));
    await expect(runSetup(base({ registerFn }))).rejects.toThrow(/legacy multi-line.*migration/i);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it("requires an invite for a fresh noninteractive installation", async () => {
    await expect(runSetup(base({ invite: undefined, yes: true }))).rejects.toThrow(/invite/);
  });

  it("removes generated private keys when registration fails", async () => {
    await expect(runSetup(base({ registerFn: async () => { throw new Error("relay down"); } }))).rejects.toThrow(/relay down/);
    expect(existsSync(getPaths(home, home).identityKeyFile)).toBe(false);
  });
});

describe("warnIfEphemeralServiceBin", () => {
  it("warns only for ephemeral resolution", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    warnIfEphemeralServiceBin("claude", () => "/tmp/session/bin/claude");
    expect(error).toHaveBeenCalled();
    error.mockClear();
    warnIfEphemeralServiceBin("claude", () => "/usr/local/bin/claude");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
