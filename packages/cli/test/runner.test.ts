import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import {
  buildSpawnSpec, claudeAllowedTools, discoverMcpServers, mcpServerNamesFrom, pluginMcpServerNamesFrom,
  guardSettingsJson, GUARD_TIMEOUT_S,
  codexThreadingEnabled, codexToolTelemetryEnabled, CODEX_HOOK_TRUST_VERIFIED_VERSION,
  CODEX_THREADING_VERIFIED_VERSION,
  AgentRunError, isResumeFailure,
  parseClaudeJson, parseCodexJsonl, runAgent, truncateUtf8, type AgentKind, type SpawnSpec,
} from "../src/runner.js";
import { resolveAgentBin } from "../src/bin.js";
import { getPaths } from "../src/paths.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import { tempDir } from "./helpers.js";

// runAgent/buildSpawnSpec take the resolved working directory, not a paths object.
const WORKDIR = getPaths("/tmp/fakehome").shareDir;

function spawnSpec(
  kind: AgentKind, prompt: string, workdir: string,
  resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  callId: string = "unknown", ): SpawnSpec {
  return buildSpawnSpec({ kind, prompt, workdir, resolveBin, callId });
}
function agentRun(
  kind: AgentKind, prompt: string, workdir: string, timeoutMs: number,
  specOverride?: SpawnSpec, callId: string = "unknown",
  signal?: AbortSignal, ): ReturnType<typeof runAgent> {
  return runAgent({ kind, prompt, workdir, timeoutMs, specOverride, callId, signal });
}

describe("codex threading evidence", () => {
  const bin = () => "/fake/bin/codex";

  it("enables threading only for the codex-cli release that passed the live sandbox probe", () => {
    expect(codexThreadingEnabled(bin, () => `codex-cli ${CODEX_THREADING_VERIFIED_VERSION}`)).toBe(true);
    expect(codexThreadingEnabled(bin, () => "codex-cli 0.147.0")).toBe(false);
  });

  it("fails closed when the version cannot be read or parsed", () => {
    expect(codexThreadingEnabled(bin, () => "codex-cli unknown")).toBe(false);
    expect(codexThreadingEnabled(bin, () => { throw new Error("missing"); })).toBe(false);
  });
});

describe("codex tool telemetry evidence", () => {
  const bin = () => "/fake/bin/codex";

  it("keeps PostToolUse telemetry disabled until a default production tool path has paired evidence", () => {
    expect(codexToolTelemetryEnabled(bin, () => `codex-cli ${CODEX_HOOK_TRUST_VERIFIED_VERSION}`)).toBe(false);
    expect(codexToolTelemetryEnabled(bin, () => "codex-cli 0.146.0")).toBe(false);
    expect(codexToolTelemetryEnabled(bin, () => "codex-cli 0.147.0")).toBe(false);
    expect(codexToolTelemetryEnabled(bin, () => "codex-cli unknown")).toBe(false);
    expect(codexToolTelemetryEnabled(bin, () => { throw new Error("missing"); })).toBe(false);
  });
});

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
      examples: [], keywords: [], threadable: true,
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

  // Replaces "claims confinement only for the default workdir". #372 deleted
  // the `confined` flag, and with it the sentence "Do not access anything
  // outside it" — which had stopped being true when AGENTCALL_ALLOWED_ROOT was
  // removed, and had become worse than untrue: the boundary is the sensitivity
  // map, so telling the agent to stay in one directory discouraged it from
  // reading sources it is explicitly permitted to read.
  it("states the readable sources instead of claiming confinement", () => {
    const p = buildPrompt("ken", "shusaku", "q?", undefined, {
      dir: "/h/code/api", readable: ["/h/code/api", "/h/AgentCall/ken/public"],
    });
    expect(p).toContain("Your working directory is /h/code/api.");
    expect(p).toContain("You may read files under: /h/code/api, /h/AgentCall/ken/public.");
    expect(p).not.toMatch(/do not access anything outside it/i);
  });

  // Was "says the reply is checked, which is the boundary that actually exists".
  // It is not, and never was: listener.ts runs redactOutbound over the answer,
  // which replaces credential-SHAPED strings and the line's own relay token.
  // Nothing compares the answer against the caller's clearance.
  //
  // The read boundary is real and is what the agent should be told about. The
  // reply boundary was invented by the same commit that deleted the previous
  // false claim ("Do not access anything outside it"), so this pins the absence
  // rather than only the presence — a prompt that overstates its guardrails
  // makes the model LESS careful, which is the opposite of what it is for.
  it("states the read boundary and does not claim a reply check that does not exist", () => {
    const p = buildPrompt("ken", "shusaku", "q?", undefined, { dir: "/h/x", readable: ["/h/x"] });
    expect(p).toMatch(/refused when you try to read it/i);
    expect(p).not.toMatch(/reply is checked/i);
    expect(p).not.toMatch(/checked before it is sent/i);
  });

  // Since nothing checks the answer, the model is the only thing standing
  // between a secret it was allowed to read and the wire. Say so.
  it("puts responsibility for the answer's contents on the agent", () => {
    const p = buildPrompt("ken", "shusaku", "q?", undefined, { dir: "/h/x", readable: ["/h/x"] });
    expect(p).toMatch(/not checked/i);
    expect(p).toMatch(/only what this caller may see/i);
  });

  // The fresh-install case: nothing labelled, so `readable` is empty. Listing
  // an empty set reads as a bug and invites the model to guess at paths.
  it("says so plainly when the caller may read nothing", () => {
    const p = buildPrompt("ken", "shusaku", "q?", undefined, { dir: "/h/share", readable: [] });
    expect(p).toContain("No source has been labelled for this caller");
    expect(p).not.toContain("You may read files under:");
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
    const s = spawnSpec("claude", "PROMPT", WORKDIR, () => "/abs/path/to/claude");
    expect(s.cmd).toBe("/abs/path/to/claude");
    expect(s.args).toEqual([
      "-p", "PROMPT", "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--allowedTools", claudeAllowedTools(),
      "--settings", guardSettingsJson(),
    ]);
    expect(s.cwd).toBe(WORKDIR);
    // Default callId, when the caller (e.g. a test) doesn't pass one.
    expect(s.env?.AGENTCALL_CALL_ID).toBe("unknown");
    // AGENTCALL_ALLOWED_ROOT is gone with the workdir confinement: the guard
    // asks the sensitivity map what a path is worth, not whether it sits under
    // one directory. The clearance is what the run now carries instead.
    expect(s.env?.AGENTCALL_ALLOWED_ROOT).toBeUndefined();
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
      const s = spawnSpec(kind, "PROMPT", WORKDIR, () => `/abs/${kind}`);
      expect(s.cmd).not.toBe("npx");
      expect(s.args.join(" ")).not.toContain("sandbox-runtime");
      expect(s.args.join(" ")).not.toContain("@anthropic-ai/sandbox-runtime");
    }
    const codex = spawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/codex");
    expect(codex.args).not.toContain("--settings");
  });

  it("spawns codex directly with a read-only sandbox", () => {
    const s = spawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/path/to/codex");
    expect(s.cmd).toBe("/abs/path/to/codex");
    // No guard hook: Codex gets none as of 2026-08-07, so the whole arg list is
    // pinned here rather than filtered.
    expect(s.args).toEqual([
      "exec", "--sandbox", "read-only", "--cd", WORKDIR,
      "--skip-git-repo-check", "--json", "PROMPT",
    ]);
    expect(s.cwd).toBe(WORKDIR);
  });

  it("resolves an absolute path by default, not a bare binary name", () => {
    // "node" stands in for a real agent kind: guaranteed to be on PATH
    // wherever this suite runs, so the production default resolver
    // (resolveAgentBin) can be exercised without claude/codex installed.
    const s = spawnSpec("node" as unknown as "claude" | "codex", "PROMPT", WORKDIR);
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
  // A child that never exits on its own, so only teardown can settle it.
  const hangingSpec = () => ({
    cmd: "node", args: ["-e", "setInterval(() => {}, 1000)"], cwd: "/tmp", env: process.env,
  });
  // A child that prints one claude-shaped result and exits immediately.
  const okSpec = (text: string) => ({
    cmd: "node",
    args: ["-e", `console.log(${JSON.stringify(JSON.stringify({ type: "result", result: text, session_id: "s" }))})`],
    cwd: "/tmp", env: process.env,
  });

  it("rejects with canceled when the signal aborts", async () => {
    const ac = new AbortController();
    const p = agentRun("claude", "p", WORKDIR, 60_000, hangingSpec(), "c1", ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "canceled" });
  });

  it("only settles after the process has actually exited", async () => {
    const ac = new AbortController();
    const p = agentRun("claude", "p", WORKDIR, 60_000, hangingSpec(), "c1", ac.signal);
    let settled = false;
    void p.catch(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    ac.abort();
    await p.catch(() => {});
    // Settling is driven by the child's `exit` event, so by the time the promise
    // rejects the spawned process is gone. That is what makes the listener's
    // cancellation acknowledgement honest.
    expect(settled).toBe(true);
  });

  it("ignores an abort that arrives after the agent already finished", async () => {
    const ac = new AbortController();
    const out = await agentRun("claude", "p", WORKDIR, 60_000, okSpec("done"), "c1", ac.signal);
    expect(out.text).toBe("done");
    ac.abort();                            // must not throw or produce an unhandled rejection
  });

  it("times out a hung process", async () => {
    // fake spec via kind override: use claude spec but point PATH at a script? Simpler:
    // runAgent accepts an optional spawnSpec override for tests.
    await expect(
      agentRun("claude", "x", WORKDIR, 300, { cmd: "sleep", args: ["5"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 15_000);
  it("captures stdout of a real process", async () => {
    const fakeOut = JSON.stringify({ type: "result", result: "hi", session_id: "s" });
    const res = await agentRun("claude", "x", WORKDIR, 5000, {
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
    const res = await agentRun("claude", "x", WORKDIR, 5000, { cmd: "node", args: ["-e", script], cwd: "/tmp" });
    expect(res.text).toBe("日本語");
  });
  it("rejects agent_error on nonzero exit", async () => {
    await expect(
      agentRun("claude", "x", WORKDIR, 5000, { cmd: "node", args: ["-e", "process.exit(3)"], cwd: "/tmp" }),
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
      agentRun("claude", "x", WORKDIR, 5000, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
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
      agentRun("claude", "x", WORKDIR, 500, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - start).toBeLessThan(5000);
    const grandchildPid = Number(readFileSync(marker, "utf8"));
    // Give the SIGTERM a moment to land, then confirm the grandchild (not
    // just the direct child) was actually torn down, not merely detected
    // as gone via a hung-forever `close` listener.
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 15_000);
  // Cancellation (listener.ts's cancel_call handling) reuses the exact same
  // teardown path as a timeout: SIGTERM/grace/SIGKILL against the whole
  // process group. The test above proves that path for a timed-out call;
  // this proves it separately for an aborted one, since "the promise settled
  // with code: canceled" alone doesn't prove the grandchild actually died —
  // only inspecting the pid after teardown does.
  it("kills the whole process group when the call is canceled via abort, not just the direct child", async () => {
    const marker = join(tmpdir(), `agentcall-pgid-cancel-test-${Date.now()}-${Math.random()}.pid`);
    const script = `
      const cp = require("child_process");
      const fs = require("fs");
      const gc = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 1e6)"], { stdio: "inherit" });
      fs.writeFileSync(${JSON.stringify(marker)}, String(gc.pid));
      setTimeout(() => {}, 1e6);
    `;
    const controller = new AbortController();
    const running = agentRun(
      "claude", "x", WORKDIR, 10_000, { cmd: "node", args: ["-e", script], cwd: "/tmp" },
      undefined, controller.signal,
    );
    const readyBy = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < readyBy) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(marker)).toBe(true);
    const start = Date.now();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "canceled" });
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
      agentRun("claude", "x", WORKDIR, 20_000, { cmd: "node", args: ["-e", script], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
    // Should be caught by the 10MB cap almost immediately, well before the
    // 20s timeout — proves the cap tripped, not the timeout.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});

// Every other runAgent test passes a specOverride, which skips
// buildSpawnSpec entirely, so nothing else pins this forwarding. This drives
// the real path (resolveAgentBin included) against a fake `claude` that
// records its argv and env instead of answering.
describe("runAgent -> buildSpawnSpec forwarding", () => {
  // Durable (not under $TMPDIR): preferDurableBin deliberately skips ephemeral
  // dirs, so a fake planted in os.tmpdir() would be passed over. Same trick as
  // test/bin.test.ts.
  const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", `runner-${process.pid}-bin`);
  const capture = join(binDir, "spawn.txt");
  const q = (s: string) => JSON.stringify(s); // sh-safe: these paths have no quotes

  it("passes resume to --resume and callId to AGENTCALL_CALL_ID — never swapped", async () => {
    const realPath = process.env.PATH;
    try {
      mkdirSync(binDir, { recursive: true });
      const fake = join(binDir, "claude");
      writeFileSync(fake, [
        "#!/bin/sh",
        `: > ${q(capture)}`,
        `for a in "$@"; do printf '%s\\n' "$a" >> ${q(capture)}; done`,
        `printf 'ENV_CALL_ID=%s\\n' "$AGENTCALL_CALL_ID" >> ${q(capture)}`,
        `printf '%s\\n' '{"type":"result","result":"ok","session_id":"s"}'`,
        "",
      ].join("\n"));
      chmodSync(fake, 0o755);
      // ONLY the fake dir, so resolveAgentBin cannot fall through to a real
      // claude install on the developer's PATH.
      process.env.PATH = binDir;

      // A real, existing cwd: the spawn inherits it, and a missing one fails
      // as ENOENT against the command itself. (WORKDIR is a path fixture under
      // a home that was never created.)
      const out = await runAgent({
        kind: "claude", prompt: "PROMPT", workdir: tmpdir(), timeoutMs: 10_000,
        callId: "call-id-not-a-session",
        resume: "session-id-not-a-call",
      });
      expect(out.text).toBe("ok");

      const argv = readFileSync(capture, "utf8").split("\n");
      expect(argv[argv.indexOf("--resume") + 1]).toBe("session-id-not-a-call");
      expect(argv).toContain("ENV_CALL_ID=call-id-not-a-session");
      expect(argv).not.toContain("call-id-not-a-session"); // never in argv at all
    } finally {
      if (realPath !== undefined) process.env.PATH = realPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("read-only spawn spec", () => {
  it("claudeAllowedTools stays read-only — Write/Edit/Bash are never grantable", () => {
    // AgentCall exposes research and authenticated remote tools, but local
    // mutation remains outside the answering envelope.
    const tools = claudeAllowedTools().split(",");
    for (const forbidden of ["Write", "Edit", "Bash", "NotebookEdit", "Task"]) {
      expect(tools).not.toContain(forbidden);
    }
  });

  it("claudeAllowedTools includes Skill", () => {
    // Not because the allowlist gates it — measured 2026-08-06, it does not —
    // but so the grant is stated in one place rather than resting on that.
    expect(claudeAllowedTools().split(",")).toContain("Skill");
  });

  it("claudeAllowedTools includes ToolSearch for deferred authenticated tools", () => {
    expect(claudeAllowedTools().split(",")).toContain("ToolSearch");
  });

  it("claudeAllowedTools includes web research tools", () => {
    expect(claudeAllowedTools().split(","))
      .toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
  });

  it("claudeAllowedTools expands each configured MCP server to a glob", () => {
    // `mcp__*` is not expressible: allow rules take a glob only AFTER a literal
    // mcp__<server>__ prefix, and the server segment must be glob-free. So the
    // servers are enumerated from the owner's own config at spawn time — which
    // is derived from local state, not typed by anyone.
    const tools = claudeAllowedTools(["jira", "openmemory"]).split(",");
    expect(tools).toContain("mcp__jira__*");
    expect(tools).toContain("mcp__openmemory__*");
  });

  it("claudeAllowedTools drops server names that are not safe allowlist segments", () => {
    // A name carrying a comma would split into a second entry and grant a tool
    // nobody enumerated; one carrying a glob would widen the server segment.
    const tools = claudeAllowedTools(["ok", "bad,Bash", "glob*", "sp ace", ""]).split(",");
    expect(tools).toContain("mcp__ok__*");
    expect(tools).not.toContain("Bash");
    expect(tools.filter((t) => t.startsWith("mcp__"))).toEqual(["mcp__ok__*"]);
  });

  it("reads the owner's configured MCP servers from ~/.claude.json", () => {
    // Derived from local state, not typed by anyone: the servers the owner
    // already installed are the ones a call may use.
    expect(mcpServerNamesFrom(JSON.stringify({
      mcpServers: { jira: { command: "npx" }, openmemory: { url: "https://x" } },
    }))).toEqual(["jira", "openmemory"]);
  });

  it("reads claude.ai hosted connectors from ~/.claude.json", () => {
    expect(mcpServerNamesFrom(JSON.stringify({
      claudeAiMcpEverConnected: ["claude.ai Google Calendar", "claude.ai Gmail"],
    }))).toEqual(["claude_ai_Google_Calendar", "claude_ai_Gmail"]);
  });

  it("reads MCP server names bundled by installed Claude plugins", () => {
    const files = new Map([
      ["/plugins/exa/.claude-plugin/plugin.json", JSON.stringify({ mcpServers: { exa: {} } })],
      ["/plugins/honcho/.claude-plugin/plugin.json", JSON.stringify({ mcpServers: "./mcp-servers.json" })],
      ["/plugins/honcho/mcp-servers.json", JSON.stringify({ honcho: {} })],
    ]);
    const read = (path: string) => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error("ENOENT");
      return raw;
    };

    expect(pluginMcpServerNamesFrom(JSON.stringify({
      plugins: {
        "exa@claude-plugins-official": [{ installPath: "/plugins/exa" }],
        "honcho@honcho": [{ installPath: "/plugins/honcho" }],
      },
    }), read)).toEqual(["plugin_exa_exa", "plugin_honcho_honcho"]);
  });

  it("discovers configured, hosted, and plugin MCP servers together", () => {
    const home = tempDir("agentcall-mcp-discovery-");
    const plugin = join(home, ".claude", "plugins", "cache", "exa");
    try {
      mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
      writeFileSync(join(home, ".claude.json"), JSON.stringify({
        mcpServers: { local: {} },
        claudeAiMcpEverConnected: ["claude.ai Google Calendar"],
      }));
      writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
        plugins: { "exa@official": [{ installPath: plugin }] },
      }));
      writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({
        mcpServers: { exa: {} },
      }));

      expect(discoverMcpServers(home)).toEqual([
        "local", "claude_ai_Google_Calendar", "plugin_exa_exa",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns nothing rather than throwing on a missing or unreadable config", () => {
    // A caller-facing spawn must not fail because the owner has no MCP set up,
    // or because their config is mid-edit.
    expect(mcpServerNamesFrom("")).toEqual([]);
    expect(mcpServerNamesFrom("{ not json")).toEqual([]);
    expect(mcpServerNamesFrom(JSON.stringify({}))).toEqual([]);
    expect(mcpServerNamesFrom(JSON.stringify({ mcpServers: null }))).toEqual([]);
    expect(mcpServerNamesFrom(JSON.stringify({ mcpServers: ["jira"] }))).toEqual([]);
  });

  it("carries the enumerated servers into the spawned allowlist", () => {
    const spec = buildSpawnSpec({
      kind: "claude", prompt: "hi", workdir: "/w", resolveBin: () => "/abs/claude",
      callId: "c1", mcpServers: ["jira"],
    });
    expect(spec.args[spec.args.indexOf("--allowedTools") + 1]).toContain("mcp__jira__*");
  });

  it("claude's allowedTools is read-only", () => {
    const s = spawnSpec("claude", "PROMPT", WORKDIR, () => "/abs/claude");
    const idx = s.args.indexOf("--allowedTools");
    expect(s.args[idx + 1]).toContain("Read,Grep,Glob,LS");
    expect(s.args).toContain("dontAsk");
  });

  it("codex always gets --sandbox read-only", () => {
    const s = spawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/codex");
    const idx = s.args.indexOf("--sandbox");
    expect(s.args[idx + 1]).toBe("read-only");
  });

  it("codex loads the owner's MCP, skills, apps, and web configuration", () => {
    const s = spawnSpec("codex", "PROMPT", WORKDIR, () => "/abs/codex");
    expect(s.args).not.toContain("--ignore-user-config");
    expect(s.args).not.toContain("--disable");
    expect(s.args).not.toContain(`web_search="disabled"`);
    expect(s.args[s.args.indexOf("--sandbox") + 1]).toBe("read-only");
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
    const spec = spawnSpec("claude", "hi", WORKDIR, () => "/bin/claude", "call-9");
    const i = spec.args.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(spec.args[i + 1]!).hooks.PreToolUse).toBeDefined();
    expect(spec.env?.AGENTCALL_CALL_ID).toBe("call-9");
    expect(spec.env?.AGENTCALL_ALLOWED_ROOT).toBeUndefined();
  });

  it("does not pass claude's --settings to codex, which would not parse it", () => {
    const spec = spawnSpec("codex", "hi", WORKDIR, () => "/bin/codex", "call-9");
    expect(spec.args).not.toContain("--settings");
  });





  it("leaves bundled Codex remote tools enabled", () => {
    const spec = spawnSpec("codex", "hi", WORKDIR, () => "/bin/codex", "call-9");
    expect(spec.args).not.toContain("--disable");
    expect(spec.args).not.toContain(`web_search="disabled"`);
    expect(spec.args).not.toContain("--strict-config");
  });

  it("leaves the claude spawn in enforcing mode", () => {
    const spec = spawnSpec("claude", "hi", WORKDIR, () => "/bin/claude", "call-9");
    expect(spec.env?.AGENTCALL_GUARD_MODE).toBeUndefined();
  });

  // The prompt is positional and codex reads the last one, so an override
  // appended after it would be taken as the prompt instead.
  it("keeps the prompt last, after the -c override", () => {
    const spec = spawnSpec("codex", "PROMPT", WORKDIR, () => "/bin/codex");
    expect(spec.args.at(-1)).toBe("PROMPT");
  });
});

describe("buildSpawnSpec resume (claude)", () => {
  const bin = () => "/usr/bin/claude";

  it("adds --resume with the agent session id", () => {
    const spec = buildSpawnSpec({ kind: "claude", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    const i = spec.args.indexOf("--resume");
    expect(i).toBeGreaterThan(-1);
    expect(spec.args[i + 1]).toBe("sess-abc");
  });

  it("omits --resume when no session is given", () => {
    const spec = buildSpawnSpec({ kind: "claude", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1" });
    expect(spec.args).not.toContain("--resume");
  });

  // Tool grants and the guard are re-applied per spawn, so a resumed session
  // cannot inherit anything looser from the turn that created it.
  it("still carries the read-only tools and guard on a resumed spawn", () => {
    const spec = buildSpawnSpec({ kind: "claude", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args).toContain("--allowedTools");
    expect(spec.args).toContain("--permission-mode");
    expect(spec.args).toContain("dontAsk");
    expect(spec.args).toContain("--settings");
    expect(spec.args[spec.args.indexOf("--allowedTools") + 1]).toBe(claudeAllowedTools());
  });

  it("keeps the prompt as the -p value", () => {
    const spec = buildSpawnSpec({ kind: "claude", prompt: "follow up", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args[spec.args.indexOf("-p") + 1]).toBe("follow up");
  });

});

describe("buildSpawnSpec resume (codex)", () => {
  const bin = () => "/usr/bin/codex";

  it("uses the resume subcommand with the session id", () => {
    const spec = buildSpawnSpec({ kind: "codex", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args.slice(0, 3)).toEqual(["exec", "resume", "sess-abc"]);
  });

  // resume has no --sandbox, so the envelope rides the config override instead.
  // Without this the resumed session keeps whatever sandbox it was created with.
  it("re-applies the read-only sandbox through -c sandbox_mode on resume", () => {
    // `codex exec resume` accepts neither --sandbox nor --cd, so the level has
    // to be re-applied as config or a resumed session runs unconfined.
    const spec = buildSpawnSpec({ kind: "codex", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args).toContain('sandbox_mode="read-only"');
  });

  it("never passes --sandbox or --cd on a resume, which the subcommand rejects", () => {
    const spec = buildSpawnSpec({ kind: "codex", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args).not.toContain("--sandbox");
    expect(spec.args).not.toContain("--cd");
  });

  it("loads user config and keeps the sandbox on a resumed spawn", () => {
    // User tools remain available on follow-ups; the sandbox rides the -c
    // override because `codex exec resume` accepts no --sandbox.
    const spec = buildSpawnSpec({ kind: "codex", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args).not.toContain("--ignore-user-config");
    expect(spec.args).toContain('sandbox_mode="read-only"');
    expect(spec.args.some((a) => a.startsWith("hooks."))).toBe(false);
  });

  it("puts the prompt last", () => {
    const spec = buildSpawnSpec({ kind: "codex", prompt: "follow up", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args.at(-1)).toBe("follow up");
  });


  it("keeps bundled remote tools enabled on resume", () => {
    const spec = buildSpawnSpec({ kind: "codex", prompt: "hi", workdir: "/w", resolveBin: bin, callId: "c1", resume: "sess-abc" });
    expect(spec.args).not.toContain("--disable");
    expect(spec.args).not.toContain(`web_search="disabled"`);
    expect(spec.args).not.toContain("--strict-config");
  });
});

// Codex has no per-tool MCP allowlist, so loading the owner's config delegates
// every configured MCP, skill, app, and web surface to answered callers.
describe("codex user tool access", () => {
  it("loads the owner's codex config when answering a remote call", () => {
    const spec = spawnSpec("codex", "hi", WORKDIR, () => "/bin/codex");
    expect(spec.args).not.toContain("--ignore-user-config");
  });
});

describe("call identity propagation", () => {
  it("injects only the call id into agent spawns", () => {
    const spec = buildSpawnSpec({ kind: "claude", prompt: "hi", workdir: "/work", resolveBin: () => "/bin/claude", callId: "call-1" });
    expect(spec.env?.AGENTCALL_CALL_ID).toBe("call-1");
    expect(spec.env?.AGENTCALL_LINE).toBeUndefined();
  });
});

// The exact text each CLI emits for a session it no longer holds, probed
// 2026-08-05 against the installed binaries: both exit 1 with an empty stdout
// and this on stderr, which runAgent folds into "agent exited 1: <text>".
// These strings are the whole basis for the classification, so they are
// written out verbatim here rather than paraphrased -- if a CLI rewords its
// message, this is the test that should fail.
const CLAUDE_RESUME_GONE =
  "agent exited 1: No conversation found with session ID: 00000000-dead-beef-0000-000000000000";
const CODEX_RESUME_GONE =
  "agent exited 1: Error: thread/resume: thread/resume failed: no rollout found for thread id "
  + "01999999-dead-beef-0000-000000000000 (code -32600)";

describe("isResumeFailure", () => {
  it("recognizes each CLI's own dead-session message", () => {
    expect(isResumeFailure("claude", new AgentRunError(CLAUDE_RESUME_GONE, "agent_error"))).toBe(true);
    expect(isResumeFailure("codex", new AgentRunError(CODEX_RESUME_GONE, "agent_error"))).toBe(true);
  });

  // Each kind is matched only against its own wording. Sharing one pattern
  // across both would make either CLI's text reclassify the other's failure.
  it("does not match the other CLI's message", () => {
    expect(isResumeFailure("codex", new AgentRunError(CLAUDE_RESUME_GONE, "agent_error"))).toBe(false);
    expect(isResumeFailure("claude", new AgentRunError(CODEX_RESUME_GONE, "agent_error"))).toBe(false);
  });

  // Everything else stays agent_error, which is the safe direction to fail:
  // a reworded CLI message degrades to the behaviour that existed before this
  // classifier, not to a wrong one.
  it("leaves every other failure alone", () => {
    for (const kind of ["claude", "codex"] as AgentKind[]) {
      expect(isResumeFailure(kind, new AgentRunError("agent timed out after 1000ms", "timeout"))).toBe(false);
      expect(isResumeFailure(kind, new AgentRunError("agent exited 1: Not logged in.", "agent_error"))).toBe(false);
      expect(isResumeFailure(kind, new AgentRunError("agent exited 127: command not found", "agent_error"))).toBe(false);
      expect(isResumeFailure(kind, new AgentRunError("could not parse agent output", "agent_error"))).toBe(false);
      expect(isResumeFailure(kind, "a bare string, not an Error")).toBe(false);
    }
  });
});
