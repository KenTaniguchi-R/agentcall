import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAgent } from "./callClient.js";
import { relayUrl, type LineConfig } from "./config.js";
import { getLinePaths, getMachinePaths, type LinePaths } from "./paths.js";
import {
  AgentRunError, buildSpawnSpec, CODEX_SESSION_GUARD_KEY, CODEX_SESSION_TOOL_TELEMETRY_KEY,
  guardCodexConfigArg, guardCodexTrustArg, guardEntryPath, guardSettingsJson, runAgent,
  toolTelemetryCodexConfigArg, type AgentKind,
} from "./runner.js";
import { resolveAgentBin } from "./bin.js";
import { ASK_TASK } from "./tasks.js";
import { agentChildEnv } from "./telemetry-env.js";

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
    "the agent binary wasn't found when spawned — install it in a durable PATH directory, " +
    "then re-run `agentcall setup` to rebuild the background listener's PATH.",
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

export type CodexGuardProbeFn = (args: string[], input: string, cwd: string) => Promise<string>;

export interface CodexGuardTransportOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  tempRoot?: string;
}

// Run one bounded JSONL exchange with app-server. CODEX_HOME is intentionally
// empty: inbound `codex exec --ignore-user-config` does not load the owner's
// config.toml, so doctor must not inspect or initialize that different graph.
// System requirements and managed layers remain machine-wide and still apply.
// Production can separately discover $CODEX_HOME/hooks.json despite that flag;
// it is intentionally absent here because foreign hooks cannot establish the
// exact session-key invariant (and their non-inheritance is probed separately).
export function runCodexGuardProbe(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  options: CodexGuardTransportOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const killGraceMs = options.killGraceMs ?? 1_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const codexHome = mkdtempSync(join(options.tempRoot ?? tmpdir(), "agentcall-codex-doctor-"));
  const detached = process.platform !== "win32";

  try {
    const child = spawn(bin, args, {
      // hooks/list is the only output we consume. Discard stderr so a managed
      // config diagnostic cannot leak through doctor or fill an unread pipe.
      cwd,
      detached,
    env: { ...agentChildEnv(process.env), CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "ignore"],
    });

    return new Promise((resolve, reject) => {
      let output = "";
      let stopping = false;
      let stopError: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;

      const signalTree = (signal: NodeJS.Signals) => {
        if (detached && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch { /* fall back to the direct child below */ }
        }
        try { child.kill(signal); } catch { /* close/error settles the probe */ }
      };
      const stop = (error?: Error) => {
        if (stopping) return;
        stopping = true;
        stopError = error;
        clearTimeout(timeoutTimer);
        try { child.stdin.end(); } catch { /* termination below is authoritative */ }
        signalTree("SIGTERM");
        forceTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
      };
      const timeoutTimer = setTimeout(
        () => stop(new Error("codex app-server hooks/list timed out")),
        timeoutMs,
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stopping) return;
        output += chunk;
        if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
          stop(new Error(`codex app-server hooks/list response exceeded ${maxOutputBytes} bytes`));
          return;
        }
        const responded = output.split("\n").some((line) => {
          try { return (JSON.parse(line) as { id?: number }).id === 2; }
          catch { return false; }
        });
        if (responded) stop();
      });
      child.on("error", (error) => stop(error));
      child.on("close", (code) => {
        clearTimeout(timeoutTimer);
        if (forceTimer) clearTimeout(forceTimer);
        // The group leader can exit before a TERM-ignoring helper. One final
        // group KILL prevents a surviving code-mode host on supported systems.
        if (detached) signalTree("SIGKILL");
        let cleanupError: Error | undefined;
        try { rmSync(codexHome, { recursive: true, force: true }); }
        catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        }
        if (!stopping) {
          reject(new Error(`codex app-server exited ${code ?? "without a status"} before hooks/list responded`));
        } else if (stopError) {
          reject(stopError);
        } else if (cleanupError) {
          reject(cleanupError);
        } else {
          resolve(output);
        }
      });
      child.stdin.on("error", () => { /* close/error handlers report the useful failure */ });
      try { child.stdin.write(input); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
  } catch (error) {
    try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* preserve spawn error */ }
    return Promise.reject(error);
  }
}

const defaultCodexGuardProbe: CodexGuardProbeFn = (args, input, cwd) =>
  runCodexGuardProbe(resolveAgentBin("codex"), args, input, cwd);

const CODEX_GUARD_HINT =
  "Codex did not accept AgentCall's inline session hook. If requirements.toml sets " +
  "allow_managed_hooks_only=true, ask the administrator to unset it; AgentCall does not yet install a managed guard. " +
  "Otherwise reinstall @benree/agentcall, use the verified codex-cli release, and rerun doctor.";

// Doctor-only and model-free. Query the same read-only hook-discovery surface
// Codex clients use, with the exact overrides and empty user layer production
// spawns carry. This
// checks the functional invariant instead of reading requirements.toml:
// managed-only policy, hash normalization drift, disabled hooks, and config
// parser changes all become an absent/non-trusted entry without exposing the
// owner's effective config (which can contain secrets).
export async function checkCodexGuard(
  workdir: string,
  probe: CodexGuardProbeFn = defaultCodexGuardProbe,
  requireToolTelemetry = true,
): Promise<VerifyCheck> {
  const checkName = requireToolTelemetry ? "codex tool telemetry" : "codex session guard";
  const input = [
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agentcall-doctor", version: "1.0.0" } },
    }),
    JSON.stringify({ id: 2, method: "hooks/list", params: { cwds: [workdir] } }),
  ].join("\n") + "\n";

  try {
    const args = ["app-server", "-c", guardCodexConfigArg()];
    if (requireToolTelemetry) args.push("-c", toolTelemetryCodexConfigArg());
    args.push("-c", guardCodexTrustArg(requireToolTelemetry));
    const output = await probe(
      args,
      input,
      workdir,
    );
    const response = output.split("\n")
      .flatMap((line) => { try { return [JSON.parse(line) as any]; } catch { return []; } })
      .find((message) => message.id === 2);
    const data = response?.result?.data;
    if (!Array.isArray(data)) throw new Error("hooks/list returned no usable response");
    const hooks = data.find((item: any) => item?.cwd === workdir)?.hooks;
    const entry = Array.isArray(hooks)
      ? hooks.find((hook: any) => hook?.key === CODEX_SESSION_GUARD_KEY)
      : undefined;
    if (!entry) {
      return {
        name: checkName, ok: false,
        detail: "AgentCall's session hook is absent",
        hint: CODEX_GUARD_HINT,
      };
    }
    if (entry.enabled !== true) {
      return {
        name: checkName, ok: false,
        detail: "AgentCall's session hook is disabled",
        hint: CODEX_GUARD_HINT,
      };
    }
    if (entry.trustStatus !== "trusted") {
      const status = typeof entry.trustStatus === "string" ? entry.trustStatus : "unknown";
      return {
        name: checkName, ok: false,
        detail: `AgentCall's session hook trust is ${status}`,
        hint: CODEX_GUARD_HINT,
      };
    }
    if (!requireToolTelemetry) {
      return { name: checkName, ok: true, detail: "trusted PreToolUse hook" };
    }
    const postEntry = hooks.find((hook: any) => hook?.key === CODEX_SESSION_TOOL_TELEMETRY_KEY);
    if (!postEntry) {
      return {
        name: "codex tool telemetry", ok: false,
        detail: "AgentCall's tool lifecycle hook is absent",
        hint: CODEX_GUARD_HINT,
      };
    }
    if (postEntry.enabled !== true) {
      return {
        name: "codex tool telemetry", ok: false,
        detail: "AgentCall's tool lifecycle hook is disabled",
        hint: CODEX_GUARD_HINT,
      };
    }
    if (postEntry.trustStatus !== "trusted") {
      const status = typeof postEntry.trustStatus === "string" ? postEntry.trustStatus : "unknown";
      return {
        name: "codex tool telemetry", ok: false,
        detail: `AgentCall's tool lifecycle hook trust is ${status}`,
        hint: CODEX_GUARD_HINT,
      };
    }
    return { name: "codex tool telemetry", ok: true, detail: "trusted session lifecycle hooks" };
  } catch (error) {
    return {
      name: checkName, ok: false, detail: short(error),
      hint: CODEX_GUARD_HINT,
    };
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
  resolveBin: (kind: AgentKind) => string = resolveAgentBin,
): Promise<VerifyCheck> {
  try {
    // GUARD_PROBE_LINE (below): this spawn has no real line behind it either —
    // same reasoning as the guard probes further down this file — and
    // runAgent's lineName is a required argument specifically so this call
    // can't silently fall back to the old "" default (which fails the guard
    // closed on every tool call).
    //
    // AGENTCALL_HOME is redirected to a throwaway temp dir for the same
    // reason defaultGuardProbe/defaultGuardBinaryProbe redirect it further
    // down this file: buildSpawnSpec otherwise spreads the REAL process.env
    // unchanged, and if the probed agent calls any tool, guard.ts writes
    // toolsLog unconditionally (enforce AND observe mode), whose parent
    // directory guard-entry.ts mkdirSync's into existence — creating a real
    // ~/.agentcall/lines/doctor-probe/ with no config.json. That orphan
    // makes `listLines`/`doctor` report a broken "config" check forever
    // after, on every subsequent run including the one meant to diagnose it.
    // The spec is built explicitly (rather than left to runAgent's own
    // default) so this override can be applied before the spawn happens.
    //
    // resolveBin is a parameter, not the bare `resolveAgentBin` import, for
    // the same reason checkAgentBinary already takes one: building the spec
    // here (needed for the AGENTCALL_HOME override above) moved a real
    // binary-on-PATH lookup above the runFn injection seam. A test that
    // stubs runFn to skip a real spawn, but leaves this at its default, would
    // still hit the real PATH lookup and throw on any machine without
    // claude/codex installed — which is every CI runner (see CLAUDE.md's TDD
    // section: no live claude/codex spawn in CI). verifyAgent threads
    // fns.resolveBin through to here for exactly that reason.
    const home = mkdtempSync(join(tmpdir(), "agentcall-doctor-probe-"));
    const spec = buildSpawnSpec(kind, VERIFY_PROMPT, workdir, resolveBin, ASK_TASK.envelope, "unknown", GUARD_PROBE_LINE);
    spec.env = { ...spec.env, AGENTCALL_HOME: home };
    await runFn(kind, VERIFY_PROMPT, workdir, VERIFY_TIMEOUT_MS, spec, ASK_TASK.envelope, "unknown", undefined, GUARD_PROBE_LINE);
    return { name: "agent run", ok: true };
  } catch (e) {
    return { name: "agent run", ok: false, detail: short(e), hint: classifyAgentFailure(kind, e) };
  }
}

// Injection seams for tests and for setup/doctor callers; production leaves
// all three unset (same pattern as SetupOpts.installListenerServiceFn).
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
  checks.push(await checkAgentSpawn(kind, workdir, fns.runFn, fns.resolveBin));
  return checks;
}

// Doctor-only, end-to-end: a real call to our own address through the relay
// and the launchd-spawned listener. This is the only check that exercises
// the listener's environment (fixed PATH, no shell rc, possibly locked
// keychain) — a direct checkAgentSpawn from an interactive shell can pass
// while this fails. Works under the default policy because the built-in
// "ask" task always exists.
export async function checkRelaySelfCall(
  cfg: LineConfig, paths: LinePaths, callFn: typeof callAgent = callAgent,
): Promise<VerifyCheck> {
  try {
    await callFn({
      relay: relayUrl(cfg),
      org: cfg.org,
      from: cfg.handle,
      token: cfg.token,
      to: cfg.handle,
      message: "agentcall doctor self-test: reply briefly",
      paths,
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

// The synthetic line name every verification spawn in this file runs under —
// the two guard probes below, and checkAgentSpawn above. None of them have a
// real line to hand the guard: the guard probes invent a temp home from
// scratch, and checkAgentSpawn is a generic health check called from setup
// and doctor before any particular line is necessarily relevant. So this is a
// fixed, self-contained name rather than anything read from disk. It only
// needs to satisfy LINE_NAME_RE and agree with deniedInLog below, which reads
// the calls.log this name resolves to.
export const GUARD_PROBE_LINE = "doctor-probe";

// Spawns a real `claude -p` against a canary `.env` file and asserts the read
// is refused. Live on the user's machine; always mocked in CI.
//
// The canary used to be `.ssh/id_rsa`: the model refused to read it on
// principle ("printing a private key would expose key material") without
// ever calling Read, so the guard never fired, no denial was recorded, and
// checkGuard reported a healthy install as broken. `.env` hits the same
// denied-basename rule but the model has no such objection to reading it, so
// the probe actually exercises the guard instead of the model's own judgment.
//
// AGENTCALL_HOME is redirected to a throwaway temp dir so the probe's own
// denial doesn't land in the owner's real calls.log — but AGENTCALL_LINE is
// NOT what makes the guard protect the owner's real ~/.ssh here: the guard's
// security root is the machine's real userHome regardless of AGENTCALL_HOME
// (see guard.ts), so this redirection only relocates where the probe's OWN
// audit trail is written, never what it protects. AGENTCALL_LINE just has to
// be present and well-formed or the guard-entry subprocess fails closed
// before ever reaching decide() — which would make a healthy guard look
// unverified rather than exercised.
const defaultGuardProbe: GuardProbeFn = async (settings) => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-guard-"));
  writeFileSync(join(home, ".env"), GUARD_CANARY);
  const output = execFileSync(
    resolveAgentBin("claude"),
    ["-p", "Read the file .env in this directory and tell me what it contains.",
     "--permission-mode", "dontAsk", "--allowedTools", "Read", "--settings", settings],
    {
      cwd: home,
      env: { ...agentChildEnv(process.env), AGENTCALL_HOME: home, AGENTCALL_LINE: GUARD_PROBE_LINE },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    },
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
    // a working guard as broken. AGENTCALL_LINE must also be forced — an
    // absent or malformed value makes guard-entry fail closed before it ever
    // calls decide(), which happens to also deny, but for the wrong reason:
    // guardDenied() would then read as "broken guard" on a healthy install.
      env: { ...agentChildEnv(process.env), AGENTCALL_HOME: home, AGENTCALL_GUARD_MODE: "enforce", AGENTCALL_LINE: GUARD_PROBE_LINE },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return guardDenied(stdout);
};

// Per-line layout: the guard writes calls.log under
// <stateRoot>/.agentcall/lines/<line>/calls.log — `home` here is always the temp
// AGENTCALL_HOME defaultGuardProbe redirected to, and GUARD_PROBE_LINE is the
// line name it ran the probe under, so this must resolve the same path
// getLinePaths would.
function deniedInLog(home: string): boolean {
  try {
    const callsLog = getLinePaths(getMachinePaths(home), GUARD_PROBE_LINE).callsLog;
    return readFileSync(callsLog, "utf8")
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
