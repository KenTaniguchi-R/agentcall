import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";
import { runGuard } from "../src/guard.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { SensitivityMapSchema, withFloor } from "../src/sensitivity.js";
import { AgentRunError, type AgentKind } from "../src/runner.js";
import {
  checkAgentBinary,
  checkCodexAuth,
  checkGuard,
  checkRelaySelfCall,
  checkAgentSpawn,
  classifyAgentFailure,
  formatCheck,
  guardDenied,
  GUARD_PROBE_LINE,
  HINTS,
  VERIFY_PROMPT,
  VERIFY_TIMEOUT_MS,
  verifyAgent,
} from "../src/verify.js";

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

  it("invokes runFn with the verify prompt and timeout", async () => {
    const seen: unknown[] = [];
    await checkAgentSpawn("claude", fakeWorkdir, async ({ kind, prompt, timeoutMs }) => {
      seen.push(kind, prompt, timeoutMs);
      return { text: "OK" };
    }, fakeResolveBin);
    // No clearance any more (2026-08-07): the probe answers nobody, and with
    // one grantable level there was nothing for it to carry.
    expect(seen).toEqual(["claude", VERIFY_PROMPT, VERIFY_TIMEOUT_MS]);
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
    await checkAgentSpawn("claude", fakeWorkdir, async ({ specOverride }) => {
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

  // Issue #293: checkAgentSpawn mkdtemp's a throwaway AGENTCALL_HOME (above)
  // but never removed it on any path, leaking a directory on every real
  // `agentcall doctor`/`agentcall setup` run — not just a test artifact,
  // since this sits on the shared binary -> codex-auth -> agent-spawn ladder
  // behind both commands. Both the success and the throwing-runFn paths must
  // clean up: a `finally` is the only place that covers both.
  it("removes the throwaway AGENTCALL_HOME after a successful probe", async () => {
    let seenHome: string | undefined;
    const c = await checkAgentSpawn("claude", fakeWorkdir, async ({ specOverride }) => {
      seenHome = specOverride?.env?.AGENTCALL_HOME;
      return { text: "OK" };
    }, fakeResolveBin);
    expect(c.ok).toBe(true);
    expect(seenHome).toBeTruthy();
    expect(existsSync(seenHome!)).toBe(false);
  });

  it("removes the throwaway AGENTCALL_HOME even when runFn throws", async () => {
    let seenHome: string | undefined;
    const c = await checkAgentSpawn("claude", fakeWorkdir, async ({ specOverride }) => {
      seenHome = specOverride?.env?.AGENTCALL_HOME;
      throw new AgentRunError("boom", "agent_error");
    }, fakeResolveBin);
    expect(c.ok).toBe(false);
    expect(seenHome).toBeTruthy();
    expect(existsSync(seenHome!)).toBe(false);
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
    {
      line, callId: "probe", now: () => "2026-08-01T00:00:00.000Z", realpath: (p) => p, appendLine: () => {},
      // Empty map: every path is secret by omission, so the .env probe below
      // denies on sensitivity as well as on its basename. Either route emits
      // the same stdout shape, which is the only thing this helper cares about.
      map: withFloor(SensitivityMapSchema.parse({}), home),
    },
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
