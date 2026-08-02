import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup, warnIfOutsideLaunchdPath, type SetupOpts } from "../src/setup.js";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { listLines, saveLineConfig } from "../src/lines.js";
import { loadPerson, savePerson } from "../src/person.js";
import { addLine, type AddLineOpts } from "../src/commands/line.js";
import type { LineConfig } from "../src/config.js";
import { AgentRunError } from "../src/runner.js";

// addLine/removeLine (and so runSetup, which delegates to addLine) fall back
// to the real installLaunchAgent/uninstallLaunchAgent whenever a seam is
// omitted — and the real ones shell out to the actual `launchctl bootstrap`/
// `bootout` on whoever's machine runs this suite, regardless of how
// sandboxed MachinePaths.userHome is (only the plist *file* path is
// sandboxed; the launchd *session* is the real logged-in user's). This is
// the same guard line-cmd.test.ts carries, added there after this exact
// class of bug booted out the developer's real listener — every test below
// must pass its own skipLaunchd/installLaunchAgentFn, or fail loudly here
// instead of silently reaching the real thing.
vi.mock("../src/launchd.js", () => ({
  installLaunchAgent: () => {
    throw new Error("real installLaunchAgent reached in a test — pass skipLaunchd or installLaunchAgentFn");
  },
  uninstallLaunchAgent: () => {
    throw new Error("real uninstallLaunchAgent reached in a test — pass an uninstall seam");
  },
}));

// A local stand-in for the relay: registerHandle's real implementation
// spends the handle it registers permanently (handle release isn't
// implemented — see #16), so no test here may reach it, not even against a
// throwaway local HTTP server. Every runSetup call below goes through
// `addLine` with this `register` seam instead, which still exercises
// addLine's real validation/ordering/disk-writes/launchd wiring — just with
// no network underneath it.
const R = "https://r.example";
const stubRegister = async (_relay: string, handle: string) => ({ token: "tok-123", address: `${handle}@fake.example` });
const base: LineConfig = { handle: "ken", token: "t", relay: R, agent_kind: "claude" };

// The real addLine, wired to stubRegister instead of the network. Used as
// the `addLineFn` seam by every test below unless a test needs to observe
// one of addLine's own callbacks (publishCardFn, installLaunchAgentFn) —
// those pass their own wrapper built the same way.
const fakeAddLine = (m: MachinePaths, opts: AddLineOpts) =>
  addLine(m, { ...opts, register: stubRegister, publishCardFn: opts.publishCardFn ?? (async () => undefined) });

// addLine derives extraPathDirs (launchPathDirs, see launchPath.ts) eagerly
// as an argument expression, so it runs even when installLaunchAgentFn is a
// total no-op — and by default that derivation falls back to the real
// `which` via defaultResolveBin. run() below defaults resolveBin to this so
// no test in this file shells out by accident; "threads its resolveBin
// seam..." overrides it explicitly to prove an override still reaches
// addLine's derivation.
const noNetworkResolveBin = () => null;
function run(opts: SetupOpts): Promise<{ ready: boolean }> {
  return runSetup({ resolveBin: noNetworkResolveBin, ...opts });
}

let home: string;
let m: MachinePaths;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  m = getMachinePaths(home, home);
});
afterEach(() => {
  delete process.env.AGENTCALL_HOME;
});

describe("runSetup", () => {
  it("creates person.json plus one line, and marks it primary", async () => {
    await run({
      handle: "ken", agent: "claude", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true,
    });
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(listLines(m).map((l) => l.name)).toEqual(["claude"]);
    // mkdirSync(paths.shareDir) is addLine's (commands/line.ts), not tested
    // anywhere else — this is the callable half of what the old flat-config
    // "registers, writes config, creates public dir" test asserted.
    expect(existsSync(getLinePaths(m, "claude").shareDir)).toBe(true);
  });

  it("names the line after the agent kind", async () => {
    await run({
      handle: "ken", agent: "codex", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true,
    });
    expect(listLines(m).map((l) => l.name)).toEqual(["codex"]);
  });

  it("creates nothing on a second run and points at line add", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    const out: string[] = [];
    const res = await run({
      handle: "other", agent: "codex", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true, log: (s) => out.push(s),
    });
    expect(listLines(m).map((l) => l.name)).toEqual(["claude"]);
    expect(out.join("\n")).toMatch(/agentcall line add/);
    expect(res.ready).toBe(true);
  });

  it("creates an agentless line under --caller-only", async () => {
    await run({
      handle: "ken", callerOnly: true, relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true,
    });
    expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
    // The caller-only half of the old flat-config test: no agent means no
    // shareDir/tasksDir/policy — addLine's `if (agentKind)` block never runs.
    expect(existsSync(getLinePaths(m, "caller").shareDir)).toBe(false);
  });

  // Regression: re-running setup used to run agent detection (and its
  // "Which should agentcall use?" prompt) before the reuse check. That path
  // is gone entirely now — a second run short-circuits on `existing.length >
  // 0` before touching decideCallable/detectAgentKind at all.
  it("asks no questions on a second run", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    const asked: string[] = [];
    await run({
      relay: R, snippet: false, verify: false, skipLaunchd: true, addLineFn: fakeAddLine,
      hasBin: () => true, // both claude and codex on PATH — would normally prompt
      io: { ask: async (q) => { asked.push(q); return "claude"; } },
    });
    expect(asked).toEqual([]);
  });

  it("prompts for a missing handle via io.ask", async () => {
    const asked: string[] = [];
    await run({
      agent: "claude", relay: R, snippet: false, verify: false, skipLaunchd: true, addLineFn: fakeAddLine,
      io: { ask: async (q) => { asked.push(q); return "asked-handle"; } },
    });
    expect(listLines(m)[0]!.config!.handle).toBe("asked-handle");
    expect(asked.length).toBeGreaterThan(0);
  });

  it("detects the agent kind via injectable hasBin when --agent is omitted", async () => {
    await run({
      handle: "ken2", relay: R, snippet: false, verify: false, skipLaunchd: true, addLineFn: fakeAddLine,
      hasBin: (name) => name === "codex",
      io: { ask: async () => "y" },
    });
    expect(listLines(m)[0]!.name).toBe("codex");
    expect(listLines(m)[0]!.config!.agent_kind).toBe("codex");
  });

  it("falls back to caller-only with a notice when neither agent is found", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      let launchdCalled = false;
      await run({
        handle: "ken3", relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
        hasBin: () => false,
        installLaunchAgentFn: () => { launchdCalled = true; },
      });
      expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
      expect(launchdCalled).toBe(false);
      expect(logs.some((l) => l.includes("caller-only"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // The extraPathDirs derivation itself lives in launchPath.ts's
  // launchPathDirs, exercised directly in launchPath.test.ts and via
  // addLine in line-cmd.test.ts. This just proves setup threads its
  // resolveBin seam all the way down to that derivation rather than letting
  // addLine fall back to the real `which` — the fake resolveBin below would
  // never match a real machine's paths, so a non-empty, exact-match result
  // is only possible if the seam actually reached addLine.
  it("threads its resolveBin seam through to installLaunchAgent's extraPathDirs", async () => {
    let captured: string[] | undefined;
    await run({
      handle: "ken4", agent: "claude", relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
      resolveBin: (name) => (name === "claude" || name === "npx" ? `/Users/x/.local/bin/${name}` : null),
      installLaunchAgentFn: (_m, _execCmd, extraPathDirs) => { captured = extraPathDirs; },
    });
    expect(captured).toEqual(["/Users/x/.local/bin"]);
  });

  // policy.json/tasksDir/card-publish are addLine's own responsibility now
  // (see commands/line.ts), but nothing in line-cmd.test.ts currently
  // exercises them — kept here so the behavior stays covered somewhere.
  it("seeds policy.json + tasks dir and publishes the card", async () => {
    const cardCalls: LineConfig[] = [];
    await run({
      handle: "ken", agent: "claude", relay: R, snippet: false, verify: false, skipLaunchd: true,
      addLineFn: (m2, opts) =>
        addLine(m2, { ...opts, register: stubRegister, publishCardFn: async (cfg) => { cardCalls.push(cfg); } }),
    });
    const lp = getLinePaths(m, "claude");
    expect(existsSync(lp.tasksDir)).toBe(true);
    const policy = JSON.parse(readFileSync(lp.policyFile, "utf8"));
    expect(policy.default_offer).toEqual(["ask"]);
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0]).toMatchObject({ agent_kind: "claude", relay: R });
  });
});

describe("setup progress output", () => {
  it("prints a progress line before registering with the relay", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await run({
        handle: "ken9", agent: "claude", relay: R, snippet: false, verify: false, skipLaunchd: true,
        addLineFn: fakeAddLine,
      });
      expect(logs.some((l) => l.includes("Registering ken9"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("warnIfOutsideLaunchdPath", () => {
  it("prints one short line with a copy-pasteable symlink fix", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    try {
      warnIfOutsideLaunchdPath("claude", () => "/Users/x/.local/bin/claude");
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ln -s /Users/x/.local/bin/claude /opt/homebrew/bin/claude");
    expect(errors[0]!.length).toBeLessThan(200);
  });

  it("stays silent when the binary is inside launchd's search path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      warnIfOutsideLaunchdPath("claude", () => "/opt/homebrew/bin/claude");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("caller-only setup", () => {
  it("prints a caller-only summary with an upgrade hint instead of 'share your address'", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await run({
        handle: "solo2", callerOnly: true, relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
        hasBin: () => false,
      });
      const summary = logs.join("\n");
      expect(summary).toContain("caller-only");
      expect(summary).toContain("agentcall setup");
      expect(summary).not.toContain("Share your address");
    } finally {
      spy.mockRestore();
    }
  });

  it("asks 'Make your agent callable' and answering n yields caller-only", async () => {
    const asked: string[] = [];
    let launchdCalled = false;
    await run({
      handle: "asker", relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
      hasBin: () => true, // agents ARE installed; user still opts out
      io: { ask: async (q) => { asked.push(q); return "n"; } },
      installLaunchAgentFn: () => { launchdCalled = true; },
    });
    expect(asked.some((q) => q.includes("callable"))).toBe(true);
    expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
    expect(launchdCalled).toBe(false);
  });

  it("an empty answer defaults to callable", async () => {
    await run({
      handle: "defaulter", relay: R, snippet: false, verify: false, skipLaunchd: true, addLineFn: fakeAddLine,
      hasBin: (name) => name === "claude",
      io: { ask: async () => "" },
    });
    expect(listLines(m)[0]!.config!.agent_kind).toBe("claude");
  });
});

describe("runSetup verification", () => {
  it("passing verification: reports ready:true and prints the verified line", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    try {
      const result = await run({
        handle: "ken", agent: "claude", relay: R, snippet: false, skipLaunchd: true, addLineFn: fakeAddLine,
        verifyFns: { resolveBin: () => "/fake/bin/claude", runFn: async () => ({ text: "OK" }) },
      });
      expect(result.ready).toBe(true);
      expect(logs.join("\n")).toContain("agent verified");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("failing verification: still saves the line + installs launchd, but reports NOT ready", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      const installed: string[] = [];
      const result = await run({
        handle: "ken", agent: "claude", relay: R, snippet: false, addLineFn: fakeAddLine,
        installLaunchAgentFn: () => {
          installed.push("yes");
        },
        verifyFns: {
          resolveBin: () => "/fake/bin/claude",
          runFn: async () => {
            throw new AgentRunError(
              "could not parse agent output: Error: claude reported an error: Invalid API key · Please run /login",
              "agent_error",
            );
          },
        },
      });
      expect(result.ready).toBe(false);
      expect(listLines(m)[0]!.ok).toBe(true);
      expect(installed).toEqual(["yes"]);
      const out = errors.join("\n");
      expect(out).toContain("NOT ready");
      expect(out).toContain("/login");
      expect(out).toContain("agentcall doctor");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("--no-verify (verify:false) skips verification entirely", async () => {
    let ran = false;
    const result = await run({
      handle: "ken", agent: "claude", relay: R, snippet: false, skipLaunchd: true, verify: false,
      addLineFn: fakeAddLine,
      verifyFns: {
        resolveBin: () => "/fake/bin/claude",
        runFn: async () => {
          ran = true;
          return { text: "OK" };
        },
      },
    });
    expect(result.ready).toBe(true);
    expect(ran).toBe(false);
  });

  it("caller-only setup never verifies", async () => {
    let ran = false;
    const result = await run({
      handle: "solo", relay: R, snippet: false, skipLaunchd: true, callerOnly: true, addLineFn: fakeAddLine,
      verifyFns: {
        resolveBin: () => "/fake/bin/claude",
        runFn: async () => {
          ran = true;
          return { text: "OK" };
        },
      },
    });
    expect(result.ready).toBe(true);
    expect(ran).toBe(false);
  });
});
