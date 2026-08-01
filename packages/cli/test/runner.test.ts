import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import {
  buildSpawnSpec, claudeAllowedTools, guardSettingsJson, GUARD_TIMEOUT_S,
  parseClaudeJson, parseCodexJsonl, runAgent, truncateUtf8,
} from "../src/runner.js";
import { getPaths } from "../src/paths.js";
import { ASK_TASK, FULL_ACCESS_ENVELOPE, type Envelope, type Task } from "../src/tasks.js";

const p = getPaths("/tmp/fakehome");
// runAgent/buildSpawnSpec take the resolved working directory, not Paths.
const WORKDIR = p.publicDir;

describe("buildPrompt", () => {
  it("includes handle, caller, divider, and message", () => {
    const out = buildPrompt("ken", "shusaku", "review my plan");
    expect(out).toContain("ken's public agent");
    expect(out).toContain('"shusaku"');
    expect(out).toContain("\n---\nreview my plan");
  });

  it("embeds the task name, id, and SKILL.md content when a non-ask task is given", () => {
    const task: Task = {
      id: "schedule-meeting", name: "Schedule a meeting", description: "Book a time.",
      examples: [], envelope: { caps: ["read"] },
      skill: "# Steps\nCheck the calendar first.",
    };
    const out = buildPrompt("ken", "shusaku", "next tue?", task);
    expect(out).toContain('task "Schedule a meeting" (schedule-meeting)');
    expect(out).toContain("Check the calendar first.");
    expect(out).toContain("must not perform any other task");
    expect(out).toContain("\n---\nnext tue?");
  });

  it("adds no task section for the built-in ask task or when no task is given", () => {
    expect(buildPrompt("ken", "shusaku", "q?", ASK_TASK)).not.toContain("TASK-INSTRUCTIONS");
    expect(buildPrompt("ken", "shusaku", "q?")).not.toContain("TASK-INSTRUCTIONS");
  });

  // The confinement sentence is only honest for the default ~/AgentCall/public
  // share folder. When an owner deliberately points workdir at a real project,
  // telling the agent not to leave it contradicts the reason they set it.
  it("claims confinement only for the default workdir", () => {
    const confined = buildPrompt("ken", "shusaku", "q?", undefined, { dir: "/h/AgentCall/public", confined: true });
    expect(confined).toContain("/h/AgentCall/public");
    expect(confined).toMatch(/do not access anything outside it/i);

    const open = buildPrompt("ken", "shusaku", "q?", undefined, { dir: "/h/code/api", confined: false });
    expect(open).toContain("/h/code/api");
    expect(open).not.toMatch(/do not access anything outside it/i);
  });

  it("omits the directory sentence entirely when no workdir is given", () => {
    expect(buildPrompt("ken", "shusaku", "q?")).not.toMatch(/working directory/i);
  });
});

describe("buildSpawnSpec", () => {
  // The agent binary is spawned directly. buildSpawnSpec passes its resolved
  // absolute path rather than a bare "claude"/"codex", via an injectable
  // resolver (production default is resolveAgentBin; tests inject a fake so
  // they don't depend on claude/codex actually being installed) — the
  // listener runs under launchd's fixed PATH, where a bare name can fail to
  // resolve even though an interactive shell finds it.
  it("spawns claude directly with the resolved absolute agent path", () => {
    const s = buildSpawnSpec("claude", "PROMPT", WORKDIR, () => "/abs/path/to/claude");
    expect(s.cmd).toBe("/abs/path/to/claude");
    expect(s.args.slice(0, 6)).toEqual([
      "-p", "PROMPT", "--output-format", "json",
      "--permission-mode", "dontAsk",
    ]);
    const toolsIdx = s.args.indexOf("--allowedTools");
    expect(s.args[toolsIdx + 1]).toBe("Read,Grep,Glob,LS,Write,Edit,WebFetch,WebSearch,Bash");
    expect(s.cwd).toBe(WORKDIR);
    // Default callId, when the caller (e.g. a test) doesn't pass one.
    expect(s.env?.AGENTCALL_CALL_ID).toBe("unknown");
  });

  // Regression: every spawn used to be wrapped in `npx
  // @anthropic-ai/sandbox-runtime --settings <file>`. That OS sandbox is gone
  // — the answering agent is meant to be the owner's real agent with their
  // real context — so no spawn should reach for npx or that sandbox package.
  // claude's spawn does now carry its own --settings (the PreToolUse guard
  // hook, added in buildSpawnSpec's claude branch) — a different mechanism
  // for a different purpose, so it's excluded from this regression check.
  it("does not wrap the spawn in the sandbox runtime", () => {
    for (const kind of ["claude", "codex"] as const) {
      const s = buildSpawnSpec(kind, "PROMPT", WORKDIR, () => `/abs/${kind}`);
      expect(s.cmd).not.toBe("npx");
      expect(s.args.join(" ")).not.toContain("sandbox-runtime");
      expect(s.args.join(" ")).not.toContain("@anthropic-ai/sandbox-runtime");
    }
    const codex = buildSpawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/codex");
    expect(codex.args).not.toContain("--settings");
  });

  it("spawns codex directly, keeping its native sandbox level as the write cap", () => {
    const s = buildSpawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/path/to/codex");
    expect(s.cmd).toBe("/abs/path/to/codex");
    expect(s.args).toEqual([
      "exec", "--sandbox", "workspace-write", "--cd", WORKDIR, "--skip-git-repo-check", "--json", "PROMPT",
    ]);
    expect(s.cwd).toBe(WORKDIR);
  });

  it("resolves an absolute path by default, not a bare binary name", () => {
    // "node" stands in for a real agent kind: guaranteed to be on PATH
    // wherever this suite runs, so the production default resolver
    // (resolveAgentBin) can be exercised without claude/codex installed.
    const s = buildSpawnSpec("node" as unknown as "claude" | "codex", "PROMPT", WORKDIR);
    expect(isAbsolute(s.cmd)).toBe(true);
  });
});

describe("output parsing", () => {
  it("parses claude json output", () => {
    const stdout = JSON.stringify({ type: "result", result: "The answer is 4.", session_id: "abc-123", is_error: false });
    expect(parseClaudeJson(stdout)).toEqual({ text: "The answer is 4.", session_id: "abc-123" });
  });
  it("throws on claude error output", () => {
    expect(() => parseClaudeJson("total garbage")).toThrow();
  });
  it("throws when claude reports is_error, instead of relaying the error text as an answer", () => {
    const stdout = JSON.stringify({ type: "result", result: "Credit balance too low", session_id: "abc", is_error: true });
    expect(() => parseClaudeJson(stdout)).toThrow();
  });
  it("parses codex jsonl, taking the last agent_message", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "th_1" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
    ].join("\n");
    expect(parseCodexJsonl(lines)).toEqual({ text: "final answer", session_id: "th_1" });
  });
  it("falls back to raw stdout for codex without json events", () => {
    expect(parseCodexJsonl("plain text answer\n")).toEqual({ text: "plain text answer", session_id: undefined });
  });
});

describe("truncateUtf8", () => {
  it("passes text through unchanged when under the byte limit", () => {
    expect(truncateUtf8("hello", 100)).toBe("hello");
  });
  it("truncates on a full multi-byte boundary instead of splitting a character", () => {
    const emoji = "\u{1F600}"; // 4 bytes in UTF-8
    const text = "aaa" + emoji; // 3 + 4 = 7 bytes
    // Cutting at 5 bytes lands mid-way through the emoji's 4-byte sequence.
    const truncated = truncateUtf8(text, 5);
    expect(truncated).toBe("aaa");
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(5);
  });
});

describe("runAgent (with a fake agent binary)", () => {
  it("times out a hung process", async () => {
    // fake spec via kind override: use claude spec but point PATH at a script? Simpler:
    // runAgent accepts an optional spawnSpec override for tests.
    await expect(
      runAgent("claude", "x", WORKDIR, 300, { cmd: "sleep", args: ["5"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 15_000);
  it("captures stdout of a real process", async () => {
    const fakeOut = JSON.stringify({ type: "result", result: "hi", session_id: "s" });
    const res = await runAgent("claude", "x", WORKDIR, 5000, {
      cmd: "node", args: ["-e", `console.log(${JSON.stringify(fakeOut)})`], cwd: "/tmp",
    });
    expect(res.text).toBe("hi");
  });
  it("reassembles a multi-byte UTF-8 character split across a stdout chunk boundary", async () => {
    // Regression: accumulating stdout via `stdout += d` decodes each Buffer
    // chunk independently, so a multi-byte character straddling a pipe
    // chunk boundary gets corrupted into U+FFFD. Force two separate `data`
    // events by writing the JSON payload's bytes in two pieces, split
    // mid-way through a multi-byte character, with a delay between them.
    const script = `
      const full = Buffer.from(JSON.stringify({ type: "result", result: "日本語", session_id: "s" }), "utf8");
      const splitAt = full.findIndex((b) => b >= 0xc0) + 1;
      process.stdout.write(full.subarray(0, splitAt));
      setTimeout(() => process.stdout.write(full.subarray(splitAt)), 20);
    `;
    const res = await runAgent("claude", "x", WORKDIR, 5000, { cmd: "node", args: ["-e", script], cwd: "/tmp" });
    expect(res.text).toBe("日本語");
  });
  it("rejects agent_error on nonzero exit", async () => {
    await expect(
      runAgent("claude", "x", WORKDIR, 5000, { cmd: "node", args: ["-e", "process.exit(3)"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
  });
  it("falls back to stdout for the error message when stderr is empty", async () => {
    // Real shape: claude -p reports an auth failure as is_error JSON on
    // stdout with exit 1 and nothing on stderr — the old code built the
    // AgentRunError message from stderr alone, so this case surfaced as an
    // empty, unclassifiable "agent exited 1: ".
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" });
    const script = `process.stdout.write(${JSON.stringify(stdout)}); process.exit(1);`;
    await expect(
      runAgent("claude", "x", WORKDIR, 5000, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error", message: expect.stringContaining("Not logged in") });
  });
  it("kills the whole process group on timeout, so a grandchild holding stdout doesn't hang the promise", async () => {
    const marker = join(tmpdir(), `agentcall-pgid-test-${Date.now()}-${Math.random()}.pid`);
    // The outer process spawns a grandchild that inherits stdio (holding
    // the pipe open) and stays alive on its own long timer, then the outer
    // process also stays alive on its own long timer (so it won't exit on
    // its own before our runAgent timeout fires). Old code only signaled
    // the outer pid directly, leaving this grandchild running and the
    // stdout pipe open; the fix spawns detached and signals the whole
    // group via -pid.
    const script = `
      const cp = require("child_process");
      const fs = require("fs");
      const gc = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 1e6)"], { stdio: "inherit" });
      fs.writeFileSync(${JSON.stringify(marker)}, String(gc.pid));
      setTimeout(() => {}, 1e6);
    `;
    const start = Date.now();
    await expect(
      runAgent("claude", "x", WORKDIR, 500, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - start).toBeLessThan(5000);
    const grandchildPid = Number(readFileSync(marker, "utf8"));
    // Give the SIGTERM a moment to land, then confirm the grandchild (not
    // just the direct child) was actually torn down, not merely detected
    // as gone via a hung-forever `close` listener.
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 15_000);
  it("caps accumulated stdout and rejects agent_error instead of buffering unbounded output", async () => {
    const script = `
      process.stdout.write(Buffer.alloc(1024 * 1024, "x"));
      setInterval(() => process.stdout.write(Buffer.alloc(1024 * 1024, "x")), 5);
    `;
    const start = Date.now();
    await expect(
      runAgent("claude", "x", WORKDIR, 20_000, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
    // Should be caught by the 10MB cap almost immediately, well before the
    // 20s timeout — proves the cap tripped, not the timeout.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});

describe("envelope-scoped spawn spec", () => {
  const READ_ONLY: Envelope = { caps: ["read"] };

  it("claudeAllowedTools maps caps to tool lists, read always included, CAPS order", () => {
    expect(claudeAllowedTools(READ_ONLY)).toBe("Read,Grep,Glob,LS");
    expect(claudeAllowedTools({ caps: ["fetch"] })).toBe("Read,Grep,Glob,LS,WebFetch,WebSearch");
    expect(claudeAllowedTools(FULL_ACCESS_ENVELOPE)).toBe("Read,Grep,Glob,LS,Write,Edit,WebFetch,WebSearch,Bash");
  });

  it("read-only envelope restricts claude's allowedTools", () => {
    const s = buildSpawnSpec("claude", "PROMPT", WORKDIR, () => "/abs/claude", READ_ONLY);
    const idx = s.args.indexOf("--allowedTools");
    expect(s.args[idx + 1]).toBe("Read,Grep,Glob,LS");
    expect(s.args).toContain("dontAsk");
  });

  it("codex gets --sandbox read-only when the envelope has no write cap", () => {
    const s = buildSpawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/codex", READ_ONLY);
    const idx = s.args.indexOf("--sandbox");
    expect(s.args[idx + 1]).toBe("read-only");
  });

  it("codex keeps workspace-write when the envelope has the write cap", () => {
    const s = buildSpawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/codex", FULL_ACCESS_ENVELOPE);
    const idx = s.args.indexOf("--sandbox");
    expect(s.args[idx + 1]).toBe("workspace-write");
  });
});

describe("guard hook wiring", () => {
  it("registers exactly one PreToolUse hook and nothing else", () => {
    const settings = JSON.parse(guardSettingsJson());
    // Scope guard: a hook cannot be added to a security-carrying payload
    // without deliberately editing this assertion.
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse"]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("uses no matcher, so every tool call reaches the guard", () => {
    const entry = JSON.parse(guardSettingsJson()).hooks.PreToolUse[0];
    expect(entry.matcher).toBeUndefined();
    expect(entry.if).toBeUndefined();
  });

  it("invokes an absolute interpreter and an absolute entry path", () => {
    const hook = JSON.parse(guardSettingsJson()).hooks.PreToolUse[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain(process.execPath);
    expect(hook.command).toContain("guard-entry.js");
    expect(hook.timeout).toBe(GUARD_TIMEOUT_S);
  });

  it("declares no permissions.deny — deny rules suppress the hook", () => {
    expect(JSON.parse(guardSettingsJson()).permissions).toBeUndefined();
  });

  it("shell-quotes both paths, since an unparseable command fails open", () => {
    const hook = JSON.parse(guardSettingsJson()).hooks.PreToolUse[0].hooks[0];
    // Both arguments single-quoted; nothing left bare for the shell to split
    // or expand.
    expect(hook.command).toMatch(/^'[^']*(?:'\\''[^']*)*' '[^']*(?:'\\''[^']*)*'$/);
  });

  it("passes --settings and the call id when spawning claude", () => {
    const spec = buildSpawnSpec("claude", "hi", WORKDIR, () => "/bin/claude", FULL_ACCESS_ENVELOPE, "call-9");
    const i = spec.args.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(spec.args[i + 1]!).hooks.PreToolUse).toBeDefined();
    expect(spec.env?.AGENTCALL_CALL_ID).toBe("call-9");
  });

  it("leaves the codex spawn untouched", () => {
    const spec = buildSpawnSpec("codex", "hi", WORKDIR, () => "/bin/codex", FULL_ACCESS_ENVELOPE, "call-9");
    expect(spec.args).not.toContain("--settings");
  });
});
