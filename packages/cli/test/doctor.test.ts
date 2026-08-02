import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import { LAUNCH_LABEL } from "../src/launchd.js";

function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), "agentcall-doctor-"));
  return getPaths(home);
}

// A temp home whose calls.log already contains a denial, as a real guard run
// would have left behind. Shared with verify.test.ts's checkGuard tests.
function homeWithDenial(): string {
  const home = mkdtempSync(join(tmpdir(), "guardcheck-"));
  mkdirSync(join(home, ".agentcall"), { recursive: true });
  writeFileSync(join(home, ".agentcall", "calls.log"),
    JSON.stringify({ ts: "2026-07-31T00:00:00.000Z", type: "tool_denied", tool: "Read" }) + "\n");
  return home;
}

const okVerifyFns = {
  resolveBin: () => "/fake/bin/claude",
  runFn: async () => ({ text: "OK" }),
  execFn: () => {},
};

const baseDeps = {
  isDarwin: true,
  launchctlList: () => `12345\t0\t${LAUNCH_LABEL}\n`,
  getStatusFn: async () => ({ online: true }),
  // Boring default: issued and unredeemed is the case where doctor stays
  // silent, so it doesn't perturb any test that doesn't override this seam.
  // Without this, every test below hits the real getRecoveryState, which
  // does a live `fetch` to relay.example — see the "never touches the
  // network" regression test below, which fails loudly if this regresses.
  getRecoveryStateFn: async () => ({ issued: true, redeemed_at: null }),
  verifyFns: okVerifyFns,
  callFn: async () => ({ type: "call_reply", call_id: "c1", text: "hi", task: "ask" }) as never,
  // Never spawn a real `claude` in tests: checkGuard's default probe does
  // that on a real machine, and every test below with agent_kind "claude"
  // would otherwise fall through to it and hang/burn credentials in CI.
  guardFn: async () => ({ output: "blocked", home: homeWithDenial() }),
  // Same reasoning for the direct probe: its default spawns node against the
  // built dist/guard-entry.js, which does not exist when vitest runs from src.
  guardBinaryFn: async () => true,
};

describe("runDoctor", () => {
  it("exits 0 and runs every check including the relay self-call when all pass", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    const out = lines.join("\n");
    for (const name of ["config", "workdir", "background listener", "relay status", "agent binary", "agent run", "relay self-call"]) {
      expect(out).toContain(`✓ ${name}`);
    }
  });

  // A bad workdir stops startListener dead, so doctor has to name it rather
  // than leave the owner with a listener that won't stay up. It must still be
  // informational: the agent checks below it run either way.
  it("reports a broken workdir but still runs the agent checks", async () => {
    const p = freshPaths();
    saveConfig(p, {
      handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
      workdir: "/no/such/project",
    });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ workdir");
    expect(out).toContain("config.json");
    expect(out).toContain("✓ agent run");
  });

  it("reports a configured workdir by path when it is valid", async () => {
    const p = freshPaths();
    saveConfig(p, {
      handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
      workdir: p.home,
    });
    const lines: string[] = [];
    await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain(`✓ workdir — ${p.home}`);
  });

  it("exits 1 with a setup hint when there is no config", async () => {
    const p = freshPaths();
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("agentcall setup");
  });

  it("exits 0 and says caller-only when the config has no agent_kind", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "solo", token: "t", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("caller-only");
  });

  it("skips the relay self-call (but still runs agent checks) when the handle is offline", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    let selfCalled = false;
    const code = await runDoctor({
      ...baseDeps,
      paths: p,
      getStatusFn: async () => ({ online: false }),
      callFn: async () => {
        selfCalled = true;
        return { type: "call_reply", call_id: "c1", text: "hi", task: "ask" } as never;
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(selfCalled).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("✓ agent run");
    expect(out).toContain("skipping relay self-call");
  });

  it("skips spawn and self-call after a failed codex auth check", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    let spawned = false;
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      paths: p,
      verifyFns: {
        resolveBin: () => "/fake/bin/codex",
        execFn: () => {
          throw new Error("Not logged in");
        },
        runFn: async () => {
          spawned = true;
          return { text: "OK" };
        },
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(spawned).toBe(false);
    expect(lines.join("\n")).toContain("codex login");
  });

  it("reports the launchd listener as not loaded without blocking agent checks", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, launchctlList: () => "nothing here\n", log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ background listener");
    expect(out).toContain("✓ agent run");
  });

  // Guards against a regression that deletes the `if (cfg.agent_kind ===
  // "claude" && agentOk)` block in doctor.ts, or calls checkGuard
  // unconditionally — either would pass the rest of the suite silently,
  // which is exactly the kind of silent failure this check exists to catch.
  it("runs the tool guard check for a claude install and reports it passing", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ tool guard");
  });

  // An unprovable guard row must not turn a healthy install's doctor run red:
  // the model declining the probe's read is a fact about the model, and the
  // owner has nothing to fix.
  it("keeps exit 0 when the guard check can only warn", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      paths: p,
      guardFn: async () => ({ output: "I'd rather not read .env", home: mkdtempSync(join(tmpdir(), "empty-")) }),
      guardBinaryFn: async () => true,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("! tool guard");
  });

  it("does not run the tool guard check for a codex install", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      paths: p,
      verifyFns: {
        resolveBin: () => "/fake/bin/codex",
        execFn: () => {},
        runFn: async () => ({ text: "OK" }),
      },
      guardFn: async () => {
        throw new Error("checkGuard must not run for a codex install");
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("tool guard");
  });

  it("warns when no recovery code has ever been issued", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    await runDoctor({
      ...baseDeps,
      paths: p,
      log: (l) => lines.push(l),
      getRecoveryStateFn: async () => ({ issued: false, redeemed_at: null }),
    });
    const out = lines.join("\n");
    expect(out).toMatch(/recovery/i);
    expect(out).toMatch(/agentcall recovery issue/);
  });

  it("reports a redemption date when the code has been used", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    await runDoctor({
      ...baseDeps,
      paths: p,
      log: (l) => lines.push(l),
      getRecoveryStateFn: async () => ({ issued: true, redeemed_at: Date.UTC(2026, 6, 4) }),
    });
    const out = lines.join("\n");
    expect(out).toContain("2026-07-04");
    expect(out).toMatch(/wasn't you|was not you/i);
  });

  // A CLI built before this branch discarded the recovery_code from the
  // register response, so a handle can have `issued: true` on the relay
  // while its owner never actually saw a code. Staying quiet here used to
  // read as "you're covered" when doctor genuinely cannot tell — it only
  // knows a hash exists, not whether anyone kept the code it hashed.
  it("says it cannot confirm the code was kept when issued and unredeemed, but stays green", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      paths: p,
      log: (l) => lines.push(l),
      getRecoveryStateFn: async () => ({ issued: true, redeemed_at: null }),
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/! recovery code/);
    expect(out).toMatch(/cannot tell|can't tell|does not know|doesn't know/i);
    expect(out).toMatch(/agentcall recovery issue/);
  });

  // getRecoveryState is charged against the relay's recovery rate limit
  // (RECOVER_RL), the same budget `recovery issue`/`redeem` spend. A few
  // doctor runs inside a minute can 429 it, and swallowing that silently
  // used to make a throttled doctor look identical to a healthy one —
  // hiding exactly the warning the previous test covers.
  it("reports (rather than silently drops) a recovery-state check that fails, e.g. a 429", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      paths: p,
      log: (l) => lines.push(l),
      getRecoveryStateFn: async () => {
        throw new Error("Could not read recovery state (429)");
      },
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/! recovery code/);
    expect(out).toMatch(/could not|couldn't|unable/i);
  });

  // Regression guard: every relay-talking dep in baseDeps (getStatusFn,
  // getRecoveryStateFn, callFn, guardFn, guardBinaryFn) must be stubbed, so a
  // full run through baseDeps should never touch the real network. Spying on
  // fetch and asserting it was never called — rather than making it throw —
  // is what actually proves that: a thrown fetch would just be swallowed by
  // doctor.ts's own try/catch around the recovery-state call and the test
  // would pass anyway, proving nothing.
  it("never touches the network — every relay call in baseDeps is stubbed", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no network in unit tests");
    });
    try {
      const lines: string[] = [];
      const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
      expect(code).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
