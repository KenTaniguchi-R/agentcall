import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_TIMEOUT_MS, MAX_REPLY_BYTES } from "@benree/agentcall-shared";
import { resolveAgentBin } from "./bin.js";
import { CAPS, FULL_ACCESS_ENVELOPE, type Cap, type Envelope } from "./tasks.js";

export type AgentKind = "claude" | "codex";
export interface SpawnSpec { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export interface AgentOutput { text: string; session_id?: string }

export class AgentRunError extends Error {
  constructor(message: string, public code: "timeout" | "agent_error") { super(message); }
}

// Cap on accumulated stdout while an agent is running, independent of the
// final MAX_REPLY_BYTES truncation applied to the parsed reply text — this
// bounds memory for a runaway/malicious process that never stops writing.
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
// Cap on accumulated stderr — only ever surfaced as `.slice(0, 2000)` in an
// error message, so 1MB is plenty of headroom while still bounding memory
// for a runaway process that floods stderr instead of stdout.
const MAX_STDERR_BYTES = 1 * 1024 * 1024;
// Grace period between SIGTERM and SIGKILL when tearing down an agent's
// process group (on timeout or stdout overflow).
const KILL_GRACE_MS = 10_000;

// Timeout for the PreToolUse guard hook. Biased long on purpose: timeout expiry
// fails OPEN (the tool runs), so all risk is on the too-short side. A hung guard
// stalls one call (safe and visible); an abandoned one is neither. Measured cost
// is ~33ms.
export const GUARD_TIMEOUT_S = 30;

// Inline settings, not a plugin and not a file: scoped to this spawn, gone when
// the process exits, and the owner's own ~/.claude is untouched.
//
// No `matcher` and no `if`: both narrow which calls arrive, and the matcher
// parser fails open. No `permissions.deny` either — a matching deny rule blocks
// the read AND suppresses the hook, so the denial would never be logged.
// The hook command is handed to a shell. An install path containing a quote,
// a space, a backslash, or $( ) would produce an unparseable command — and an
// unparseable hook command fails OPEN, so the credential read then proceeds.
// Single quotes with the standard '\'' escape are the safe POSIX form.
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const guardCommand = () =>
  `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./guard-entry.js", import.meta.url)))}`;

export function guardSettingsJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        hooks: [{ type: "command", command: guardCommand(), timeout: GUARD_TIMEOUT_S }],
      }],
    },
  });
}

// TOML basic string. Only `"` and `\` need escaping for a path; the control
// characters that would also require it cannot appear in one.
const tomlQuote = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`;

// Codex takes hooks as configuration rather than as a settings blob, and `-c`
// is the only form scoped to a single spawn — the alternatives
// ($CODEX_HOME/hooks.json, the project .codex/) would edit configuration the
// owner keeps, which claude's inline --settings deliberately avoids.
//
// This registers the SAME entry point as claude, but the spawn runs it in
// observe mode: it records attempts, it does not block. See GuardMode.
export function guardCodexConfigArg(): string {
  return `hooks.PreToolUse=[{hooks=[{type="command",command=${tomlQuote(guardCommand())},timeout=${GUARD_TIMEOUT_S}}]}]`;
}

// Cap -> Claude Code tool names, used with --allowedTools + --permission-mode
// dontAsk: listed tools are pre-approved, everything else is denied instead
// of prompting (headless -p can't prompt). "read" is always included — an
// agent that can't read its own cwd can't answer anything.
const CLAUDE_TOOLS: Record<Cap, string[]> = {
  read: ["Read", "Grep", "Glob", "LS"],
  write: ["Write", "Edit"],
  fetch: ["WebFetch", "WebSearch"],
  exec: ["Bash"],
};

export function claudeAllowedTools(envelope: Envelope): string {
  const caps = new Set<Cap>(["read", ...envelope.caps]);
  return CAPS.filter((c) => caps.has(c)).flatMap((c) => CLAUDE_TOOLS[c]).join(",");
}

// resolveBin is injectable for tests (the default resolves the real binary
// via PATH). Production callers should leave it as the default: the listener
// runs under launchd's fixed PATH with no shell rc, so a bare
// "claude"/"codex" can fail to resolve there even though it works in an
// interactive shell — the absolute path sidesteps that entirely.
//
// The envelope is enforced by the agent's own permission flags, which is the
// whole of it now: this used to additionally wrap every spawn in
// `npx @anthropic-ai/sandbox-runtime --settings <file>`, confining reads and
// writes at the OS level. That boundary is deliberately gone — the answering
// agent is meant to be the owner's real working agent with their real
// context, which a fresh confined spawn can't be. Capability scoping (below)
// plus pre-prompt task resolution (policy.ts/listener.ts) is what stands
// between a caller and the machine.
export function buildSpawnSpec(
  kind: AgentKind, prompt: string, workdir: string, resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown",
): SpawnSpec {
  if (kind === "claude") {
    return {
      cmd: resolveBin(kind),
      args: ["-p", prompt, "--output-format", "json",
        "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools(envelope),
        "--settings", guardSettingsJson()],
      cwd: workdir,
      env: { ...process.env, AGENTCALL_CALL_ID: callId },
    };
  }
  // Codex has no per-tool granularity, so the envelope's write cap maps onto
  // its native sandbox level instead — the codex-side analogue of claude's
  // --allowedTools, and now the only thing confining its writes. Note it does
  // NOT confine reads: `codex exec --sandbox read-only` still reads ~/.ssh.
  const sandbox = envelope.caps.includes("write") ? "workspace-write" : "read-only";
  return {
    cmd: resolveBin(kind),
    // --ignore-user-config drops the owner's ~/.codex: their MCP servers,
    // plugins and apps. Those are separate processes that reach the
    // filesystem outside codex's sandbox entirely, so a remote caller could
    // otherwise route around every control here — on a typical dev machine
    // that means a filesystem MCP server, and often `claude mcp serve`, which
    // re-exposes Read and Bash. Claude fences these off with --allowedTools,
    // an allowlist that `mcp__*` names never match; codex has no equivalent,
    // so not loading them is the only lever. The prompt stays last: codex
    // takes the final positional as the prompt.
    //
    // --dangerously-bypass-hook-trust is required for the guard to run AT ALL.
    // Codex gates hook execution on *persisted trust* (HookStateToml carries a
    // trusted_hash), and a hook supplied inline via -c has never been trusted, so
    // codex skips it — silently, with no warning on stdout or stderr and no
    // change to the exit code. Without this flag the observe-mode guard is dead
    // code. Verified against codex-cli 0.146.0 on 2026-08-01: the identical spawn
    // logged zero tool_call lines with the flag absent (twice, each having really
    // executed a shell command) and one line with it present.
    //
    // The flag's name is about *other people's* hooks, which is the case it is
    // dangerous for. The only hook codex can see here is the one on the next
    // line, whose path agentcall controls. --ignore-user-config already drops
    // $CODEX_HOME/config.toml, and that file is where codex records which project
    // directories are trusted (`[projects."<path>"] trust_level = "trusted"`), so
    // with no trust list loaded the project config layers stay disabled and a
    // .codex/hooks.json planted in the workspace by a caller holding the write
    // cap is never loaded.
    //
    // That pairing is load-bearing, so it was tested against a *trusted* project
    // rather than a scratch directory — in an untrusted directory the planted
    // hook is skipped anyway and the test proves nothing. Control (trusted
    // workspace, bypass on, WITHOUT --ignore-user-config): the planted hook RAN.
    // Treatment (same, WITH --ignore-user-config, i.e. the spawn below): the
    // planted hook did NOT run, while this hook did. Removing
    // --ignore-user-config would therefore turn this flag into arbitrary
    // caller-supplied code execution; the test above it pins them together.
    args: ["exec", "--ignore-user-config", "--dangerously-bypass-hook-trust",
      "--sandbox", sandbox, "--cd", workdir,
      "--skip-git-repo-check", "--json", "-c", guardCodexConfigArg(), prompt],
    cwd: workdir,
    env: { ...process.env, AGENTCALL_CALL_ID: callId, AGENTCALL_GUARD_MODE: "observe" },
  };
}

export function parseClaudeJson(stdout: string): AgentOutput {
  const parsed = JSON.parse(stdout.trim()) as { result?: string; session_id?: string; is_error?: boolean };
  if (parsed.is_error) throw new Error(`claude reported an error: ${parsed.result ?? "unknown error"}`);
  if (typeof parsed.result !== "string") throw new Error("claude output missing result");
  return { text: parsed.result, session_id: parsed.session_id };
}

export function parseCodexJsonl(stdout: string): AgentOutput {
  let text: string | undefined;
  let session: string | undefined;
  let sawJson = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt = JSON.parse(trimmed) as any;
      sawJson = true;
      if (evt.thread_id ?? evt.session_id) session = evt.thread_id ?? evt.session_id;
      if (evt.type === "item.completed" && evt.item?.type === "agent_message" && typeof evt.item.text === "string") {
        text = evt.item.text;
      }
    } catch { /* not a json line */ }
  }
  if (text !== undefined) return { text, session_id: session };
  const raw = stdout.trim();
  if (!sawJson && raw) return { text: raw, session_id: session };
  throw new Error("codex output had no agent_message");
}

// Truncates to at most maxBytes UTF-8 bytes without splitting a multi-byte
// character. A raw string.slice() counts UTF-16 code units, not bytes, and
// can cut a multi-byte character in half; decoding a byte-sliced Buffer
// back to a string instead replaces any truncated trailing sequence with
// U+FFFD, which we then strip.
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

export function runAgent(
  kind: AgentKind, prompt: string, workdir: string, timeoutMs: number = AGENT_TIMEOUT_MS, specOverride?: SpawnSpec,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown",
): Promise<AgentOutput> {
  const spec = specOverride ?? buildSpawnSpec(kind, prompt, workdir, resolveAgentBin, envelope, callId);
  return new Promise<AgentOutput>((resolve, reject) => {
    // detached: true makes the child its own process group leader, so any
    // grandchildren it forks share its process group unless they detach
    // themselves.
    // That lets us tear down the whole tree with one signal to -pid instead
    // of leaving orphans that hold the stdout pipe open or keep running
    // past the timeout.
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    // Buffers are accumulated and decoded to a string exactly once, at exit
    // (below) — decoding each chunk independently (`stdout += d`) can split
    // a multi-byte UTF-8 character across a pipe chunk boundary, corrupting
    // it into U+FFFD (e.g. mangling non-ASCII replies).
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { /* group may already be gone */ }
    };
    const escalate = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!overflowed) { overflowed = true; escalate(); }
        return;
      }
      stdoutChunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderrChunks.push(d);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      escalate();
    }, timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new AgentRunError(String(e), "agent_error"));
    });
    // Settle on `exit`, not `close`: `close` waits for the stdio streams to
    // finish, and a grandchild that inherited stdout can keep that pipe
    // open long after the direct child we spawned has exited, hanging this
    // promise forever. `exit` fires as soon as the process we spawned
    // terminates, which is all we need — we still tear down the rest of
    // the process group above so no grandchild is left running past this.
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) return reject(new AgentRunError(`agent timed out after ${timeoutMs}ms`, "timeout"));
      if (overflowed) return reject(new AgentRunError(`agent stdout exceeded ${MAX_STDOUT_BYTES} bytes`, "agent_error"));
      // Decoded once here, not incrementally in the `data` handlers, so a
      // multi-byte UTF-8 character split across a pipe chunk boundary is
      // decoded correctly instead of corrupting into U+FFFD.
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        // claude -p reports auth failures as is_error JSON on stdout with
        // exit 1 and empty stderr, so stderr alone can be the empty string
        // even though the actual error text is sitting right there on
        // stdout — fall back to it so classifyAgentFailure has something to
        // match against.
        const errText = (stderr.trim() ? stderr : stdout).slice(0, 2000);
        return reject(new AgentRunError(`agent exited ${code}: ${errText}`, "agent_error"));
      }
      try {
        const out = kind === "claude" ? parseClaudeJson(stdout) : parseCodexJsonl(stdout);
        resolve({ ...out, text: truncateUtf8(out.text, MAX_REPLY_BYTES) });
      } catch (e) {
        reject(new AgentRunError(`could not parse agent output: ${String(e)}`, "agent_error"));
      }
    });
  });
}
