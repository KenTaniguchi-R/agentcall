import { execFileSync } from "node:child_process";
import { callAgent } from "./callClient.js";
import { relayUrl, type Config } from "./config.js";
import { AgentRunError, runAgent, type AgentKind } from "./runner.js";
import { resolveAgentBin } from "./bin.js";
import { ASK_TASK } from "./tasks.js";

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
    "the agent binary wasn't found when spawned — see setup's PATH warning: " +
    "symlink the binary into /opt/homebrew/bin so the background listener can find it.",
  timeout: "the agent started but didn't finish in time — check your network, then try again.",
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
      ? /invalid api key|please run \/login|authentication_error|oauth token has expired|not logged in/i
      : /token_invalidated|not logged in|codex login|\b401\b/i;
  if (authRe.test(msg)) return kind === "claude" ? HINTS.claudeAuth : HINTS.codexAuth;
  return undefined;
}

// Truncated, single-line error text for a check's detail field. Shared with
// doctor.ts.
export const short = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 300);

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
// caught by checkAgentSpawn.
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

export const VERIFY_PROMPT = "Reply with exactly: OK";
// Generous vs the observed ~10-25s of a healthy run, far below AGENT_TIMEOUT_MS:
// a verification hang should fail in 2 minutes, not 5.
export const VERIFY_TIMEOUT_MS = 120_000;

// The real thing: the byte-identical spawn path an inbound call uses. A
// successfully parsed reply is the pass signal — the reply text is NOT
// asserted, since chatty models don't reliably echo "OK" verbatim. Runs
// under the same read-only "ask" envelope a real inbound plain call gets —
// not the FULL_ACCESS_ENVELOPE default — since verification must not exercise
// more capability than an untrusted caller would actually be granted.
export async function checkAgentSpawn(
  kind: AgentKind, workdir: string, runFn: typeof runAgent = runAgent,
): Promise<VerifyCheck> {
  try {
    await runFn(kind, VERIFY_PROMPT, workdir, VERIFY_TIMEOUT_MS, undefined, ASK_TASK.envelope);
    return { name: "agent run", ok: true };
  } catch (e) {
    return { name: "agent run", ok: false, detail: short(e), hint: classifyAgentFailure(kind, e) };
  }
}

// Injection seams for tests and for setup/doctor callers; production leaves
// all three unset (same pattern as SetupOpts.installLaunchAgentFn).
export interface VerifyFns {
  runFn?: typeof runAgent;
  execFn?: ExecFn;
  resolveBin?: (kind: AgentKind) => string;
}

// The binary -> codex-auth -> agent-spawn ladder shared by setup and
// doctor. Stops at the first failure: a failed pre-check must not burn a
// model call, and the user should see the first broken layer, not a cascade.
export async function verifyAgent(kind: AgentKind, workdir: string, fns: VerifyFns = {}): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [checkAgentBinary(kind, fns.resolveBin)];
  if (!checks[0].ok) return checks;
  if (kind === "codex") {
    const auth = checkCodexAuth(fns.execFn);
    checks.push(auth);
    if (!auth.ok) return checks;
  }
  checks.push(await checkAgentSpawn(kind, workdir, fns.runFn));
  return checks;
}

// Doctor-only, end-to-end: a real call to our own address through the relay
// and the launchd-spawned listener. This is the only check that exercises
// the listener's environment (fixed PATH, no shell rc, possibly locked
// keychain) — a direct checkAgentSpawn from an interactive shell can pass
// while this fails. Works under the default policy because the built-in
// "ask" task always exists.
export async function checkRelaySelfCall(cfg: Config, callFn: typeof callAgent = callAgent): Promise<VerifyCheck> {
  try {
    await callFn({
      relay: relayUrl(cfg),
      from: cfg.handle,
      token: cfg.token,
      to: cfg.handle,
      message: "agentcall doctor self-test: reply briefly",
      // Bound below callAgent's 420s default: the spawn budget plus a
      // margin for relay round-trip, so a stuck self-call fails promptly
      // instead of hanging the whole doctor run.
      timeoutMs: VERIFY_TIMEOUT_MS + 30_000,
    });
    return { name: "relay self-call", ok: true };
  } catch (e) {
    return {
      name: "relay self-call",
      ok: false,
      detail: short(e),
      hint:
        "a direct agent run works but the call through the background listener failed — its environment " +
        "differs from your shell (fixed PATH, no shell env, keychain); check ~/.agentcall/listener.log and calls.log.",
    };
  }
}
