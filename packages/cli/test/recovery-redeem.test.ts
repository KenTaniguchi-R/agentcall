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
      { paths, log: (l) => lines.push(l), redeemFn: fakeRedeem, writeRecovery: () => {} },
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

  it("preserves agent_kind and workdir on a same-handle redeem (normal re-key), and never touches the LaunchAgent", async () => {
    const paths = freshPaths();
    saveConfig(paths, {
      handle: "ken", token: "old-tok", agent_kind: "claude", workdir: "/some/dir", relay: "https://relay.example",
    });
    const lines: string[] = [];
    const printed: string[] = [];
    const result = await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "ken", relay: "https://relay.example" },
      {
        paths,
        log: (l) => lines.push(l),
        redeemFn: async () => ({ token: "new-tok", recovery_code: "agcr_NEW-NEW-NEW-NEW-NEW-NEW", address: "ken@relay.test" }),
        writeRecovery: (s) => printed.push(s),
      },
    );
    expect(result.ok).toBe(true);
    const cfg = loadConfig(paths);
    expect(cfg).toEqual({
      handle: "ken", token: "new-tok", agent_kind: "claude", workdir: "/some/dir", relay: "https://relay.example",
    });
    // No LaunchAgent restart attempt of any kind — just the same honest
    // "go restart it yourself" hint every user gets, agent_kind or not.
    expect(lines.join("\n")).toMatch(/Restart `agentcall listen`/);
    // And, the whole point of the fix: the new recovery code still reaches
    // the user even though this redeem had an agent_kind set.
    expect(printed.join("\n")).toContain("agcr_NEW-NEW-NEW-NEW-NEW-NEW");
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

  it("always reaches printRecoveryCode on a successful redeem — the config save and the token-burn on " +
    "the relay are both already irreversible by this point, so nothing after them may throw and swallow " +
    "the new code", async () => {
    const paths = freshPaths();
    // Same-handle redeem with agent_kind set: the exact shape that used to
    // route through the now-deleted LaunchAgent restart before reaching
    // printRecoveryCode.
    saveConfig(paths, { handle: "ken", token: "old-tok", agent_kind: "claude", relay: "https://relay.example" });
    const printed: string[] = [];
    const result = await runRecoveryRedeem(
      { code: "agcr_OLD", handle: "ken", relay: "https://relay.example" },
      {
        paths,
        redeemFn: async () => ({ token: "new-tok", recovery_code: "agcr_ORDER-CHECK", address: "ken@relay.test" }),
        writeRecovery: (s) => printed.push(s),
      },
    );
    expect(result.ok).toBe(true);
    expect(printed.join("\n")).toContain("agcr_ORDER-CHECK");
  });
});
