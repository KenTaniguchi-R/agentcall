import { execFileSync } from "node:child_process";
import { AgentRunError, type AgentKind } from "./runner.js";
import { resolveAgentBin } from "./srt.js";

// One row of verification output, shared by `setup` and `agentcall doctor`.
export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export const HINTS = {
  claudeAuth:
    "claude is not authenticated for headless runs — run `claude` interactively and complete /login " +
    "(or run `claude setup-token`, or set ANTHROPIC_API_KEY).",
  codexAuth: "codex is not authenticated — run `codex login` (on a headless machine: `codex login --device-auth`).",
  pathMissing:
    "the agent binary wasn't found inside the sandbox — see setup's PATH warning: " +
    "symlink the binary into /opt/homebrew/bin so the background listener can find it.",
  timeout: "the agent started but didn't finish in time — check srt.json's network allowlist, then try again.",
} as const;

// Maps a runAgent failure to an actionable fix. Auth failures reach us in
// kind-specific shapes: claude -p exits 0 with is_error:true JSON (runner
// wraps the parse throw), codex exits nonzero with the error on stderr —
// both end up as AgentRunError messages, so one string classifier covers
// both. Order matters: timeout and exit-127 are kind-independent and must
// win over the auth patterns (codex's `\b401\b` could otherwise match an
// unrelated exit-127 line that happens to contain 401).
export function classifyAgentFailure(kind: AgentKind, error: unknown): string | undefined {
  if (error instanceof AgentRunError && error.code === "timeout") return HINTS.timeout;
  const msg = String(error instanceof Error ? error.message : error);
  if (/exited 127|command not found/i.test(msg)) return HINTS.pathMissing;
  const authRe =
    kind === "claude"
      ? /invalid api key|please run \/login|authentication_error|oauth token has expired/i
      : /token_invalidated|not logged in|codex login|\b401\b/i;
  if (authRe.test(msg)) return kind === "claude" ? HINTS.claudeAuth : HINTS.codexAuth;
  return undefined;
}

// Truncated, single-line error text for a check's detail field.
const short = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

export function checkAgentBinary(kind: AgentKind, resolveBin: (kind: AgentKind) => string = resolveAgentBin): VerifyCheck {
  try {
    return { name: "agent binary", ok: true, detail: resolveBin(kind) };
  } catch (e) {
    return { name: "agent binary", ok: false, detail: short(e) };
  }
}

export type ExecFn = (cmd: string, args: string[]) => void;

const defaultExec: ExecFn = (cmd, args) => {
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

// codex-only fast path: `codex login status` is free (no model call) and
// exits nonzero when logged out, so codex users learn about missing auth
// without burning a spawn. claude has no equivalent — its auth failures are
// caught by checkSandboxSpawn.
export function checkCodexAuth(execFn: ExecFn = defaultExec): VerifyCheck {
  try {
    execFn("codex", ["login", "status"]);
    return { name: "codex auth", ok: true };
  } catch (e) {
    return { name: "codex auth", ok: false, detail: short(e), hint: HINTS.codexAuth };
  }
}

export function formatCheck(c: VerifyCheck): string {
  const head = `${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
  return !c.ok && c.hint ? `${head}\n  fix: ${c.hint}` : head;
}
