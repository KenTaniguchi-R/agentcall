import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TIMEOUT_MS, MAX_REPLY_BYTES, type AgentKind } from "@benree/agentcall-shared";
import { resolveAgentBin } from "./bin.js";

export type { AgentKind };

// The exact codex-cli release against which the live resume-sandbox probe
// passed. Threading fails closed on every other version: a CLI upgrade changes
// the security boundary and must be re-probed before resumed sessions are
// trusted again.
export const CODEX_THREADING_VERIFIED_VERSION = "0.146.0";

// Kept separate from the threading and guard-trust pins: evidence for either
// must not silently bless incomplete default-path lifecycle coverage.
// No release is currently verified. The 0.146.0 production probe reached its
// default code-mode tool path without emitting either lifecycle hook, so tool
// telemetry stays off rather than changing Codex's available tools.
export const CODEX_HOOK_TRUST_VERIFIED_VERSION = "none";

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

// A resume the agent CLI can no longer honour: the recorded session is gone —
// pruned, written by a since-upgraded CLI, or never durable in the first place.
// Conversation state lives in claude's/codex's own session store, which
// AgentCall neither owns nor prunes, so an admitted binding can still fail at
// spawn. That reaches the listener as a plain AgentRunError and used to be
// reported to the caller as "the agent hit an internal error", which points at
// the wrong thing entirely: the conversation ended, the agent is fine.
//
// Probed 2026-08-05 against the installed binaries. Both exit 1 with an empty
// stdout and the text on stderr, which runAgent folds into `agent exited 1:`:
//   claude: No conversation found with session ID: <id>
//   codex:  Error: thread/resume: thread/resume failed: no rollout found for
//           thread id <id> (code -32600)
// String-matching a CLI's error text is the same shape as classifyAgentFailure
// (verify.ts) and carries the same maintenance risk: a reworded message
// degrades to the old "agent_error", which is the safe direction to fail.
//
// The listener consults this ONLY when it actually passed a resume, which is
// what bounds it. A caller who talks the agent into printing this text on a
// failing turn can therefore only get their OWN conversation dropped — no
// other caller's binding is reachable, and nothing is granted.
export function isResumeFailure(kind: AgentKind, error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error);
  return kind === "claude"
    ? /no conversation found with session id/i.test(msg)
    : /no rollout found for thread id|thread\/resume failed/i.test(msg);
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
// is ~48ms (#377, re-measured 2026-08-06; ~33ms before #372 put zod in
// guard-entry's graph), so the bias is roughly 600x, not 900x. Still no reason
// to touch this number.
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

// Exported so doctor's direct probe invokes the exact file the spawn wires up,
// rather than a second path expression that could drift from this one.
export const guardEntryPath = () => fileURLToPath(new URL("./guard-entry.js", import.meta.url));

const guardCommand = () =>
  `${shellQuote(process.execPath)} ${shellQuote(guardEntryPath())}`;

export function guardSettingsJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        hooks: [{ type: "command", command: guardCommand(), timeout: GUARD_TIMEOUT_S }],
      }],
    },
  });
}


// Codex takes hooks as configuration rather than as a settings blob, and `-c`
// is the only form scoped to a single spawn — the alternatives
// ($CODEX_HOME/hooks.json, the project .codex/) would edit configuration the
// owner keeps, which claude's inline --settings deliberately avoids.
//
// This registers the SAME entry point as claude, but Codex runs it in observe
// mode. Its command-shaped filesystem surface cannot be safely bounded here.
export 

// Codex executes a hook only when its normalized identity matches a trusted
// hash. Trusting every hook would also execute hooks from the owner's config,
// project, plugins, and managed layers outside the tool sandbox. Instead,
// reproduce codex-cli 0.146.0's canonical identity for this one session hook
// and supply trust for its exact synthetic key. A CLI-side normalization
// change makes the hash mismatch and fails closed (the hook is skipped).

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




// Used with --allowedTools + --permission-mode dontAsk: listed tools are
// pre-approved, everything else is denied instead of prompting (headless -p
// can't prompt).
//
// Fixed and read-only (#372). A call answers a question and the reply is the
// only sink, so there is nothing for Write, Edit or Bash to be granted FOR.
// WebSearch and http(s)-only WebFetch are included because an answering agent
// is expected to use the owner's real research tools; guard.ts rejects other
// WebFetch schemes. Local mutation tools remain outside this list.
export const CLAUDE_READ_ONLY_TOOLS = [
  "Read", "Grep", "Glob", "LS", "Skill", "ToolSearch", "WebSearch", "WebFetch",
] as const;

// A server name is pasted into an allowlist entry, so it has to be a single
// safe segment. A name carrying a comma would split into a SECOND entry and
// grant a tool nobody enumerated; one carrying `*` would widen the server
// segment, which the permission syntax requires to be glob-free. Anything not
// matching is dropped rather than escaped — a server we cannot name safely is
// one the caller does without.
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The tools a call may use.
 *
 * Fixed and read-only for the built-ins (#372): a call answers a question and
 * the reply is the only sink, so there is nothing for Write, Edit or Bash to be
 * granted FOR. Opening reads on 2026-08-07 deliberately did NOT open those — a
 * caller's message must not be able to change the owner's machine.
 * WebFetch/WebSearch are included as explicit remote research capabilities;
 * the guard still restricts WebFetch to http(s).
 *
 * `mcpServers` is enumerated from the owner's own configuration at spawn time,
 * not typed by anyone. It has to be enumerated because **`mcp__*` is not
 * expressible**: allow rules accept a glob only after a literal
 * `mcp__<server>__` prefix, and the server segment must be glob-free.
 *
 * `Skill` is listed for completeness rather than for effect — measured
 * 2026-08-06, `--allowedTools` does not gate Skill at all. What actually decides
 * a skill is guard.ts's Skill branch.
 */
/**
 * The MCP servers the owner has already configured, from `~/.claude.json`.
 *
 * Split from the file read so the parsing is testable and so a broken or
 * half-written config cannot take a line offline: every failure returns the
 * empty list, which grants nothing. A caller-facing spawn must not fail because
 * the owner has no MCP set up.
 *
 * Note the asymmetry with the sensitivity map: servers are granted here, by
 * enumeration into the allowlist, rather than labelled. A label on an opaque
 * server would be a promise the guard cannot keep — it never sees that server's
 * I/O — so there is deliberately no `classifyMcp`.
 */
export function mcpServerNamesFrom(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as {
      mcpServers?: unknown;
      claudeAiMcpEverConnected?: unknown;
    };
    const servers = parsed.mcpServers;
    const configured = servers !== null && typeof servers === "object" && !Array.isArray(servers)
      ? Object.keys(servers)
      : [];
    const hosted = Array.isArray(parsed.claudeAiMcpEverConnected)
      ? parsed.claudeAiMcpEverConnected
        .filter((name): name is string => typeof name === "string" && name.startsWith("claude.ai "))
        .map((name) => name.replace(/[^A-Za-z0-9_-]/g, "_"))
      : [];
    return [...new Set([...configured, ...hosted])];
  } catch {
    return [];
  }
}

type ReadText = (path: string) => string;

function mcpConfigServerNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: unknown } & Record<string, unknown>;
    const servers = parsed.mcpServers ?? parsed;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return [];
    return Object.keys(servers).filter((name) => MCP_SERVER_NAME_RE.test(name));
  } catch {
    return [];
  }
}

/** MCP server allowlist segments contributed by installed Claude plugins. */
export function pluginMcpServerNamesFrom(raw: string, read: ReadText): string[] {
  try {
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    if (parsed.plugins === null || typeof parsed.plugins !== "object" || Array.isArray(parsed.plugins)) return [];
    const names = new Set<string>();

    for (const [pluginId, value] of Object.entries(parsed.plugins as Record<string, unknown>)) {
      const pluginName = pluginId.split("@", 1)[0]!;
      if (!MCP_SERVER_NAME_RE.test(pluginName)) continue;
      const installs = Array.isArray(value) ? value : [value];
      for (const install of installs) {
        if (install === null || typeof install !== "object") continue;
        const installPath = (install as { installPath?: unknown }).installPath;
        if (typeof installPath !== "string" || installPath === "") continue;

        const add = (serverNames: readonly string[]) => {
          for (const serverName of serverNames) names.add(`plugin_${pluginName}_${serverName}`);
        };
        for (const manifestPath of [
          join(installPath, ".claude-plugin", "plugin.json"),
          join(installPath, "plugin.json"),
        ]) {
          try {
            const manifest = JSON.parse(read(manifestPath)) as { mcpServers?: unknown };
            if (typeof manifest.mcpServers === "string") {
              add(mcpConfigServerNames(read(join(installPath, manifest.mcpServers))));
            } else if (manifest.mcpServers !== null && typeof manifest.mcpServers === "object" &&
              !Array.isArray(manifest.mcpServers)) {
              add(Object.keys(manifest.mcpServers).filter((name) => MCP_SERVER_NAME_RE.test(name)));
            }
          } catch {
            // A plugin without this optional manifest shape contributes no MCP.
          }
        }
        try {
          add(mcpConfigServerNames(read(join(installPath, ".mcp.json"))));
        } catch {
          // Most plugins do not bundle an MCP config.
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

export function discoverMcpServers(
  userHome: string,
  read: ReadText = (path) => readFileSync(path, "utf8"),
): string[] {
  const names: string[] = [];
  try {
    names.push(...mcpServerNamesFrom(read(join(userHome, ".claude.json"))));
  } catch {
    // The owner may have no user-level or hosted MCP configuration.
  }
  try {
    const installed = read(join(userHome, ".claude", "plugins", "installed_plugins.json"));
    names.push(...pluginMcpServerNamesFrom(installed, read));
  } catch {
    // The owner may have no installed Claude plugins.
  }
  return [...new Set(names)];
}

export function claudeAllowedTools(mcpServers: readonly string[] = []): string {
  const servers = mcpServers
    .filter((s) => MCP_SERVER_NAME_RE.test(s))
    .map((s) => `mcp__${s}__*`);
  return [...CLAUDE_READ_ONLY_TOOLS, ...servers].join(",");
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
export interface SpawnOptions {
  kind: AgentKind;
  prompt: string;
  workdir: string;
  /** The line this call came in on. The PreToolUse guard fails closed without it. */
  lineName: string;
  resolveBin?: (kind: AgentKind) => string;
  callId?: string;
  /**
   * The REAL agent session id, resolved from a context binding by the listener.
   * A caller-supplied context id must never reach this field.
   */
  resume?: string;
  correlationId?: string;
  /**
   * MCP servers this call may use, enumerated from the owner's own config by
   * the listener (see discoverMcpServers). Empty grants none — `mcp__*` is not
   * expressible, so an unlisted server is simply unreachable.
   */
  mcpServers?: readonly string[];
}

// An options object, not positionals. This used to take ten in a fixed order,
// with `lineName` and `clearance` both required and both sitting after
// defaulted parameters to force callers to pass them. Inside one branch the
// index of `resume` moved twice and two separate edits silently slid a value
// into the wrong slot -- a resume id landing in `clearance`, and before that
// the swap `decide()` warned about. Named fields make every one of those a
// compile error instead of a runtime surprise.
export function buildSpawnSpec(options: SpawnOptions): SpawnSpec {
  const {
    kind, prompt, workdir, lineName,
    resolveBin = resolveAgentBin, callId = "unknown", resume, correlationId,
    mcpServers = [],
  } = options;
  const childEnv = process.env;
  const correlationEnv = correlationId ? { AGENTCALL_CORRELATION_ID: correlationId } : {};
  if (kind === "claude") {
    return {
      cmd: resolveBin(kind),
      args: [
        ...(resume ? ["--resume", resume] : []),
        "-p", prompt, "--output-format", "json",
        "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools(mcpServers),
        "--settings", guardSettingsJson(),
      ],
      cwd: workdir,
      env: {
        ...childEnv, ...correlationEnv, AGENTCALL_CALL_ID: callId, AGENTCALL_LINE: lineName,
        // Replaces AGENTCALL_ALLOWED_ROOT. The guard no longer confines the run
        // to one directory; it asks whether each path's sensitivity is within
        // this clearance, which the sensitivity map on disk answers.
      },
    };
  }
  // Codex has no per-tool granularity, so it gets its sandbox level instead —
  // the codex-side analogue of claude's --allowedTools, and the only thing
  // confining its writes. Always read-only now. Note it does
  // NOT confine reads: `codex exec --sandbox read-only` still reads ~/.ssh.
  const sandbox = "read-only";
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
      args: ["exec", "resume", resume, "--skip-git-repo-check", "--json",
        "-c", `sandbox_mode="${sandbox}"`, prompt],
      cwd: workdir,
      // AGENTCALL_LINE is as required here as on the non-resume branch: the
      // guard resolves the line's tasksDir from it and fails closed without
      // it, so omitting it would deny every tool call on a resumed session.
      env: {
        ...childEnv, ...correlationEnv, AGENTCALL_CALL_ID: callId, AGENTCALL_LINE: lineName,
      },
    };
  }
  return {
    cmd: resolveBin(kind),
    // Load the owner's normal Codex configuration so an answered call can use
    // their MCP servers, skills, apps, web, and image tools. MCP processes may
    // hold authority beyond Codex's own sandbox; that delegated authority is an
    // explicit part of AgentCall's default tool-access model.
    // The prompt stays last: codex takes the final positional as the prompt.
    args: ["exec", "--sandbox", sandbox, "--cd", workdir,
      "--skip-git-repo-check", "--json", prompt],
    cwd: workdir,
    env: {
      ...childEnv, ...correlationEnv, AGENTCALL_CALL_ID: callId, AGENTCALL_LINE: lineName,
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
export interface RunOptions extends SpawnOptions {
  timeoutMs?: number;
  specOverride?: SpawnSpec;
  signal?: AbortSignal;
}

export function runAgent(options: RunOptions): Promise<AgentOutput> {
  const { kind, timeoutMs = AGENT_TIMEOUT_MS, specOverride, signal } = options;
  const spec = specOverride ?? buildSpawnSpec(options);
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
