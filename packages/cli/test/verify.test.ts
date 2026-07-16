import { describe, expect, it } from "vitest";
import { AgentRunError } from "../src/runner.js";
import { checkAgentBinary, checkCodexAuth, classifyAgentFailure, formatCheck, HINTS } from "../src/verify.js";

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
