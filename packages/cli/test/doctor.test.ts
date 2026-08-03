import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { saveLineConfig } from "../src/lines.js";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { GUARD_PROBE_LINE } from "../src/verify.js";
import { LAUNCH_LABEL } from "../src/launchd.js";
import type { AgentKind } from "../src/runner.js";
import { TelemetryHealthReporter } from "../src/telemetry-health.js";

// A single-line machine, still used by tests that only care about one line's
// checks. Multi-line behavior gets its own describe block below.
const LINE = "claude";

function freshMachine(): MachinePaths {
  const home = mkdtempSync(join(tmpdir(), "agentcall-doctor-"));
  const m = getMachinePaths(home, home);
  mkdirSync(m.linesDir, { recursive: true });
  return m;
}

// A temp home whose calls.log already contains a denial, as a real guard run
// would have left behind. Shared with verify.test.ts's checkGuard tests. Per
// the per-line layout, that's .agentcall/lines/<GUARD_PROBE_LINE>/calls.log —
// checkGuard's default probes run doctor's guard probe under that fixed line
// name (see verify.ts) — not the flat legacy .agentcall/calls.log.
function homeWithDenial(): string {
  const home = mkdtempSync(join(tmpdir(), "guardcheck-"));
  const callsLog = getLinePaths(getMachinePaths(home), GUARD_PROBE_LINE).callsLog;
  mkdirSync(dirname(callsLog), { recursive: true });
  writeFileSync(callsLog,
    JSON.stringify({ ts: "2026-07-31T00:00:00.000Z", type: "tool_denied", tool: "Read" }) + "\n");
  return home;
}

const okVerifyFns = {
  resolveBin: () => "/fake/bin/claude",
  runFn: async () => ({ text: "OK" }),
  execFn: () => {},
};

const fakeCall = async () => ({ type: "call_reply", call_id: "c1", text: "hi", task: "ask" }) as never;

const baseDeps = {
  isDarwin: true,
  launchctlList: () => `12345\t0\t${LAUNCH_LABEL}\n`,
  getStatusFn: async () => ({ online: true }),
  verifyFns: okVerifyFns,
  callFn: fakeCall,
  // Never spawn a real `claude` in tests: checkGuard's default probe does
  // that on a real machine, and every test below with agent_kind "claude"
  // would otherwise fall through to it and hang/burn credentials in CI.
  guardFn: async () => ({ output: "blocked", home: homeWithDenial() }),
  // Same reasoning for the direct probe: its default spawns node against the
  // built dist/guard-entry.js, which does not exist when vitest runs from src.
  guardBinaryFn: async () => true,
};

// A VerifyFns whose agent-binary resolution fails for exactly one kind, so a
// multi-line test can make one line's ladder fail without touching the
// others sharing the same (single, non-per-line) deps.verifyFns seam.
function failingVerifyFor(kind: AgentKind) {
  return {
    resolveBin: (k: AgentKind) => {
      if (k === kind) throw new Error(`no ${k} binary on PATH`);
      return `/fake/bin/${k}`;
    },
    runFn: async () => ({ text: "OK" }),
    execFn: () => {},
  };
}

describe("runDoctor", () => {
  it("surfaces persistent local telemetry degradation without failing doctor", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, "caller"), {
      org: "acme", handle: "solo", token: "t", relay: "https://relay.example",
    });
    const health = new TelemetryHealthReporter(m.telemetryHealthFile, () => {});
    health.recordFailure("trace_export");
    health.recordFailure("span_queue");
    health.flush();
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("! local telemetry export");
    expect(out).toContain("trace export failures 1");
    expect(out).toContain("span queue drops 1");
  });

  it("exits 0 and runs every check including the relay self-call when all pass", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
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
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), {
      org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
      workdir: "/no/such/project",
    });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ workdir");
    expect(out).toContain("config.json");
    expect(out).toContain("✓ agent run");
  });

  it("reports a configured workdir by path when it is valid", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), {
      org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
      workdir: m.userHome,
    });
    const lines: string[] = [];
    await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain(`✓ workdir — ${m.userHome}`);
  });

  it("exits 1 with a setup hint when there is no config", async () => {
    const m = freshMachine();
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("agentcall setup");
  });

  it("exits 0 and says caller-only when the config has no agent_kind", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, "caller"), { org: "acme", handle: "solo", token: "t", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("caller-only");
  });

  it("skips the relay self-call (but still runs agent checks) when the handle is offline", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    let selfCalled = false;
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
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
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    let spawned = false;
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
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
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, launchctlList: () => "nothing here\n", log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ background listener");
    expect(out).toContain("✓ agent run");
    // Diagnostic-only: distinguishes "plist never installed" from "installed
    // but not currently loaded" without itself turning the run red twice.
    expect(out).toContain("! launch agent plist");
  });

  // Guards against a regression that deletes the `if (cfg.agent_kind ===
  // "claude" && agentOk)` block in doctor.ts, or calls checkGuard
  // unconditionally — either would pass the rest of the suite silently,
  // which is exactly the kind of silent failure this check exists to catch.
  it("runs the tool guard check for a claude install and reports it passing", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ tool guard");
  });

  // An unprovable guard row must not turn a healthy install's doctor run red:
  // the model declining the probe's read is a fact about the model, and the
  // owner has nothing to fix.
  it("keeps exit 0 when the guard check can only warn", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      guardFn: async () => ({ output: "I'd rather not read .env", home: mkdtempSync(join(tmpdir(), "empty-")) }),
      guardBinaryFn: async () => true,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("! tool guard");
  });

  it("checks Codex tool telemetry without invoking Claude's enforcing guard probe", async () => {
    const m = freshMachine();
    const p = getLinePaths(m, LINE);
    saveLineConfig(p, { org: "acme", handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      verifyFns: {
        resolveBin: () => "/fake/bin/codex",
        execFn: () => {},
        runFn: async () => ({ text: "OK" }),
      },
      guardFn: async () => {
        throw new Error("checkGuard must not run for a codex install");
      },
      codexGuardFn: async () => JSON.stringify({
        id: 2,
        result: { data: [{ cwd: p.shareDir, hooks: [{
          key: "/<session-flags>/config.toml:pre_tool_use:0:0",
          enabled: true,
          trustStatus: "trusted",
        }] }] },
      }),
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ codex tool telemetry");
  });

  it("exits nonzero when Codex managed-only policy suppresses AgentCall's session hook", async () => {
    const m = freshMachine();
    const p = getLinePaths(m, LINE);
    saveLineConfig(p, { org: "acme", handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      verifyFns: {
        resolveBin: () => "/fake/bin/codex",
        execFn: () => {},
        runFn: async () => ({ text: "OK" }),
      },
      codexGuardFn: async () => JSON.stringify({
        id: 2, result: { data: [{ cwd: p.shareDir, hooks: [] }] },
      }),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗ codex tool telemetry");
    expect(lines.join("\n")).toContain("allow_managed_hooks_only");
  });

  // A relay string that is syntactically not a URL currently reaches the
  // network call and fails there — folding a config mistake into the same
  // bucket as "the listener isn't running." Caught before the network call
  // so the two are distinguishable in the output.
  it("reports a malformed relay string as its own failure, not folded into offline", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "not a url" });
    let statusCalled = false;
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      getStatusFn: async () => {
        statusCalled = true;
        return { online: true };
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(statusCalled).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("✗ relay config");
    expect(out).not.toContain("relay status — offline");
  });

  // relayUrl(cfg) prefers AGENTCALL_RELAY over cfg.relay, and the check above
  // validates THAT value with `new URL(relayUrl(cfg))` — so a broken env var
  // must be named in the detail, not the (perfectly valid) cfg.relay it
  // overrode. Naming the wrong string here would send the owner to edit a
  // config.json field that was never the problem.
  it("names the actually-validated relay (AGENTCALL_RELAY), not cfg.relay, when it's malformed", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    process.env.AGENTCALL_RELAY = "not a url";
    try {
      const lines: string[] = [];
      const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
      expect(code).toBe(1);
      const out = lines.join("\n");
      expect(out).toContain("not a url");
      expect(out).not.toContain("relay.example");
    } finally {
      delete process.env.AGENTCALL_RELAY;
    }
  });
});

describe("runDoctor across lines", () => {
  it("reports every line and exits non-zero if any callable line fails", async () => {
    const m = freshMachine();
    const base = { org: "acme", handle: "ken", token: "t", agent_kind: "claude" as const, relay: "https://relay.example" };
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx", agent_kind: "codex" as AgentKind });
    const out: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      log: (s) => out.push(s),
      verifyFns: failingVerifyFor("codex"),
    });
    const joined = out.join("\n");
    expect(joined).toContain("line claude");
    expect(joined).toContain("line codex");
    expect(code).toBe(1);
  });

  it("treats a caller-only line as fine, not as a failure, alongside a healthy callable line", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    saveLineConfig(getLinePaths(m, "caller"), { org: "acme", handle: "solo", token: "t", relay: "https://relay.example" });
    const out: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("caller-only");
  });

  it("reports an orphaned line as broken and exits non-zero", async () => {
    const m = freshMachine();
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    const out: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (s) => out.push(s) });
    expect(out.join("\n")).toMatch(/half/);
    expect(code).toBe(1);
  });

  it("probes the guard once per agent kind, not once per line", async () => {
    const m = freshMachine();
    const base = { org: "acme", handle: "ken-a", token: "t", agent_kind: "claude" as const, relay: "https://relay.example" };
    saveLineConfig(getLinePaths(m, "a"), base);
    saveLineConfig(getLinePaths(m, "b"), { ...base, handle: "ken-b" });
    let probes = 0;
    await runDoctor({
      ...baseDeps,
      machine: m,
      log: () => {},
      guardFn: async () => {
        probes++;
        return { output: "blocked", home: homeWithDenial() };
      },
    });
    expect(probes).toBe(1);
  });

  it("checks the single launch agent once, not per line", async () => {
    const m = freshMachine();
    const base = { org: "acme", handle: "ken-a", token: "t", agent_kind: "claude" as const, relay: "https://relay.example" };
    saveLineConfig(getLinePaths(m, "a"), base);
    saveLineConfig(getLinePaths(m, "b"), { ...base, handle: "ken-b" });
    let listed = 0;
    await runDoctor({
      ...baseDeps,
      machine: m,
      log: () => {},
      launchctlList: () => {
        listed++;
        return LAUNCH_LABEL;
      },
    });
    expect(listed).toBe(1);
  });
});
