import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { AgentRunError } from "../src/runner.js";
import { ASK_TASK } from "../src/tasks.js";
import {
  checkAgentBinary,
  checkCodexAuth,
  checkRelaySelfCall,
  checkAgentSpawn,
  classifyAgentFailure,
  formatCheck,
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

const fakePaths = getPaths("/tmp/agentcall-verify-test-home");

describe("checkAgentSpawn", () => {
  it("passes when runFn resolves, without asserting reply text", async () => {
    const c = await checkAgentSpawn("claude", fakePaths, async () => ({ text: "OK, got it!" }));
    expect(c).toMatchObject({ name: "agent run", ok: true });
  });

  it("invokes runFn with the verify prompt, timeout, and the read-only ask envelope", async () => {
    const seen: unknown[] = [];
    await checkAgentSpawn("claude", fakePaths, async (kind, prompt, _p, timeoutMs, _specOverride, envelope) => {
      seen.push(kind, prompt, timeoutMs, envelope);
      return { text: "OK" };
    });
    expect(seen).toEqual(["claude", VERIFY_PROMPT, VERIFY_TIMEOUT_MS, ASK_TASK.envelope]);
  });

  it("classifies an auth failure into a hint", async () => {
    const c = await checkAgentSpawn("claude", fakePaths, async () => {
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
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "agent run"]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("runs binary -> codex auth -> spawn for codex", async () => {
    const checks = await verifyAgent("codex", fakePaths, {
      resolveBin: () => "/fake/bin/codex",
      execFn: () => {},
      runFn: async () => ({ text: "OK" }),
    });
    expect(checks.map((c) => c.name)).toEqual(["agent binary", "codex auth", "agent run"]);
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

describe("checkRelaySelfCall", () => {
  const cfg = { handle: "ken", token: "tok", agent_kind: "claude" as const, relay: "https://relay.example" };

  it("calls the agent's own address through the relay and passes on a reply", async () => {
    const seen: Array<{ from: string; to: string; relay: string; token: string; message: string; timeoutMs?: number }> = [];
    const c = await checkRelaySelfCall(cfg, async (opts) => {
      seen.push({ from: opts.from, to: opts.to, relay: opts.relay, token: opts.token, message: opts.message, timeoutMs: opts.timeoutMs });
      return { type: "call_reply", call_id: "c1", text: "hi", task: "ask" } as never;
    });
    expect(c).toMatchObject({ name: "relay self-call", ok: true });
    expect(seen).toEqual([
      {
        from: "ken", to: "ken", relay: "https://relay.example", token: "tok",
        message: "agentcall doctor self-test: reply briefly", timeoutMs: VERIFY_TIMEOUT_MS + 30_000,
      },
    ]);
  });

  it("fails with a launchd-environment hint when the call errors", async () => {
    const c = await checkRelaySelfCall(cfg, async () => {
      throw new Error("The remote agent hit an error while answering.");
    });
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("listener");
  });
});
