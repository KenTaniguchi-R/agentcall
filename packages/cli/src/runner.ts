import { spawn } from "node:child_process";
import { AGENT_TIMEOUT_MS, MAX_REPLY_BYTES } from "@agentcall/shared";
import { ensureDenyWriteTargetsExist, resolveAgentBin, writeSrtSettings } from "./srt.js";
import type { Paths } from "./paths.js";

export type AgentKind = "claude" | "codex";
export interface SpawnSpec { cmd: string; args: string[]; cwd: string }
export interface AgentOutput { text: string; session_id?: string }

export class AgentRunError extends Error {
  constructor(message: string, public code: "timeout" | "agent_error") { super(message); }
}

// Cap on accumulated stdout while an agent is running, independent of the
// final MAX_REPLY_BYTES truncation applied to the parsed reply text — this
// bounds memory for a runaway/malicious process that never stops writing.
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
// Grace period between SIGTERM and SIGKILL when tearing down an agent's
// process group (on timeout or stdout overflow).
const KILL_GRACE_MS = 10_000;

// resolveBin is injectable for tests (default resolveAgentBin resolves the
// real binary via PATH). Production callers should leave it as the default:
// a bare "claude"/"codex" arg fails inside srt's sandboxed shell, which
// can't resolve PATH the way an interactive shell does ("command not
// found", exit 127, confirmed against a real sandboxed spawn) — the
// resolved absolute path sidesteps that entirely.
export function buildSpawnSpec(
  kind: AgentKind, prompt: string, p: Paths, resolveBin: (kind: AgentKind) => string = resolveAgentBin,
): SpawnSpec {
  if (kind === "claude") {
    return {
      cmd: "npx",
      args: ["-y", "@anthropic-ai/sandbox-runtime", "--settings", p.srtFile, "--",
        resolveBin(kind), "-p", prompt, "--output-format", "json"],
      cwd: p.publicDir,
    };
  }
  // codex's own --sandbox only confines writes, not reads — without srt a
  // malicious prompt could read ~/.agentcall/config.json (the relay token)
  // or ~/.ssh and exfiltrate it via the reply. Wrap codex in srt too so both
  // agent kinds get the same read protection; codex's native sandbox still
  // handles write confinement inside publicDir.
  return {
    cmd: "npx",
    args: ["-y", "@anthropic-ai/sandbox-runtime", "--settings", p.srtFile, "--",
      resolveBin(kind), "exec", "--sandbox", "workspace-write", "--cd", p.publicDir, "--skip-git-repo-check", "--json", prompt],
    cwd: p.publicDir,
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
  kind: AgentKind, prompt: string, p: Paths, timeoutMs: number = AGENT_TIMEOUT_MS, specOverride?: SpawnSpec,
): Promise<AgentOutput> {
  // Real spawn (no test override): make sure srt's denyWrite targets exist
  // before the sandbox starts — see srt.ts, denyWrite silently no-ops for
  // paths that aren't there yet — and rewrite srt.json with the current
  // toolchain's read dirs (see srt.ts's toolchainReadDirs) so a node/npm-
  // manager upgrade since `setup` doesn't leave a stale allowlist that
  // denies the sandboxed process its own binary. Both skipped for
  // specOverride so unit tests never touch the real ~/.claude or srt.json.
  if (!specOverride) {
    ensureDenyWriteTargetsExist();
    writeSrtSettings(p, kind);
  }
  const spec = specOverride ?? buildSpawnSpec(kind, prompt, p);
  return new Promise((resolve, reject) => {
    // detached: true makes the child its own process group leader, so any
    // grandchildren it forks (sandbox-exec, the actual claude/codex
    // process, ...) share its process group unless they detach themselves.
    // That lets us tear down the whole tree with one signal to -pid instead
    // of leaving orphans that hold the stdout pipe open or keep running
    // past the timeout.
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
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
      stdout += d;
    });
    child.stderr.on("data", (d) => (stderr += d));

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
      if (code !== 0) return reject(new AgentRunError(`agent exited ${code}: ${stderr.slice(0, 2000)}`, "agent_error"));
      try {
        const out = kind === "claude" ? parseClaudeJson(stdout) : parseCodexJsonl(stdout);
        resolve({ ...out, text: truncateUtf8(out.text, MAX_REPLY_BYTES) });
      } catch (e) {
        reject(new AgentRunError(`could not parse agent output: ${String(e)}`, "agent_error"));
      }
    });
  });
}
