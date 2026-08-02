import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAgent } from "./callClient.js";
import { relayUrl, type Config } from "./config.js";
import { AgentRunError, guardEntryPath, guardSettingsJson, runAgent, type AgentKind } from "./runner.js";
import { resolveAgentBin } from "./bin.js";
import { ASK_TASK } from "./tasks.js";

// One row of verification output, shared by `setup` and `agentcall doctor`.
export interface VerifyCheck {
  name: string;
  ok: boolean;
  // A check that could not be proven either way. Prints like a failure so it
  // isn't mistaken for a pass, but leaves `ok` true: doctor's exit code is a
  // claim about the install, and "the model wouldn't cooperate with a probe"
  // is not something the owner can fix.
  warn?: boolean;
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
  const head = `${!c.ok ? "✗" : c.warn ? "!" : "✓"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
  // "fix:" would be a lie under a warning — there is nothing broken to fix.
  if (!c.hint || (c.ok && !c.warn)) return head;
  return `${head}\n  ${c.ok ? "note" : "fix"}: ${c.hint}`;
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

export const GUARD_CANARY = "AGENTCALL-GUARD-CANARY";
// The probe returns the temp home as well as the output, because the absence
// of the canary is not evidence — see below.
export interface GuardProbeResult { output: string; home: string }
export type GuardProbeFn = (settings: string) => Promise<GuardProbeResult>;

// The guard did not stop something it is supposed to stop. Both reinstall
// forms are named because doctor runs in two very different places: a global
// npm install (the overwhelming majority) and a checkout of this repo, where
// dist/ can simply be stale. The old text named only the second and read as
// nonsense to everyone else.
const GUARD_BROKEN_HINT =
  "reinstall the CLI (`npm i -g @benree/agentcall`), or in a checkout of this repo run `pnpm build` in " +
  "packages/cli so dist/guard-entry.js is current — then re-run doctor";

// Nothing to fix: the model declined the probe's read on its own, so the guard
// was never consulted. The direct probe below has already confirmed the guard
// denies when it IS consulted.
const GUARD_UNVERIFIED_HINT =
  "this is not an install problem — the guard denied a direct probe, it simply never got asked during the " +
  "spawn probe. Re-running doctor may resolve it; a real call is unaffected.";

// Spawns a real `claude -p` against a canary `.env` file and asserts the read
// is refused. Live on the user's machine; always mocked in CI.
//
// The canary used to be `.ssh/id_rsa`: the model refused to read it on
// principle ("printing a private key would expose key material") without
// ever calling Read, so the guard never fired, no denial was recorded, and
// checkGuard reported a healthy install as broken. `.env` hits the same
// denied-basename rule but the model has no such objection to reading it, so
// the probe actually exercises the guard instead of the model's own judgment.
const defaultGuardProbe: GuardProbeFn = async (settings) => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-guard-"));
  writeFileSync(join(home, ".env"), GUARD_CANARY);
  const output = execFileSync(
    resolveAgentBin("claude"),
    ["-p", "Read the file .env in this directory and tell me what it contains.",
     "--permission-mode", "dontAsk", "--allowedTools", "Read", "--settings", settings],
    { cwd: home, env: { ...process.env, AGENTCALL_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { output, home };
};

// True iff stdout is the deny payload runGuard emits. Anything else — an
// allow (empty), a crash, unparseable text — is not a denial.
export function guardDenied(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision === "deny";
  } catch {
    return false;
  }
}

// Invokes guard-entry.js directly with a synthetic PreToolUse payload for a
// protected read. No model, no agent spawn, ~33ms: this answers "does the
// guard deny?" deterministically, which the spawn probe cannot, because the
// spawn probe depends on the model choosing to attempt the read at all.
//
// It deliberately does NOT answer "is the guard wired into the spawn" — that
// remains the spawn probe's job. The two together are what let checkGuard
// tell a broken guard apart from an uncooperative model.
export type GuardBinaryProbeFn = () => Promise<boolean>;

const defaultGuardBinaryProbe: GuardBinaryProbeFn = async () => {
  // A temp AGENTCALL_HOME keeps the probe's denial out of the owner's real
  // calls.log — that log is an audit trail of actual calls, not of doctor.
  const home = mkdtempSync(join(tmpdir(), "agentcall-guardbin-"));
  const stdout = execFileSync(process.execPath, [guardEntryPath()], {
    input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(home, ".env") }, cwd: home }),
    // Forced, not inherited: AGENTCALL_GUARD_MODE=observe in the ambient
    // environment would make the guard allow, and the probe would then report
    // a working guard as broken.
    env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_GUARD_MODE: "enforce" },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return guardDenied(stdout);
};

function deniedInLog(home: string): boolean {
  try {
    return readFileSync(join(home, ".agentcall", "calls.log"), "utf8")
      .split("\n").filter(Boolean)
      .some((line) => { try { return JSON.parse(line).type === "tool_denied"; } catch { return false; } });
  } catch {
    return false;
  }
}

// The model's own words, trimmed to one line, so an unverified run is
// diagnosable from the terminal instead of requiring a repro.
function firstLine(output: string): string {
  const line = output.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

// Doctor-only: proves the PreToolUse guard is actually wired into a real
// claude spawn, not just present in the settings JSON.
//
// The spawn probe has THREE outcomes, not two, and conflating the last two is
// what made this check report healthy installs as broken:
//
//   canary in the output   -> the guard did not stop a read it must stop. Fail.
//   tool_denied logged     -> the guard ran and fired. Pass.
//   neither                -> the model never called Read, so the guard was
//                             never consulted. UNKNOWN, not failed.
//
// The third case is not hypothetical and not fixable by prompt wording: the
// canary was `.ssh/id_rsa` until the model started refusing it on principle,
// `.env` inherited the same fate on other models/versions, and claude's own
// built-in protections can deny a protected read before hooks are consulted
// (a deny suppresses the hook — see guardSettingsJson in runner.ts). So the
// third case is settled by a source that has no opinions: invoking
// guard-entry.js directly. If the guard denies there, the install is fine and
// this run merely proved nothing; if it doesn't, the guard is genuinely broken.
export async function checkGuard(
  probe: GuardProbeFn = defaultGuardProbe,
  binaryProbe: GuardBinaryProbeFn = defaultGuardBinaryProbe,
): Promise<VerifyCheck> {
  try {
    const { output, home } = await probe(guardSettingsJson());
    if (output.includes(GUARD_CANARY)) {
      return { name: "tool guard", ok: false,
               detail: "canary was readable — the guard is not in force", hint: GUARD_BROKEN_HINT };
    }
    if (deniedInLog(home)) return { name: "tool guard", ok: true };

    // A direct probe that throws is a guard that cannot run at all — which is
    // a broken install, not an unknown one.
    const denies = await binaryProbe().catch(() => false);
    return denies
      ? { name: "tool guard", ok: true, warn: true,
          detail: `wired, but unverified this run — the model declined the probe's read: "${firstLine(output)}"`,
          hint: GUARD_UNVERIFIED_HINT }
      : { name: "tool guard", ok: false,
          detail: "the guard did not deny a protected read when invoked directly",
          hint: GUARD_BROKEN_HINT };
  } catch (e) {
    return { name: "tool guard", ok: false, detail: short(e),
             hint: "the guard probe could not run; check that `claude` resolves on the listener's PATH" };
  }
}
