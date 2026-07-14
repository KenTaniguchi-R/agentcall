import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import { buildSpawnSpec, parseClaudeJson, parseCodexJsonl, runAgent, truncateUtf8 } from "../src/runner.js";
import { getPaths } from "../src/paths.js";

const p = getPaths("/tmp/fakehome");

describe("buildPrompt", () => {
  it("includes handle, caller, divider, and message", () => {
    const out = buildPrompt("ken", "shusaku", "review my plan");
    expect(out).toContain("ken's public agent");
    expect(out).toContain('"shusaku"');
    expect(out).toContain("\n---\nreview my plan");
  });
});

describe("buildSpawnSpec", () => {
  // A bare "claude"/"codex" arg fails inside srt's sandboxed shell (it can't
  // resolve PATH the way an interactive shell does — "command not found",
  // exit 127, confirmed against a real sandboxed spawn). buildSpawnSpec must
  // pass the agent's resolved absolute path instead, via an injectable
  // resolver (production default is resolveAgentBin; tests inject a fake so
  // they don't depend on claude/codex actually being installed).
  it("wraps claude in srt with settings file, using the resolved absolute agent path", () => {
    const s = buildSpawnSpec("claude", "PROMPT", p, () => "/abs/path/to/claude");
    expect(s.cmd).toBe("npx");
    expect(s.args).toEqual([
      "-y", "@anthropic-ai/sandbox-runtime@0.0.65", "--settings", p.srtFile, "--",
      "/abs/path/to/claude", "-p", "PROMPT", "--output-format", "json",
    ]);
    expect(s.cwd).toBe(p.publicDir);
  });
  it("wraps codex in srt too, so reads are protected even though codex's own sandbox only confines writes", () => {
    const s = buildSpawnSpec("codex", "PROMPT", p, () => "/abs/path/to/codex");
    expect(s.cmd).toBe("npx");
    expect(s.args).toEqual([
      "-y", "@anthropic-ai/sandbox-runtime@0.0.65", "--settings", p.srtFile, "--",
      "/abs/path/to/codex", "exec", "--sandbox", "workspace-write", "--cd", p.publicDir, "--skip-git-repo-check", "--json", "PROMPT",
    ]);
    expect(s.cwd).toBe(p.publicDir);
  });
  it("resolves an absolute path by default, not a bare binary name", () => {
    // "node" stands in for a real agent kind: guaranteed to be on PATH
    // wherever this suite runs, so the production default resolver
    // (resolveAgentBin) can be exercised without claude/codex installed.
    const s = buildSpawnSpec("node" as unknown as "claude" | "codex", "PROMPT", p);
    const idx = s.args.indexOf("--");
    expect(isAbsolute(s.args[idx + 1])).toBe(true);
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
      runAgent("claude", "x", p, 300, { cmd: "sleep", args: ["5"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 15_000);
  it("captures stdout of a real process", async () => {
    const fakeOut = JSON.stringify({ type: "result", result: "hi", session_id: "s" });
    const res = await runAgent("claude", "x", p, 5000, {
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
    const res = await runAgent("claude", "x", p, 5000, { cmd: "node", args: ["-e", script], cwd: "/tmp" });
    expect(res.text).toBe("日本語");
  });
  it("rejects agent_error on nonzero exit", async () => {
    await expect(
      runAgent("claude", "x", p, 5000, { cmd: "node", args: ["-e", "process.exit(3)"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
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
      runAgent("claude", "x", p, 500, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
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
      runAgent("claude", "x", p, 20_000, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
    // Should be caught by the 10MB cap almost immediately, well before the
    // 20s timeout — proves the cap tripped, not the timeout.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});
