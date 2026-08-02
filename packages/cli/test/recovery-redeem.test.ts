import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRecoveryRedeem } from "../src/recoveryRedeem.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";

function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), "agentcall-redeem-"));
  return getPaths(home);
}

const fakeRedeem = async () => ({ token: "new-tok", recovery_code: "agcr_NEW-NEW-NEW-NEW-NEW-NEW", address: "alice@relay.test" });

describe("runRecoveryRedeem", () => {
  it("writes a fresh config when none exists yet (primary use case, must not regress)", async () => {
    const paths = freshPaths();
    const lines: string[] = [];
    const result = await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "alice", relay: "https://relay.example" },
      { paths, log: (l) => lines.push(l), redeemFn: fakeRedeem, isLaunchAgentInstalledFn: () => false, writeRecovery: () => {} },
    );
    expect(result.ok).toBe(true);
    const cfg = loadConfig(paths);
    expect(cfg).toEqual({ handle: "alice", token: "new-tok", relay: "https://relay.example" });
    expect(lines.join("\n")).toContain("Recovered alice@relay.test");
  });

  it("refuses to overwrite a config for a different handle without --force", async () => {
    const paths = freshPaths();
    saveConfig(paths, { handle: "ken", token: "ken-tok", agent_kind: "claude", relay: "https://relay.example" });
    const errors: string[] = [];
    let redeemed = false;
    const result = await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "alice", relay: "https://relay.example" },
      {
        paths,
        error: (l) => errors.push(l),
        redeemFn: async () => {
          redeemed = true;
          return fakeRedeem();
        },
      },
    );
    expect(result.ok).toBe(false);
    // Names both handles and explains what would be lost.
    expect(errors.join("\n")).toMatch(/ken/);
    expect(errors.join("\n")).toMatch(/alice/);
    expect(errors.join("\n")).toMatch(/--force/);
    // Never even called the relay, and the existing config is untouched.
    expect(redeemed).toBe(false);
    const cfg = loadConfig(paths);
    expect(cfg.handle).toBe("ken");
    expect(cfg.token).toBe("ken-tok");
    expect(cfg.agent_kind).toBe("claude");
  });

  it("overwrites a different handle's config when --force is passed, and says what is being replaced", async () => {
    const paths = freshPaths();
    saveConfig(paths, {
      handle: "ken", token: "ken-tok", agent_kind: "claude", workdir: "/some/dir", relay: "https://relay.example",
    });
    const lines: string[] = [];
    const result = await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "alice", relay: "https://relay.example", force: true },
      { paths, log: (l) => lines.push(l), redeemFn: fakeRedeem, writeRecovery: () => {} },
    );
    expect(result.ok).toBe(true);
    const cfg = loadConfig(paths);
    // A different identity taking over the machine drops to caller-only —
    // ken's agent_kind/workdir must not silently carry over to alice.
    expect(cfg).toEqual({ handle: "alice", token: "new-tok", relay: "https://relay.example" });
    expect(lines.join("\n")).toMatch(/replac/i);
    expect(lines.join("\n")).toMatch(/ken/);
  });

  it("preserves agent_kind and workdir on a same-handle redeem (normal re-key)", async () => {
    const paths = freshPaths();
    saveConfig(paths, {
      handle: "ken", token: "old-tok", agent_kind: "claude", workdir: "/some/dir", relay: "https://relay.example",
    });
    let restarted = false;
    const result = await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "ken", relay: "https://relay.example" },
      {
        paths,
        redeemFn: async () => ({ token: "new-tok", recovery_code: "agcr_NEW-NEW-NEW-NEW-NEW-NEW", address: "ken@relay.test" }),
        isLaunchAgentInstalledFn: () => true,
        installLaunchAgentFn: () => {
          restarted = true;
        },
        writeRecovery: () => {},
      },
    );
    expect(result.ok).toBe(true);
    const cfg = loadConfig(paths);
    expect(cfg).toEqual({
      handle: "ken", token: "new-tok", agent_kind: "claude", workdir: "/some/dir", relay: "https://relay.example",
    });
    expect(restarted).toBe(true);
  });

  it("softens the old-token message so it does not imply an already-connected caller is locked out", async () => {
    const paths = freshPaths();
    const lines: string[] = [];
    await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "alice", relay: "https://relay.example" },
      { paths, log: (l) => lines.push(l), redeemFn: fakeRedeem, writeRecovery: () => {} },
    );
    const out = lines.join("\n");
    expect(out).not.toMatch(/is now dead/i);
    expect(out).toMatch(/already-connected|open|existing session/i);
  });

  it("never persists the recovery code to disk", async () => {
    const paths = freshPaths();
    await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "alice", relay: "https://relay.example" },
      { paths, redeemFn: fakeRedeem, writeRecovery: () => {} },
    );
    expect(readFileSync(paths.configFile, "utf8")).not.toContain("agcr_");
  });
});
