import { spawn } from "node:child_process";
import { MAX_REPLY_BYTES } from "@agentcall/shared";
import type { Paths } from "./paths.js";

export type AgentKind = "claude" | "codex";
export interface SpawnSpec { cmd: string; args: string[]; cwd: string }
export interface AgentOutput { text: string; session_id?: string }

export class AgentRunError extends Error {
  constructor(message: string, public code: "timeout" | "agent_error") { super(message); }
}

export function buildSpawnSpec(kind: AgentKind, prompt: string, p: Paths): SpawnSpec {
  if (kind === "claude") {
    return {
      cmd: "npx",
      args: ["-y", "@anthropic-ai/sandbox-runtime", "--settings", p.srtFile, "--",
        "claude", "-p", prompt, "--output-format", "json"],
      cwd: p.publicDir,
    };
  }
  return {
    cmd: "codex",
    args: ["exec", "--sandbox", "workspace-write", "--cd", p.publicDir, "--skip-git-repo-check", "--json", prompt],
    cwd: p.publicDir,
  };
}

export function parseClaudeJson(stdout: string): AgentOutput {
  const parsed = JSON.parse(stdout.trim()) as { result?: string; session_id?: string; is_error?: boolean };
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

export function runAgent(
  kind: AgentKind, prompt: string, p: Paths, timeoutMs: number, specOverride?: SpawnSpec,
): Promise<AgentOutput> {
  const spec = specOverride ?? buildSpawnSpec(kind, prompt, p);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(new AgentRunError(String(e), "agent_error")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new AgentRunError(`agent timed out after ${timeoutMs}ms`, "timeout"));
      if (code !== 0) return reject(new AgentRunError(`agent exited ${code}: ${stderr.slice(0, 2000)}`, "agent_error"));
      try {
        const out = kind === "claude" ? parseClaudeJson(stdout) : parseCodexJsonl(stdout);
        resolve({ ...out, text: out.text.slice(0, MAX_REPLY_BYTES) });
      } catch (e) {
        reject(new AgentRunError(`could not parse agent output: ${String(e)}`, "agent_error"));
      }
    });
  });
}
