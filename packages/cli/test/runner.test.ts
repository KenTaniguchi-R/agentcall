import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import { buildSpawnSpec, parseClaudeJson, parseCodexJsonl, runAgent } from "../src/runner.js";
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
  it("wraps claude in srt with settings file", () => {
    const s = buildSpawnSpec("claude", "PROMPT", p);
    expect(s.cmd).toBe("npx");
    expect(s.args).toEqual([
      "-y", "@anthropic-ai/sandbox-runtime", "--settings", p.srtFile, "--",
      "claude", "-p", "PROMPT", "--output-format", "json",
    ]);
    expect(s.cwd).toBe(p.publicDir);
  });
  it("uses codex native sandbox", () => {
    const s = buildSpawnSpec("codex", "PROMPT", p);
    expect(s.cmd).toBe("codex");
    expect(s.args).toEqual([
      "exec", "--sandbox", "workspace-write", "--cd", p.publicDir, "--skip-git-repo-check", "--json", "PROMPT",
    ]);
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
  it("rejects agent_error on nonzero exit", async () => {
    await expect(
      runAgent("claude", "x", p, 5000, { cmd: "node", args: ["-e", "process.exit(3)"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
  });
});
