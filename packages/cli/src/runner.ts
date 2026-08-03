import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_TIMEOUT_MS, MAX_REPLY_BYTES, type AgentKind } from "@benree/agentcall-shared";
import { resolveAgentBin } from "./bin.js";
import { CAPS, FULL_ACCESS_ENVELOPE, type Cap, type Envelope } from "./tasks.js";
import { agentChildEnv } from "./telemetry-env.js";

export type { AgentKind };

// The exact codex-cli release against which the live resume-sandbox probe
// passed. Threading fails closed on every other version: a CLI upgrade changes
// the security boundary and must be re-probed before resumed sessions are
// trusted again.
export const CODEX_THREADING_VERIFIED_VERSION = "0.146.0";

// Kept separate from the threading pin: updating resume-sandbox evidence must
// not silently bless an unreviewed hook-normalization implementation.
export const CODEX_HOOK_TRUST_VERIFIED_VERSION = "0.146.0";

export function codexThreadingEnabled(
  resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  readVersion: (bin: string) => string = (bin) =>
    execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
): boolean {
  try {
    const match = readVersion(resolveBin("codex")).match(/\b(\d+\.\d+\.\d+)\b/);
    return match?.[1] === CODEX_THREADING_VERIFIED_VERSION;
  } catch {
    return false;
  }
}

export function codexToolTelemetryEnabled(
  resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  readVersion: (bin: string) => string = (bin) =>
    execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
): boolean {
  try {
    const match = readVersion(resolveBin("codex")).match(/\b(\d+\.\d+\.\d+)\b/);
    return match?.[1] === CODEX_HOOK_TRUST_VERIFIED_VERSION;
  } catch {
    return false;
  }
}

export interface SpawnSpec { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export interface AgentOutput { text: string; session_id?: string }

export class AgentRunError extends Error {
  constructor(message: string, public code: "timeout" | "agent_error" | "canceled") { super(message); }
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
export const TOOL_TELEMETRY_TIMEOUT_S = 5;

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

// Exported so doctor's direct probe invokes the exact file the spawn wires up,
// rather than a second path expression that could drift from this one.
export const guardEntryPath = () => fileURLToPath(new URL("./guard-entry.js", import.meta.url));
export const toolTelemetryEntryPath = () => fileURLToPath(new URL("./tool-telemetry-entry.js", import.meta.url));

const guardCommand = () =>
  `${shellQuote(process.execPath)} ${shellQuote(guardEntryPath())}`;
const toolTelemetryCommand = () =>
  `${shellQuote(process.execPath)} ${shellQuote(toolTelemetryEntryPath())}`;

export function guardSettingsJson(includeToolTelemetry = false): string {
  const hooks: Record<string, unknown> = {
    PreToolUse: [{
      hooks: [{ type: "command", command: guardCommand(), timeout: GUARD_TIMEOUT_S }],
    }],
  };
  if (includeToolTelemetry) {
    const post = [{ hooks: [{
      type: "command", command: toolTelemetryCommand(), timeout: TOOL_TELEMETRY_TIMEOUT_S, async: false,
    }] }];
    hooks.PostToolUse = post;
    hooks.PostToolUseFailure = post;
  }
  return JSON.stringify({ hooks });
}

// TOML basic string. Only `"` and `\` need escaping for a path; the control
// characters that would also require it cannot appear in one.
const tomlQuote = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`;

// Codex takes hooks as configuration rather than as a settings blob, and `-c`
// is the only form scoped to a single spawn — the alternatives
// ($CODEX_HOME/hooks.json, the project .codex/) would edit configuration the
// owner keeps, which claude's inline --settings deliberately avoids.
//
// This registers the SAME entry point as claude, but Codex runs it in observe
// mode. Its command-shaped filesystem surface cannot be safely bounded here.
export function codexHookConfigArg(
  command: string,
  event: "PreToolUse" | "PostToolUse" = "PreToolUse",
  timeout = GUARD_TIMEOUT_S,
): string {
  return `hooks.${event}=[{hooks=[{type="command",command=${tomlQuote(command)},timeout=${timeout}}]}]`;
}

export function guardCodexConfigArg(): string {
  return codexHookConfigArg(guardCommand());
}

export function toolTelemetryCodexConfigArg(): string {
  return codexHookConfigArg(toolTelemetryCommand(), "PostToolUse", TOOL_TELEMETRY_TIMEOUT_S);
}

// Codex executes a hook only when its normalized identity matches a trusted
// hash. Trusting every hook would also execute hooks from the owner's config,
// project, plugins, and managed layers outside the tool sandbox. Instead,
// reproduce codex-cli 0.146.0's canonical identity for this one session hook
// and supply trust for its exact synthetic key. A CLI-side normalization
// change makes the hash mismatch and fails closed (the hook is skipped).
export const CODEX_SESSION_GUARD_KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";
export const CODEX_SESSION_TOOL_TELEMETRY_KEY = "/<session-flags>/config.toml:post_tool_use:0:0";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function codexHookTrustedHash(command: string, eventName = "pre_tool_use", timeout = GUARD_TIMEOUT_S): string {
  const identity = canonicalize({
    event_name: eventName,
    hooks: [{ type: "command", command, timeout, async: false }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function codexHookTrustArg(command: string): string {
  const hash = codexHookTrustedHash(command);
  // Set the whole map. A dotted `hooks.state.<key>` override is not equivalent:
  // the CLI path parser splits the literal dot in `config.toml`, leaving this
  // hook untrusted while appearing superficially correct in argv tests.
  return `hooks.state={${tomlQuote(CODEX_SESSION_GUARD_KEY)}={trusted_hash=${tomlQuote(hash)}}}`;
}

export function guardCodexTrustArg(includeToolTelemetry = false): string {
  if (!includeToolTelemetry) return codexHookTrustArg(guardCommand());
  const guardHash = codexHookTrustedHash(guardCommand());
  const toolHash = codexHookTrustedHash(
    toolTelemetryCommand(), "post_tool_use", TOOL_TELEMETRY_TIMEOUT_S,
  );
  return `hooks.state={` +
    `${tomlQuote(CODEX_SESSION_GUARD_KEY)}={trusted_hash=${tomlQuote(guardHash)}},` +
    `${tomlQuote(CODEX_SESSION_TOOL_TELEMETRY_KEY)}={trusted_hash=${tomlQuote(toolHash)}}` +
    `}`;
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
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown", lineName: string,
  // The REAL agent session id, resolved from a context binding by the listener.
  // A caller-supplied context id must never reach this parameter. Sits AFTER
  // lineName so lineName stays the last required parameter — see runAgent.
  resume?: string,
  correlationId?: string,
  toolTelemetryFile?: string,
): SpawnSpec {
  const childEnv = agentChildEnv(process.env);
  const correlationEnv = correlationId ? { AGENTCALL_CORRELATION_ID: correlationId } : {};
  if (kind === "claude") {
    return {
      cmd: resolveBin(kind),
      args: [
        ...(resume ? ["--resume", resume] : []),
        "-p", prompt, "--output-format", "json",
        "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools(envelope),
        "--settings", guardSettingsJson(toolTelemetryFile !== undefined),
      ],
      cwd: workdir,
      env: {
        ...childEnv, ...correlationEnv, AGENTCALL_CALL_ID: callId, AGENTCALL_LINE: lineName,
        AGENTCALL_ALLOWED_ROOT: workdir,
        ...(toolTelemetryFile ? { AGENTCALL_TOOL_TELEMETRY_FILE: toolTelemetryFile } : {}),
      },
    };
  }
  // Codex has no per-tool granularity, so the envelope's write cap maps onto
  // its native sandbox level instead — the codex-side analogue of claude's
  // --allowedTools, and now the only thing confining its writes. Note it does
  // NOT confine reads: `codex exec --sandbox read-only` still reads ~/.ssh.
  const sandbox = envelope.caps.includes("write") ? "workspace-write" : "read-only";
  // --ignore-user-config does not remove Codex's bundled authenticated apps,
  // web search, or image generation. Disable every bundled remote surface on
  // fresh and resumed spawns: no AgentCall task cap grants account mutation or
  // undeclared egress. --strict-config turns a renamed/removed setting into a
  // startup failure instead of silently restoring a surface.
  const codexRemoteBoundary = [
    "--disable", "apps",
    "--disable", "image_generation",
    // 0.146.0's code-mode `exec` wrapper completed a nested shell call without
    // emitting either configured lifecycle hook in the production live probe.
    // Keep Codex on its native exec_command handler, whose stable hook adapter
    // emits the paired canonical Bash events this telemetry relies on.
    ...(toolTelemetryFile ? ["--disable", "code_mode_host"] : []),
    "-c", `web_search="disabled"`,
    "--strict-config",
  ];
  if (resume) {
    // `codex exec resume` accepts neither --sandbox nor --cd (verified against
    // the installed CLI, 2026-08-01). --sandbox is the ONLY thing confining
    // codex's writes, so the envelope rides the -c config override instead;
    // packages/cli/test/codex-resume-sandbox.probe.test.ts is what proves that
    // override is actually honoured. The working directory is inherited from
    // the recorded session, which is why the context binding pins workdir and
    // refuses a resume when it changed.
    return {
      cmd: resolveBin(kind),
      args: ["exec", "resume", resume, "--ignore-user-config", "--skip-git-repo-check",
        "--json", ...codexRemoteBoundary, "-c", guardCodexConfigArg(),
        ...(toolTelemetryFile ? ["-c", toolTelemetryCodexConfigArg()] : []),
        "-c", guardCodexTrustArg(toolTelemetryFile !== undefined),
        "-c", `sandbox_mode="${sandbox}"`, prompt],
      cwd: workdir,
      // AGENTCALL_LINE is as required here as on the non-resume branch: the
      // guard resolves the line's tasksDir from it and fails closed without
      // it, so omitting it would deny every tool call on a resumed session.
      env: {
        ...childEnv, ...correlationEnv, AGENTCALL_CALL_ID: callId,
        AGENTCALL_GUARD_MODE: "observe", AGENTCALL_LINE: lineName,
        ...(toolTelemetryFile ? { AGENTCALL_TOOL_TELEMETRY_FILE: toolTelemetryFile } : {}),
      },
    };
  }
  return {
    cmd: resolveBin(kind),
    // --ignore-user-config drops the owner's ~/.codex: their configured MCP
    // servers and plugins. Those are separate processes that reach the
    // filesystem outside codex's sandbox entirely, so a remote caller could
    // otherwise route around every control here — on a typical dev machine
    // that means a filesystem MCP server, and often `claude mcp serve`, which
    // re-exposes Read and Bash. Claude fences these off with --allowedTools,
    // an allowlist that `mcp__*` names never match. Codex's bundled apps remain
    // loaded even with this flag, so codexRemoteBoundary removes them explicitly.
    // The prompt stays last: codex takes the final positional as the prompt.
    args: ["exec", "--ignore-user-config", "--sandbox", sandbox, "--cd", workdir,
      "--skip-git-repo-check", "--json", "-c", guardCodexConfigArg(),
      ...(toolTelemetryFile ? ["-c", toolTelemetryCodexConfigArg()] : []),
      "-c", guardCodexTrustArg(toolTelemetryFile !== undefined), ...codexRemoteBoundary, prompt],
    cwd: workdir,
    env: {
      ...childEnv, ...correlationEnv, AGENTCALL_CALL_ID: callId,
      AGENTCALL_GUARD_MODE: "observe", AGENTCALL_LINE: lineName,
      ...(toolTelemetryFile ? { AGENTCALL_TOOL_TELEMETRY_FILE: toolTelemetryFile } : {}),
    },
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

// specOverride and signal are given explicit `= undefined` defaults, not `?`,
// so lineName below can be a trailing REQUIRED parameter: TS forbids a
// required parameter from following a `?`-marked one, but not one that
// follows a defaulted one. lineName has no default on purpose — it used to
// (silently defaulting to "", which makes the PreToolUse guard fail closed on
// every tool call, see runner.ts history) — so the only production caller
// (the listener) is forced to pass the real line name or fail to compile,
// instead of a caller forgetting it and getting a silently-broken guard.
export function runAgent(
  kind: AgentKind, prompt: string, workdir: string, timeoutMs: number = AGENT_TIMEOUT_MS,
  specOverride: SpawnSpec | undefined = undefined,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown",
  signal: AbortSignal | undefined = undefined, lineName: string,
  // The REAL agent session id, resolved from a context binding by the
  // listener. A caller-supplied context id must never reach this parameter.
  // Optional, so it goes after the required lineName.
  //
  // Note for a later cleanup (not done here): runAgent now takes twelve
  // positional parameters and should become an options object. That belongs
  // with the #49 work in #48 Phase 1, not in this change.
  resume?: string,
  correlationId?: string,
  toolTelemetryFile?: string,
): Promise<AgentOutput> {
  const spec = specOverride
    ?? buildSpawnSpec(
      kind, prompt, workdir, resolveAgentBin, envelope, callId, lineName, resume, correlationId,
      toolTelemetryFile,
    );
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
    let canceled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, sig); } catch { /* group may already be gone */ }
    };
    const escalate = () => {
      if (killTimer) clearTimeout(killTimer);
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    // Cancellation reuses the existing teardown path: SIGTERM, grace, SIGKILL
    // against the whole process group. The promise still settles from the
    // `exit` handler below, which is what makes "cancelled" mean the process
    // is actually gone rather than that a signal was sent.
    const onAbort = () => {
      if (settled) return;
      canceled = true;
      escalate();
    };
    if (signal) {
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
    }

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
      if (signal) signal.removeEventListener("abort", onAbort);
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
      if (signal) signal.removeEventListener("abort", onAbort);
      if (canceled) return reject(new AgentRunError("canceled", "canceled"));
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
