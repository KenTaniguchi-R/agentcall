import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import { LAUNCH_LABEL } from "../src/launchd.js";

function freshPaths() {
  const home = mkdtempSync(join(tmpdir(), "agentcall-doctor-"));
  return getPaths(home);
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
  verifyFns: okVerifyFns,
  callFn: async () => ({ type: "call_reply", call_id: "c1", text: "hi", task: "ask" }) as never,
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
});
