# Setup Verification + `agentcall doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentcall setup` verifies the agent (claude or codex) can complete a sandboxed headless run — auth included — before claiming success, and a new `agentcall doctor` re-verifies any time, including an end-to-end relay self-call.

**Architecture:** One new module `packages/cli/src/verify.ts` holds all check logic as small injectable functions returning `VerifyCheck` rows. `runSetup` composes the binary→codex-auth→sandbox-spawn ladder; a new `packages/cli/src/doctor.ts` adds static checks and a relay self-call on top. No relay/protocol changes.

**Tech Stack:** TypeScript ESM, vitest, commander. Spec: `docs/superpowers/specs/2026-07-16-setup-verification-doctor-design.md`.

## Global Constraints

- No live `claude`/`codex` spawn in CI — every check takes an injectable fn (same seam pattern as `SetupOpts.installLaunchAgentFn`).
- TDD: write the failing test first for every behavior.
- Repo style: 2-space indent, double quotes, ESM imports ending in `.js`.
- Stage files explicitly (`git add <file> <file>`), never `git add -A`.
- All commands below run from `packages/cli/` unless stated otherwise.
- Done means `pnpm -r test && pnpm -r typecheck && pnpm -r build` pass at repo root.

---

### Task 1: `verify.ts` — `VerifyCheck` type, hint table, `classifyAgentFailure`

**Files:**
- Create: `packages/cli/src/verify.ts`
- Test: `packages/cli/test/verify.test.ts`

**Interfaces:**
- Consumes: `AgentRunError`, `AgentKind` from `src/runner.js`.
- Produces: `VerifyCheck { name, ok, detail?, hint? }`, `HINTS` (exported const object), `classifyAgentFailure(kind: AgentKind, error: unknown): string | undefined`, `formatCheck(c: VerifyCheck): string`. Later tasks add more exports to this same file.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/verify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentRunError } from "../src/runner.js";
import { classifyAgentFailure, formatCheck, HINTS } from "../src/verify.js";

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
    expect(formatCheck({ name: "sandboxed agent run", ok: false, detail: "boom", hint: "do X" })).toBe(
      "✗ sandboxed agent run — boom\n  fix: do X",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/verify.test.ts`
Expected: FAIL — `Cannot find module '../src/verify.js'` (or equivalent resolve error).

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/verify.ts`:

```ts
import { AgentRunError, type AgentKind } from "./runner.js";

// One row of verification output, shared by `setup` and `agentcall doctor`.
export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export const HINTS = {
  claudeAuth:
    "claude is not authenticated for headless runs — run `claude` interactively and complete /login " +
    "(or run `claude setup-token`, or set ANTHROPIC_API_KEY).",
  codexAuth: "codex is not authenticated — run `codex login` (on a headless machine: `codex login --device-auth`).",
  pathMissing:
    "the agent binary wasn't found inside the sandbox — see setup's PATH warning: " +
    "symlink the binary into /opt/homebrew/bin so the background listener can find it.",
  timeout: "the agent started but didn't finish in time — check srt.json's network allowlist, then try again.",
} as const;

// Maps a runAgent failure to an actionable fix. Auth failures reach us in
// kind-specific shapes: claude -p exits 0 with is_error:true JSON (runner
// wraps the parse throw), codex exits nonzero with the error on stderr —
// both end up as AgentRunError messages, so one string classifier covers
// both. Order matters: timeout and exit-127 are kind-independent and must
// win over the auth patterns (codex's `\b401\b` could otherwise match an
// unrelated exit-127 line that happens to contain 401).
export function classifyAgentFailure(kind: AgentKind, error: unknown): string | undefined {
  if (error instanceof AgentRunError && error.code === "timeout") return HINTS.timeout;
  const msg = String(error instanceof Error ? error.message : error);
  if (/exited 127|command not found/i.test(msg)) return HINTS.pathMissing;
  const authRe =
    kind === "claude"
      ? /invalid api key|please run \/login|authentication_error|oauth token has expired/i
      : /token_invalidated|not logged in|codex login|\b401\b/i;
  if (authRe.test(msg)) return kind === "claude" ? HINTS.claudeAuth : HINTS.codexAuth;
  return undefined;
}

export function formatCheck(c: VerifyCheck): string {
  const head = `${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
  return !c.ok && c.hint ? `${head}\n  fix: ${c.hint}` : head;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/verify.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/verify.ts packages/cli/test/verify.test.ts
git commit -m "feat(cli): verify module with agent-failure classifier"
```

---

### Task 2: `checkAgentBinary` + `checkCodexAuth`

**Files:**
- Modify: `packages/cli/src/verify.ts`
- Test: `packages/cli/test/verify.test.ts`

**Interfaces:**
- Consumes: `resolveAgentBin(kind)` from `src/srt.js` (throws when the binary is missing), `execFileSync` from `node:child_process`.
- Produces: `checkAgentBinary(kind, resolveBin?): VerifyCheck`, `ExecFn = (cmd: string, args: string[]) => void`, `checkCodexAuth(execFn?): VerifyCheck`.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/verify.test.ts` (add `checkAgentBinary, checkCodexAuth` to the `../src/verify.js` import):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/verify.test.ts`
Expected: FAIL — `checkAgentBinary is not a function` (or missing export).

- [ ] **Step 3: Write minimal implementation**

Add to `packages/cli/src/verify.ts` (new imports at top: `import { execFileSync } from "node:child_process";` and `import { resolveAgentBin } from "./srt.js";`):

```ts
// Truncated, single-line error text for a check's detail field.
const short = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

export function checkAgentBinary(kind: AgentKind, resolveBin: (kind: AgentKind) => string = resolveAgentBin): VerifyCheck {
  try {
    return { name: "agent binary", ok: true, detail: resolveBin(kind) };
  } catch (e) {
    return { name: "agent binary", ok: false, detail: short(e) };
  }
}

export type ExecFn = (cmd: string, args: string[]) => void;

const defaultExec: ExecFn = (cmd, args) => {
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

// codex-only fast path: `codex login status` is free (no model call) and
// exits nonzero when logged out, so codex users learn about missing auth
// without burning a spawn. claude has no equivalent — its auth failures are
// caught by checkSandboxSpawn.
export function checkCodexAuth(execFn: ExecFn = defaultExec): VerifyCheck {
  try {
    execFn("codex", ["login", "status"]);
    return { name: "codex auth", ok: true };
  } catch (e) {
    return { name: "codex auth", ok: false, detail: short(e), hint: HINTS.codexAuth };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/verify.ts packages/cli/test/verify.test.ts
git commit -m "feat(cli): binary and codex-auth verification checks"
```

---

### Task 3: `checkSandboxSpawn` + `verifyAgent` ladder

**Files:**
- Modify: `packages/cli/src/verify.ts`
- Test: `packages/cli/test/verify.test.ts`

**Interfaces:**
- Consumes: `runAgent(kind, prompt, paths, timeoutMs)` from `src/runner.js`, `Paths` from `src/paths.js`, Task 1–2 exports.
- Produces:
  - `VERIFY_PROMPT = "Reply with exactly: OK"`, `VERIFY_TIMEOUT_MS = 120_000`
  - `checkSandboxSpawn(kind, paths, runFn?): Promise<VerifyCheck>`
  - `VerifyFns { runFn?: typeof runAgent; execFn?: ExecFn; resolveBin?: (kind: AgentKind) => string }`
  - `verifyAgent(kind, paths, fns?): Promise<VerifyCheck[]>` — the binary → codex-auth → spawn ladder; stops at the first failure. Tasks 5–6 call exactly this.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/verify.test.ts` (extend the verify import with `checkSandboxSpawn, verifyAgent, VERIFY_PROMPT, VERIFY_TIMEOUT_MS`; add `import { getPaths } from "../src/paths.js";` at top):

```ts
const fakePaths = getPaths("/tmp/agentcall-verify-test-home");

describe("checkSandboxSpawn", () => {
  it("passes when runFn resolves, without asserting reply text", async () => {
    const c = await checkSandboxSpawn("claude", fakePaths, async () => ({ text: "OK, got it!" }));
    expect(c).toMatchObject({ name: "sandboxed agent run", ok: true });
  });

  it("invokes runFn with the verify prompt and timeout", async () => {
    const seen: unknown[] = [];
    await checkSandboxSpawn("claude", fakePaths, async (kind, prompt, _p, timeoutMs) => {
      seen.push(kind, prompt, timeoutMs);
      return { text: "OK" };
    });
    expect(seen).toEqual(["claude", VERIFY_PROMPT, VERIFY_TIMEOUT_MS]);
  });

  it("classifies an auth failure into a hint", async () => {
    const c = await checkSandboxSpawn("claude", fakePaths, async () => {
      throw new AgentRunError("could not parse agent output: Error: claude reported an error: Invalid API key · Please run /login", "agent_error");
    });
    expect(c.ok).toBe(false);
    expect(c.hint).toBe(HINTS.claudeAuth);
    expect(c.detail).toContain("Invalid API key");
  });
});

describe("verifyAgent", () => {
  it("runs binary -> spawn for claude and returns both checks", async () => {
    const checks = await verifyAgent("claude", fakePaths, {
      resolveBin: () => "/fake/bin/claude",
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "sandboxed agent run"]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("runs binary -> codex auth -> spawn for codex", async () => {
    const checks = await verifyAgent("codex", fakePaths, {
      resolveBin: () => "/fake/bin/codex",
      execFn: () => {},
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "codex auth", "sandboxed agent run"]);
  });

  it("stops the ladder at the first failure (no spawn after failed codex auth)", async () => {
    let spawned = false;
    const checks = await verifyAgent("codex", fakePaths, {
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
    const checks = await verifyAgent("claude", fakePaths, {
      resolveBin: () => {
        throw new Error("Could not find `claude` on PATH.");
      },
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/verify.test.ts`
Expected: FAIL — `checkSandboxSpawn is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/cli/src/verify.ts` (extend the runner import to `import { AgentRunError, runAgent, type AgentKind } from "./runner.js";`, add `import type { Paths } from "./paths.js";`):

```ts
export const VERIFY_PROMPT = "Reply with exactly: OK";
// Generous vs the observed ~10-25s of a healthy run, far below AGENT_TIMEOUT_MS:
// a verification hang should fail in 2 minutes, not 5.
export const VERIFY_TIMEOUT_MS = 120_000;

// The real thing: the byte-identical sandboxed spawn path an inbound call
// uses. A successfully parsed reply is the pass signal — the reply text is
// NOT asserted, since chatty models don't reliably echo "OK" verbatim.
export async function checkSandboxSpawn(
  kind: AgentKind, paths: Paths, runFn: typeof runAgent = runAgent,
): Promise<VerifyCheck> {
  try {
    await runFn(kind, VERIFY_PROMPT, paths, VERIFY_TIMEOUT_MS);
    return { name: "sandboxed agent run", ok: true };
  } catch (e) {
    return { name: "sandboxed agent run", ok: false, detail: short(e), hint: classifyAgentFailure(kind, e) };
  }
}

// Injection seams for tests and for setup/doctor callers; production leaves
// all three unset (same pattern as SetupOpts.installLaunchAgentFn).
export interface VerifyFns {
  runFn?: typeof runAgent;
  execFn?: ExecFn;
  resolveBin?: (kind: AgentKind) => string;
}

// The binary -> codex-auth -> sandbox-spawn ladder shared by setup and
// doctor. Stops at the first failure: a failed pre-check must not burn a
// model call, and the user should see the first broken layer, not a cascade.
export async function verifyAgent(kind: AgentKind, paths: Paths, fns: VerifyFns = {}): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [checkAgentBinary(kind, fns.resolveBin)];
  if (!checks[0].ok) return checks;
  if (kind === "codex") {
    const auth = checkCodexAuth(fns.execFn);
    checks.push(auth);
    if (!auth.ok) return checks;
  }
  checks.push(await checkSandboxSpawn(kind, paths, fns.runFn));
  return checks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/verify.ts packages/cli/test/verify.test.ts
git commit -m "feat(cli): sandboxed spawn check and verifyAgent ladder"
```

---

### Task 4: `checkRelaySelfCall`

**Files:**
- Modify: `packages/cli/src/verify.ts`
- Test: `packages/cli/test/verify.test.ts`

**Interfaces:**
- Consumes: `callAgent(opts: CallOpts): Promise<CallReplyType>` from `src/callClient.js`, `Config`/`relayUrl` from `src/config.js`.
- Produces: `checkRelaySelfCall(cfg: Config, callFn?: typeof callAgent): Promise<VerifyCheck>`. Used only by doctor (Task 6).

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/verify.test.ts` (extend the verify import with `checkRelaySelfCall`; add `import type { CallOpts } from "../src/callClient.js";` if needed for typing, or type the fake inline):

```ts
describe("checkRelaySelfCall", () => {
  const cfg = { handle: "ken", token: "tok", agent_kind: "claude" as const, relay: "https://relay.example" };

  it("calls the agent's own address through the relay and passes on a reply", async () => {
    const seen: Array<{ from: string; to: string; relay: string }> = [];
    const c = await checkRelaySelfCall(cfg, async (opts) => {
      seen.push({ from: opts.from, to: opts.to, relay: opts.relay });
      return { type: "call_reply", call_id: "c1", text: "hi", task: "ask" } as never;
    });
    expect(c).toMatchObject({ name: "relay self-call", ok: true });
    expect(seen).toEqual([{ from: "ken", to: "ken", relay: "https://relay.example" }]);
  });

  it("fails with a launchd-environment hint when the call errors", async () => {
    const c = await checkRelaySelfCall(cfg, async () => {
      throw new Error("The remote agent hit an error while answering.");
    });
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("listener");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/verify.test.ts`
Expected: FAIL — `checkRelaySelfCall is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/cli/src/verify.ts` (new imports: `import { callAgent } from "./callClient.js";` and `import { relayUrl, type Config } from "./config.js";`):

```ts
// Doctor-only, end-to-end: a real call to our own address through the relay
// and the launchd-spawned listener. This is the only check that exercises
// the listener's environment (fixed PATH, no shell rc, possibly locked
// keychain) — a direct checkSandboxSpawn from an interactive shell can pass
// while this fails. Works under the default policy because the built-in
// "ask" task always exists.
export async function checkRelaySelfCall(cfg: Config, callFn: typeof callAgent = callAgent): Promise<VerifyCheck> {
  try {
    await callFn({
      relay: relayUrl(cfg),
      from: cfg.handle,
      token: cfg.token,
      to: cfg.handle,
      message: "agentcall doctor self-test: reply briefly",
    });
    return { name: "relay self-call", ok: true };
  } catch (e) {
    return {
      name: "relay self-call",
      ok: false,
      detail: short(e),
      hint:
        "a direct sandboxed run works but the call through the background listener failed — its environment " +
        "differs from your shell (fixed PATH, no shell env, keychain); check ~/.agentcall/listener.log and calls.log.",
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/verify.ts packages/cli/test/verify.test.ts
git commit -m "feat(cli): relay self-call verification check"
```

---

### Task 5: setup integration + `--no-verify`

**Files:**
- Modify: `packages/cli/src/setup.ts`
- Modify: `packages/cli/src/index.ts` (setup command options + exit code)
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: `verifyAgent`, `formatCheck`, `VerifyFns`, `VerifyCheck` from `src/verify.js` (Task 3 signatures).
- Produces: `SetupOpts` gains `verify?: boolean` (false = skip; commander's `--no-verify` maps here) and `verifyFns?: VerifyFns`. `runSetup` return type changes `Promise<void>` → `Promise<{ ready: boolean }>` — `ready: false` when verification failed, or when setup refused the caller-only clobber. `index.ts` sets `process.exitCode = 1` when `ready` is false.
- Migration note: verification is ON by default, so every pre-existing `runSetup(...)` test call site would now attempt a real `resolveAgentBin`/spawn. Step 4 adds `verify: false,` to each pre-existing call site mechanically (they assert setup mechanics, not verification); only the new tests in Step 1 exercise `verifyFns`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/setup.test.ts` (add imports: `import { AgentRunError } from "../src/runner.js";`):

```ts
describe("runSetup verification", () => {
  it("passing verification: reports ready:true and prints the verified line", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    try {
      const relay = await fakeRelay();
      const result = await runSetup({
        handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true,
        verifyFns: { resolveBin: () => "/fake/bin/claude", runFn: async () => ({ text: "OK" }) },
      });
      expect(result.ready).toBe(true);
      expect(logs.join("\n")).toContain("agent verified");
    } finally {
      logSpy.mockRestore();
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("failing verification: still saves config + installs launchd, but reports NOT ready", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    try {
      const relay = await fakeRelay();
      const installed: string[] = [];
      const result = await runSetup({
        handle: "ken", agent: "claude", relay, snippet: false,
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
      const p = getPaths(home);
      expect(existsSync(p.configFile)).toBe(true);
      expect(installed).toEqual(["yes"]);
      const out = errors.join("\n");
      expect(out).toContain("NOT ready");
      expect(out).toContain("/login");
      expect(out).toContain("agentcall doctor");
    } finally {
      errSpy.mockRestore();
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("--no-verify (verify:false) skips verification entirely", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      let ran = false;
      const result = await runSetup({
        handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true, verify: false,
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
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("caller-only setup never verifies", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      let ran = false;
      const result = await runSetup({
        handle: "solo", relay, snippet: false, skipLaunchd: true, callerOnly: true,
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
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/setup.test.ts`
Expected: FAIL — `result.ready` is undefined (runSetup returns void) and no "agent verified" output.

- [ ] **Step 3: Implement**

In `packages/cli/src/setup.ts`:

a) Add to imports: `import { formatCheck, verifyAgent, type VerifyCheck, type VerifyFns } from "./verify.js";`

b) Extend `SetupOpts`:

```ts
export interface SetupOpts {
  handle?: string;
  agent?: "claude" | "codex";
  yes?: boolean;
  snippet?: boolean;
  relay?: string;
  skipLaunchd?: boolean;
  callerOnly?: boolean;
  // false skips post-setup agent verification (commander's --no-verify).
  verify?: boolean;
  io?: { ask(question: string): Promise<string> };
  // Test seams — production callers should leave these as the defaults.
  hasBin?: (name: string) => boolean;
  resolveBin?: (name: string) => string | null;
  installLaunchAgentFn?: typeof installLaunchAgent;
  verifyFns?: VerifyFns;
}
```

c) Change the signature to `export async function runSetup(opts: SetupOpts): Promise<{ ready: boolean }>` and make the caller-only-clobber refusal path `return { ready: false };` (it refuses to do what was asked, so scripts should see a nonzero exit).

d) At the end of the `if (cfg.agent_kind)` block (after the launchd install), run verification:

```ts
    let verifyFailure: VerifyCheck | undefined;
    if (opts.verify !== false) {
      console.log(`\nVerifying ${cfg.agent_kind} can answer a sandboxed test call (takes ~10-30s)...`);
      const checks = await verifyAgent(cfg.agent_kind, paths, opts.verifyFns);
      for (const c of checks) console.log(formatCheck(c));
      verifyFailure = checks.find((c) => !c.ok);
    }
```

(Declare `let verifyFailure: VerifyCheck | undefined;` before the `if (cfg.agent_kind)` block so the closing-message code can see it.)

e) Replace the closing callable-success message with a three-way branch:

```ts
  if (cfg.agent_kind && verifyFailure) {
    console.error(
      `\nagentcall is set up, but your agent is NOT ready to answer calls.\n` +
        `  Failed check: ${verifyFailure.name}${verifyFailure.detail ? ` — ${verifyFailure.detail}` : ""}\n` +
        (verifyFailure.hint ? `  Fix: ${verifyFailure.hint}\n` : "") +
        `\nOnce fixed, run \`agentcall doctor\` to confirm — calls start working immediately, no setup re-run needed.\n\n` +
        `  Handle:  ${cfg.handle}\n` +
        `  Agent:   ${cfg.agent_kind}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n`,
    );
    return { ready: false };
  }
  if (cfg.agent_kind) {
    console.log(
      `\nagentcall is set up.\n` +
        (opts.verify !== false ? `  ✓ agent verified (${cfg.agent_kind} answered a sandboxed test call)\n` : "") +
        `  Handle:  ${cfg.handle}\n` +
        `  Agent:   ${cfg.agent_kind}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n\n` +
        `Share your address so others can call your agent:\n` +
        `  agentcall call ${address} "hello"\n`,
    );
  } else {
    // ... existing caller-only message unchanged ...
  }
  return { ready: true };
```

f) In `packages/cli/src/index.ts`, extend the setup command:

```ts
  .option("--no-verify", "skip verifying the agent can answer a sandboxed test call")
```

and in its action, add `verify: o.verify` to the `runSetup` call's options object (the action's option type gains `verify?: boolean`), then:

```ts
      const result = await runSetup({ ... , verify: o.verify });
      if (!result.ready) process.exitCode = 1;
```

- [ ] **Step 4: Fix existing setup tests that would now try to verify**

Existing `runSetup` calls in `test/setup.test.ts` (and any in other test files — search with `grep -rn "runSetup(" packages/cli/test/`) pass real-ish options without `verifyFns`; with verification on by default they would attempt a real `resolveAgentBin`/spawn. Add `verify: false,` to each pre-existing `runSetup({...})` call site (the ones added in Step 1 excepted). Do not change any other assertion.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/setup.test.ts` then `pnpm test`
Expected: PASS — all new and pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/src/index.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): setup verifies the agent answers a sandboxed call"
```

---

### Task 6: `agentcall doctor` command

**Files:**
- Create: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`relayUrl` from `src/config.js`, `getStatus` from `src/api.js`, `callAgent` from `src/callClient.js`, `LAUNCH_LABEL` from `src/launchd.js`, `verifyAgent`/`checkRelaySelfCall`/`formatCheck`/`VerifyFns`/`VerifyCheck` from `src/verify.js`, `saveConfig` (tests only).
- Produces: `runDoctor(deps: DoctorDeps): Promise<number>` (exit code), wired to `agentcall doctor`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/doctor.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
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
    writeFileSync(p.srtFile, "{}\n");
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    const out = lines.join("\n");
    for (const name of ["config", "srt.json", "background listener", "relay status", "agent binary", "sandboxed agent run", "relay self-call"]) {
      expect(out).toContain(`✓ ${name}`);
    }
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
    writeFileSync(p.srtFile, "{}\n");
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
    expect(out).toContain("✓ sandboxed agent run");
    expect(out).toContain("skipping relay self-call");
  });

  it("skips spawn and self-call after a failed codex auth check", async () => {
    const p = freshPaths();
    saveConfig(p, { handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    writeFileSync(p.srtFile, "{}\n");
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
    writeFileSync(p.srtFile, "{}\n");
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, paths: p, launchctlList: () => "nothing here\n", log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ background listener");
    expect(out).toContain("✓ sandboxed agent run");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/doctor.test.ts`
Expected: FAIL — cannot resolve `../src/doctor.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/doctor.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getStatus } from "./api.js";
import { callAgent } from "./callClient.js";
import { loadConfig, relayUrl, type Config } from "./config.js";
import { LAUNCH_LABEL } from "./launchd.js";
import type { Paths } from "./paths.js";
import { checkRelaySelfCall, formatCheck, verifyAgent, type VerifyCheck, type VerifyFns } from "./verify.js";

export interface DoctorDeps {
  paths: Paths;
  // Test seams — production callers should leave these as the defaults.
  verifyFns?: VerifyFns;
  getStatusFn?: typeof getStatus;
  callFn?: typeof callAgent;
  launchctlList?: () => string;
  isDarwin?: boolean;
  log?: (line: string) => void;
}

const defaultLaunchctlList = () =>
  execFileSync("launchctl", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const short = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

// Verifies this install can answer calls, printing one line per check.
// Ladder semantics (see the design spec): static checks are informational
// and never block the agent checks, EXCEPT a missing config (nothing to
// verify) and caller-only (nothing to verify, and that's fine — exit 0).
// The relay-status result gates only the relay self-call; the verifyAgent
// ladder stops itself at its first failure. Returns the process exit code:
// 0 iff every check printed as ✓.
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const log = deps.log ?? console.log;
  const checks: VerifyCheck[] = [];
  const report = (c: VerifyCheck) => {
    checks.push(c);
    log(formatCheck(c));
  };

  let cfg: Config;
  try {
    cfg = loadConfig(deps.paths);
  } catch (e) {
    report({ name: "config", ok: false, detail: short(e), hint: "run `agentcall setup` first" });
    return 1;
  }
  report({ name: "config", ok: true, detail: `${cfg.handle} -> ${relayUrl(cfg)}` });

  if (!cfg.agent_kind) {
    log("caller-only install — no agent to verify. You can still call others.");
    return 0;
  }

  // runAgent rewrites srt.json before every spawn, so a missing file is a
  // sign setup didn't finish rather than a blocker — report and continue.
  report({
    name: "srt.json",
    ok: existsSync(deps.paths.srtFile),
    hint: existsSync(deps.paths.srtFile) ? undefined : "re-run `agentcall setup` to seed the sandbox settings",
  });

  if (deps.isDarwin ?? process.platform === "darwin") {
    let loaded = false;
    try {
      loaded = (deps.launchctlList ?? defaultLaunchctlList)().includes(LAUNCH_LABEL);
    } catch {
      loaded = false;
    }
    report({
      name: "background listener (launchd)",
      ok: loaded,
      hint: loaded ? undefined : "re-run `agentcall setup` to install it, or run `agentcall listen` in a terminal",
    });
  }

  let online = false;
  try {
    online = (await (deps.getStatusFn ?? getStatus)(relayUrl(cfg), cfg.handle)).online;
    report({
      name: "relay status",
      ok: online,
      detail: online ? "online" : "offline",
      hint: online ? undefined : "the listener isn't connected — check ~/.agentcall/listener.log",
    });
  } catch (e) {
    report({ name: "relay status", ok: false, detail: short(e) });
  }

  const agentChecks = await verifyAgent(cfg.agent_kind, deps.paths, deps.verifyFns);
  for (const c of agentChecks) report(c);
  const agentOk = agentChecks.every((c) => c.ok);

  if (agentOk && online) {
    report(await checkRelaySelfCall(cfg, deps.callFn));
  } else if (agentOk) {
    log("skipping relay self-call (agent offline).");
  }

  return checks.every((c) => c.ok) ? 0 : 1;
}
```

Wire it in `packages/cli/src/index.ts` (import `runDoctor` from `./doctor.js`, place the command after the `status` command):

```ts
program
  .command("doctor")
  .description("verify this install can answer calls: binary, auth, sandbox spawn, listener, relay self-call")
  .action(async () => {
    process.exitCode = await runDoctor({ paths: getPaths() });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/doctor.test.ts` then `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor.ts packages/cli/src/index.ts packages/cli/test/doctor.test.ts
git commit -m "feat(cli): agentcall doctor health-check command"
```

---

### Task 7: Docs + full-repo verification

**Files:**
- Modify: `README.md` (commands section — add `doctor` and `--no-verify`)
- No source changes.

- [ ] **Step 1: Update README**

Find the commands/usage section in the repo-root `README.md` (search for the `agentcall status` mention) and add, matching the surrounding format:

- A `agentcall doctor` entry: "verify your install can answer calls (auth, sandbox spawn, listener, relay self-call) — run it whenever calls to you start failing."
- A note under setup: "`--no-verify` skips the post-setup test call (e.g. when provisioning before logging in). Setup verifies by default that your agent — claude or codex — can actually answer a sandboxed call, including that it's authenticated."

- [ ] **Step 2: Full-repo verification**

Run from the repo root: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all three pass for `packages/shared`, `apps/relay`, `packages/cli`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document agentcall doctor and setup --no-verify"
```

---

## Manual verification (after implementation, on this machine)

Not part of CI — a one-time live sanity pass, since this feature exists precisely because CI can't catch auth issues:

1. `agentcall doctor` — expect all ✓ (this machine's agent is currently healthy per calls.log).
2. Optionally re-run `agentcall setup` (reuses config) and confirm the verified line appears.
