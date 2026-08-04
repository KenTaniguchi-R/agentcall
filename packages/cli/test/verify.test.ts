import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";
import { runGuard } from "../src/guard.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { AgentRunError, type AgentKind } from "../src/runner.js";
import { ASK_TASK } from "../src/tasks.js";
import {
  checkAgentBinary,
  checkCodexAuth,
  checkCodexGuard,
  checkGuard,
  checkRelaySelfCall,
  checkAgentSpawn,
  classifyAgentFailure,
  formatCheck,
  guardDenied,
  GUARD_PROBE_LINE,
  HINTS,
  runCodexGuardProbe,
  VERIFY_PROMPT,
  VERIFY_TIMEOUT_MS,
  verifyAgent,
} from "../src/verify.js";

const trustedCodexHookList = JSON.stringify({
  id: 2,
  result: {
    data: [{
      cwd: "/work",
      hooks: [{
        key: "/<session-flags>/config.toml:pre_tool_use:0:0",
        enabled: true,
        trustStatus: "trusted",
      }, {
        key: "/<session-flags>/config.toml:post_tool_use:0:0",
        enabled: true,
        trustStatus: "trusted",
      }],
      warnings: [],
      errors: [],
    }],
  },
});

describe("classifyAgentFailure", () => {
  it("maps claude auth errors to the /login hint", () => {
    // Real shape: claude -p exits 0 with is_error:true JSON; parseClaudeJson
    // throws and runner wraps it in "could not parse agent output".
    expect(
      classifyAgentFailure(
        "claude",
        new AgentRunError(
          "could not parse agent output: Error: claude reported an error: Invalid API key · Please run /login",
          "agent_error",
        ),
      ),
    ).toBe(HINTS.claudeAuth);
    expect(
      classifyAgentFailure(
        "claude",
        new AgentRunError(
          'agent exited 1: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
          "agent_error",
        ),
      ),
    ).toBe(HINTS.claudeAuth);
    // Real shape (claude 2.1.211): unauthenticated claude -p exits 1 with
    // empty stderr and the error in stdout's is_error JSON, which runner.ts
    // now falls back to for the AgentRunError message.
    expect(
      classifyAgentFailure(
        "claude",
        new AgentRunError(
          'agent exited 1: {"type":"result","is_error":true,"result":"Not logged in · Please run /login"}',
          "agent_error",
        ),
      ),
    ).toBe(HINTS.claudeAuth);
  });

  it("maps codex auth errors to the codex login hint", () => {
    expect(
      classifyAgentFailure("codex", new AgentRunError("agent exited 1: ERROR: 401 Unauthorized token_invalidated", "agent_error")),
    ).toBe(HINTS.codexAuth);
    expect(
      classifyAgentFailure("codex", new AgentRunError("agent exited 1: Not logged in. Run `codex login`.", "agent_error")),
    ).toBe(HINTS.codexAuth);
  });

  it("maps exit 127 / command not found to the PATH hint for either kind", () => {
    expect(
      classifyAgentFailure("claude", new AgentRunError("agent exited 127: sh: claude: command not found", "agent_error")),
    ).toBe(HINTS.pathMissing);
    expect(classifyAgentFailure("codex", new AgentRunError("agent exited 127: ", "agent_error"))).toBe(HINTS.pathMissing);
  });

  it("maps the timeout code to the timeout hint", () => {
    expect(classifyAgentFailure("claude", new AgentRunError("agent timed out after 120000ms", "timeout"))).toBe(HINTS.timeout);
  });

  it("returns undefined for unrecognized errors", () => {
    expect(classifyAgentFailure("claude", new Error("something odd"))).toBeUndefined();
  });
});

describe("formatCheck", () => {
  it("prints ✓ name — detail for passing checks", () => {
    expect(formatCheck({ name: "agent binary", ok: true, detail: "/opt/homebrew/bin/claude" })).toBe(
      "✓ agent binary — /opt/homebrew/bin/claude",
    );
  });

  it("prints ✗ and the fix hint on a second line for failing checks", () => {
    expect(formatCheck({ name: "agent run", ok: false, detail: "boom", hint: "do X" })).toBe(
      "✗ agent run — boom\n  fix: do X",
    );
  });

  // A warning is a check that could not be proven either way. It prints its
  // note like a failure so it is not mistaken for a pass, but `ok` stays true
  // so doctor's exit code doesn't turn red on something that isn't broken.
  it("prints ! and the note for warnings, which still count as ok", () => {
    expect(formatCheck({ name: "tool guard", ok: true, warn: true, detail: "unverified", hint: "re-run" })).toBe(
      "! tool guard — unverified\n  note: re-run",
    );
  });
});

describe("checkAgentBinary", () => {
  it("passes with the resolved path as detail", () => {
    const c = checkAgentBinary("claude", () => "/fake/bin/claude");
    expect(c).toMatchObject({ name: "agent binary", ok: true, detail: "/fake/bin/claude" });
  });

  it("fails with the resolver's message when the binary is missing", () => {
    const c = checkAgentBinary("codex", () => {
      throw new Error("Could not find `codex` on PATH.");
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Could not find");
  });
});

describe("checkCodexAuth", () => {
  it("passes when `codex login status` exits 0", () => {
    const calls: string[][] = [];
    const c = checkCodexAuth((cmd, args) => {
      calls.push([cmd, ...args]);
    });
    expect(c).toMatchObject({ name: "codex auth", ok: true });
    expect(calls).toEqual([["codex", "login", "status"]]);
  });

  it("fails with the codex login hint when it exits nonzero", () => {
    const c = checkCodexAuth(() => {
      throw new Error("Not logged in");
    });
    expect(c.ok).toBe(false);
    expect(c.hint).toBe(HINTS.codexAuth);
  });
});

const fakeWorkdir = getLinePaths(getMachinePaths("/tmp/agentcall-verify-test-home"), "line").shareDir;

// checkAgentSpawn now builds its own SpawnSpec (to apply the AGENTCALL_HOME
// override below), which moved a real binary-on-PATH lookup above the runFn
// injection seam — resolveAgentBin throws when the binary isn't on PATH. This
// fake stands in everywhere runFn is also faked, so these tests don't depend
// on claude/codex actually being installed on whatever machine runs them
// (this repo's CI runners among them — see CLAUDE.md's TDD section: no live
// claude/codex spawn in CI).
const fakeResolveBin = () => "/fake/bin/claude";

describe("checkAgentSpawn", () => {
  it("passes when runFn resolves, without asserting reply text", async () => {
    const c = await checkAgentSpawn("claude", fakeWorkdir, async () => ({ text: "OK, got it!" }), fakeResolveBin);
    expect(c).toMatchObject({ name: "agent run", ok: true });
  });

  it("invokes runFn with the verify prompt, timeout, and the read-only ask envelope", async () => {
    const seen: unknown[] = [];
    await checkAgentSpawn("claude", fakeWorkdir, async (kind, prompt, _p, timeoutMs, _specOverride, envelope) => {
      seen.push(kind, prompt, timeoutMs, envelope);
      return { text: "OK" };
    }, fakeResolveBin);
    expect(seen).toEqual(["claude", VERIFY_PROMPT, VERIFY_TIMEOUT_MS, ASK_TASK.envelope]);
  });

  it("classifies an auth failure into a hint", async () => {
    const c = await checkAgentSpawn("claude", fakeWorkdir, async () => {
      throw new AgentRunError("could not parse agent output: Error: claude reported an error: Invalid API key · Please run /login", "agent_error");
    }, fakeResolveBin);
    expect(c.ok).toBe(false);
    expect(c.hint).toBe(HINTS.claudeAuth);
    expect(c.detail).toContain("Invalid API key");
  });

  // Regression for the doctor-probe orphan-line bug: this spawn runs under
  // GUARD_PROBE_LINE ("doctor-probe"), a synthetic name with no real line
  // behind it — same as the two guard probes in this file, which each
  // mkdtemp their own AGENTCALL_HOME for exactly this reason (see
  // defaultGuardProbe/defaultGuardBinaryProbe below). checkAgentSpawn never
  // got that treatment because before per-line directories existed there was
  // nothing to orphan. Without it: buildSpawnSpec spreads the REAL
  // process.env with no AGENTCALL_HOME override, so if the probed agent
  // calls any tool, guard.ts's toolsLog write (enforce AND observe mode)
  // mkdirSync's a real ~/.agentcall/lines/doctor-probe/ with no config.json —
  // an orphan `listLines` reports forever after, which makes `doctor` fail
  // "config" and exit 1 on every future run, including future doctor runs
  // meant to diagnose it.
  //
  // A real agent spawn is not exercised here (no live claude/codex in CI —
  // see CLAUDE.md's TDD section), so this asserts the narrowest observable
  // proxy: the SpawnSpec actually handed to runFn carries a redirected
  // AGENTCALL_HOME, distinct from whatever the ambient process.env has (or
  // doesn't have). Before the fix, checkAgentSpawn passed no specOverride at
  // all (runFn's 5th argument was `undefined`), so this fails against the
  // current code — there is no spec to inspect.
  it("spawns under a throwaway AGENTCALL_HOME so a real ~/.agentcall/lines/doctor-probe is never created", async () => {
    const seenSpecs: Array<{ env?: NodeJS.ProcessEnv } | undefined> = [];
    await checkAgentSpawn("claude", fakeWorkdir, async (_kind, _prompt, _workdir, _timeoutMs, specOverride) => {
      seenSpecs.push(specOverride);
      return { text: "OK" };
    }, fakeResolveBin);
    expect(seenSpecs).toHaveLength(1);
    const spec = seenSpecs[0];
    expect(spec).toBeDefined();
    expect(spec!.env?.AGENTCALL_HOME).toBeTruthy();
    expect(spec!.env?.AGENTCALL_HOME).not.toBe(process.env.AGENTCALL_HOME);
    // The line name the spawn's guard is wired up under must still be
    // GUARD_PROBE_LINE, unaffected by the AGENTCALL_HOME redirection.
    expect(spec!.env?.AGENTCALL_LINE).toBe(GUARD_PROBE_LINE);
  });

  // Regression for the CI breakage the AGENTCALL_HOME fix above introduced:
  // building the SpawnSpec here (to apply that override) moved a real
  // binary-on-PATH lookup above the runFn injection seam. Without threading
  // a resolveBin parameter through, checkAgentSpawn always called the real
  // resolveAgentBin regardless of what a test injected, which throws when
  // the binary isn't on PATH — passing locally only because the dev machine
  // happens to have claude installed, and failing on any CI runner (no live
  // claude/codex spawn there — see CLAUDE.md's TDD section). This wouldn't
  // even compile against the pre-fix signature, which took no resolveBin
  // parameter at all.
  it("uses the injected resolveBin instead of the real PATH lookup", async () => {
    const seen: AgentKind[] = [];
    const resolveBin = (kind: AgentKind) => { seen.push(kind); return "/custom/bin/claude"; };
    const c = await checkAgentSpawn("claude", fakeWorkdir, async () => ({ text: "OK" }), resolveBin);
    expect(seen).toEqual(["claude"]);
    expect(c.ok).toBe(true);
  });
});

describe("checkCodexGuard", () => {
  it("passes only when hooks/list reports AgentCall's exact session hook enabled and trusted", async () => {
    const calls: Array<{ args: string[]; input: string; cwd: string }> = [];
    const check = await checkCodexGuard("/work", async (args, input, cwd) => {
      calls.push({ args, input, cwd });
      return trustedCodexHookList;
    });

    expect(check).toMatchObject({ name: "codex tool telemetry", ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("app-server");
    expect(calls[0]!.args.some((arg) => arg.startsWith("hooks.PreToolUse="))).toBe(true);
    expect(calls[0]!.args.some((arg) => arg.startsWith("hooks.PostToolUse="))).toBe(true);
    expect(calls[0]!.args.some((arg) => arg.startsWith("hooks.state="))).toBe(true);
    expect(calls[0]!.input).toContain('"method":"hooks/list"');
    expect(calls[0]!.input).toContain('"cwds":["/work"]');
    expect(calls[0]!.cwd).toBe("/work");
  });

  it("probes only the production PreToolUse configuration when telemetry is disabled", async () => {
    let seenArgs: string[] = [];
    const output = JSON.stringify({
      id: 2,
      result: { data: [{ cwd: "/work", hooks: [{
        key: "/<session-flags>/config.toml:pre_tool_use:0:0",
        enabled: true,
        trustStatus: "trusted",
      }] }] },
    });
    const check = await checkCodexGuard("/work", async (args) => {
      seenArgs = args;
      return output;
    }, false);

    expect(check).toMatchObject({ name: "codex session guard", ok: true });
    expect(seenArgs.some((arg) => arg.startsWith("hooks.PreToolUse="))).toBe(true);
    expect(seenArgs.some((arg) => arg.startsWith("hooks.PostToolUse="))).toBe(false);
    const trust = seenArgs.find((arg) => arg.startsWith("hooks.state="));
    expect(trust).toContain(":pre_tool_use:0:0");
    expect(trust).not.toContain(":post_tool_use:0:0");
  });

  it("fails when managed-only policy removes the session hook", async () => {
    const output = JSON.stringify({ id: 2, result: { data: [{ cwd: "/work", hooks: [] }] } });
    const check = await checkCodexGuard("/work", async () => output);
    expect(check).toMatchObject({ name: "codex tool telemetry", ok: false });
    expect(check.detail).toContain("session hook is absent");
    expect(check.hint).toContain("allow_managed_hooks_only");
  });

  it("fails when the trusted pre hook exists but paired post lifecycle discovery does not", async () => {
    const output = JSON.stringify({
      id: 2,
      result: { data: [{ cwd: "/work", hooks: [{
        key: "/<session-flags>/config.toml:pre_tool_use:0:0",
        enabled: true,
        trustStatus: "trusted",
      }] }] },
    });
    const check = await checkCodexGuard("/work", async () => output);
    expect(check).toMatchObject({ ok: false });
    expect(check.detail).toContain("tool lifecycle hook is absent");
  });

  it("does not accept a trusted hook result for a different working directory", async () => {
    const output = JSON.stringify({
      id: 2,
      result: { data: [{ cwd: "/other", hooks: [{
        key: "/<session-flags>/config.toml:pre_tool_use:0:0",
        enabled: true,
        trustStatus: "trusted",
      }] }] },
    });
    const check = await checkCodexGuard("/work", async () => output);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("session hook is absent");
  });

  it.each([
    [{ enabled: false, trustStatus: "trusted" }, "disabled"],
    [{ enabled: true, trustStatus: "modified" }, "modified"],
    [{ enabled: true, trustStatus: "untrusted" }, "untrusted"],
  ])("fails when the exact session hook is not executable: %j", async (state, detail) => {
    const output = JSON.stringify({
      id: 2,
      result: { data: [{ cwd: "/work", hooks: [{
        key: "/<session-flags>/config.toml:pre_tool_use:0:0", ...state,
      }] }] },
    });
    const check = await checkCodexGuard("/work", async () => output);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(detail);
  });

  it("fails closed on app-server errors and malformed responses", async () => {
    expect((await checkCodexGuard("/work", async () => "not json")).ok).toBe(false);
    expect(await checkCodexGuard("/work", async () => { throw new Error("app-server failed"); }))
      .toMatchObject({ ok: false, detail: "app-server failed" });
  });
});

describe("runCodexGuardProbe", () => {
  it("handles split JSON, kills the process group, and removes the isolated CODEX_HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-guard-transport-"));
    const helperMarker = join(root, "helper-survived");
    const helper = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(helperMarker)}, "x"), 300)`;
    const script = [
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: "ignore" })`,
      "const response = JSON.stringify({ id: 2, codexHome: process.env.CODEX_HOME })",
      "process.stdout.write(response.slice(0, 7))",
      "setTimeout(() => process.stdout.write(response.slice(7)), 10)",
      "setInterval(() => {}, 1000)",
    ].join(";");
    try {
      const output = await runCodexGuardProbe(
        process.execPath, ["-e", script], "request\n", root,
        { tempRoot: root, timeoutMs: 1_000, killGraceMs: 50 },
      );
      const response = JSON.parse(output) as { id: number; codexHome: string };
      expect(response.id).toBe(2);
      expect(response.codexHome.startsWith(root)).toBe(true);
      expect(existsSync(response.codexHome)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(existsSync(helperMarker), "a helper escaped the app-server process group").toBe(false);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out a non-responsive child and removes its isolated home", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-guard-timeout-"));
    try {
      await expect(runCodexGuardProbe(
        process.execPath, ["-e", "setInterval(() => {}, 1000)"], "request\n", root,
        { tempRoot: root, timeoutMs: 50, killGraceMs: 25 },
      )).rejects.toThrow("timed out");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds stdout, terminates the child, and removes its isolated home", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-guard-overflow-"));
    try {
      await expect(runCodexGuardProbe(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(2048)); setInterval(() => {}, 1000)'],
        "request\n", root,
        { tempRoot: root, maxOutputBytes: 1024, timeoutMs: 1_000, killGraceMs: 25 },
      )).rejects.toThrow("exceeded 1024 bytes");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on early close or spawn error and removes each isolated home", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-guard-errors-"));
    try {
      await expect(runCodexGuardProbe(
        process.execPath, ["-e", ""], "request\n", root,
        { tempRoot: root, timeoutMs: 1_000, killGraceMs: 25 },
      )).rejects.toThrow("before hooks/list responded");
      await expect(runCodexGuardProbe(
        "/definitely/missing-agentcall-codex", [], "request\n", root,
        { tempRoot: root, timeoutMs: 1_000, killGraceMs: 25 },
      )).rejects.toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verifyAgent", () => {
  it("runs binary -> spawn for claude and returns both checks", async () => {
    const checks = await verifyAgent("claude", fakeWorkdir, {
      resolveBin: () => "/fake/bin/claude",
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "agent run"]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("runs binary -> codex auth -> spawn for codex", async () => {
    const checks = await verifyAgent("codex", fakeWorkdir, {
      resolveBin: () => "/fake/bin/codex",
      execFn: () => {},
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "codex auth", "agent run"]);
  });

  it("stops the ladder at the first failure (no spawn after failed codex auth)", async () => {
    let spawned = false;
    const checks = await verifyAgent("codex", fakeWorkdir, {
      resolveBin: () => "/fake/bin/codex",
      execFn: () => {
        throw new Error("Not logged in");
      },
      runFn: async () => {
        spawned = true;
        return { text: "OK" };
      },
    });
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "codex auth"]);
    expect(checks[1].ok).toBe(false);
    expect(spawned).toBe(false);
  });

  it("stops after a failed binary check", async () => {
    const checks = await verifyAgent("claude", fakeWorkdir, {
      resolveBin: () => {
        throw new Error("Could not find `claude` on PATH.");
      },
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
  });
});

describe("checkRelaySelfCall", () => {
  const cfg = { org: "acme", handle: "ken", token: "tok", agent_kind: "claude" as const, relay: "https://relay.example" };
  const paths = getLinePaths(getMachinePaths(tmpdir(), tmpdir()), "claude");

  it("calls the agent's own address through the relay and passes on a reply", async () => {
    const seen: Array<{ org: string; from: string; to: string; relay: string; token: string; message: string; timeoutMs?: number }> = [];
    const c = await checkRelaySelfCall(cfg, paths, async (opts) => {
      seen.push({ org: opts.org, from: opts.from, to: opts.to, relay: opts.relay, token: opts.token, message: opts.message, timeoutMs: opts.timeoutMs });
      return { type: "call_reply", call_id: "c1", text: "hi", task: "ask" } as never;
    });
    expect(c).toMatchObject({ name: "relay self-call", ok: true });
    expect(seen).toEqual([
      {
        from: "ken", to: "ken", relay: "https://relay.example", org: "acme", token: "tok",
        message: "agentcall doctor self-test: reply briefly", timeoutMs: VERIFY_TIMEOUT_MS + 30_000,
      },
    ]);
  });

  it("fails with a launchd-environment hint when the call errors", async () => {
    const c = await checkRelaySelfCall(cfg, paths, async () => {
      throw new Error("The remote agent hit an error while answering.");
    });
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("listener");
  });
});

// A temp home whose calls.log already contains a denial, as a real guard run
// would have left behind. Per-line layout: checkGuard's default probes run
// under GUARD_PROBE_LINE (verify.ts), so deniedInLog reads
// .agentcall/lines/<GUARD_PROBE_LINE>/calls.log, not the flat legacy path.
function homeWithDenial(): string {
  const home = tempDir("guardcheck-");
  const callsLog = getLinePaths(getMachinePaths(home), GUARD_PROBE_LINE).callsLog;
  mkdirSync(dirname(callsLog), { recursive: true });
  writeFileSync(callsLog,
    JSON.stringify({ ts: "2026-07-31T00:00:00.000Z", type: "tool_denied", tool: "Read" }) + "\n");
  return home;
}

// The stdout a real denial produces, generated by runGuard itself rather than
// hand-written: guardDenied's whole job is to recognize that exact shape, and
// a literal here would keep passing after the shape changed.
function realDenialStdout(): string {
  const home = tempDir("guardout-");
  const line = getLinePaths(getMachinePaths(home, home), "probe-line");
  return runGuard(
    JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(home, ".env") }, cwd: home }),
    { line, callId: "probe", now: () => "2026-08-01T00:00:00.000Z", realpath: (p) => p, appendLine: () => {} },
  ).stdout;
}

describe("guardDenied", () => {
  it("recognizes the deny payload runGuard actually emits", () => {
    expect(guardDenied(realDenialStdout())).toBe(true);
  });

  it("does not read an allow (empty stdout) or garbage as a denial", () => {
    expect(guardDenied("")).toBe(false);
    expect(guardDenied("not json")).toBe(false);
    expect(guardDenied(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }))).toBe(false);
  });
});

describe("checkGuard", () => {
  // Deterministic stand-ins for the direct guard-entry.js invocation.
  const binaryWorks = async () => true;
  const binaryBroken = async () => false;

  it("passes when the read was refused AND a denial was recorded", async () => {
    const probe = async () => ({ output: "I could not read it.", home: homeWithDenial() });
    expect((await checkGuard(probe, binaryWorks)).ok).toBe(true);
  });

  it("fails when the canary comes back — the guard is not in force", async () => {
    const probe = async () => ({ output: "It contains AGENTCALL-GUARD-CANARY", home: homeWithDenial() });
    const c = await checkGuard(probe, binaryWorks);
    expect(c.ok).toBe(false);
    expect(c.hint).toBeTruthy();
  });

  // The failure sota hit: the model declined to call Read at all, so there was
  // nothing for the guard to deny. That is not evidence the guard is broken —
  // the direct probe settles it, and the row degrades to a warning.
  it("warns, not fails, when the model never called Read but the guard itself denies", async () => {
    const probe = async () => ({
      output: "I won't read .env — it holds secrets.",
      home: tempDir("empty-"),
    });
    const c = await checkGuard(probe, binaryWorks);
    expect(c.ok).toBe(true);
    expect(c.warn).toBe(true);
    expect(c.detail).toContain("declined");
    // The model's own words are what makes this diagnosable from the terminal.
    expect(c.detail).toContain("I won't read .env");
    expect(c.hint).not.toContain("pnpm build");
  });

  it("fails when the model never called Read AND the guard does not deny a direct probe", async () => {
    const probe = async () => ({ output: "Sure, what would you like to know?", home: tempDir("empty-") });
    const c = await checkGuard(probe, binaryBroken);
    expect(c.ok).toBe(false);
    expect(c.warn).toBeFalsy();
    expect(c.detail).toContain("invoked directly");
  });

  // A direct probe that cannot even run is a broken guard, not an unknown one.
  it("fails when the direct probe throws", async () => {
    const probe = async () => ({ output: "no comment", home: tempDir("empty-") });
    const c = await checkGuard(probe, async () => { throw new Error("ENOENT guard-entry.js"); });
    expect(c.ok).toBe(false);
  });

  it("fails when the probe throws", async () => {
    const probe = async () => { throw new Error("claude not found"); };
    expect((await checkGuard(probe, binaryWorks)).ok).toBe(false);
  });
});
