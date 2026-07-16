# Setup verification + `agentcall doctor` — design

Date: 2026-07-16
Status: approved

## Problem

`agentcall setup` verifies only that the agent binary exists on PATH
(`detectAgentKind`), never that it can actually answer a call. The real call
path is very different from an interactive `claude`/`codex` session: a
headless LaunchAgent child, wrapped in the srt sandbox, with a fixed PATH and
no shell rc environment. Auth in particular is invisible until the first real
spawn — on macOS, Claude Code's OAuth token lives in the Keychain and codex's
in `~/.codex/auth.json`, and an unauthenticated or expired credential only
surfaces as `call_failed agent_error` **to the caller**. The owner sees
nothing unless they read `~/.agentcall/calls.log`.

This happened in practice: four inbound calls failed with `agent_error` in
under 2.5s each (instant auth failures) before the owner learned about it
from the caller.

## Goals

- Setup verifies the agent can complete a sandboxed headless run — auth
  included — before claiming success, for **both claude and codex**.
- A standalone `agentcall doctor` re-verifies any time (auth can expire after
  setup) and additionally validates the launchd-listener environment
  end-to-end via a relay self-call.
- Failures print actionable, per-agent-kind fix hints.
- No live agent spawn in CI (repo rule); all checks injectable for tests.

## Non-goals (deferred)

- Listener startup/periodic self-checks and a relay-visible "degraded"
  status (would need protocol + DO changes).
- Non-macOS listener support (repo is launchd-only today).
- Any relay/`packages/shared` changes — this is entirely CLI-side.

## Decisions

| Question | Decision |
| --- | --- |
| Where does verification live? | Both: a setup smoke test and a standalone `agentcall doctor`. |
| Setup smoke test fails? | Setup still completes (config saved, LaunchAgent installed) but ends with a clear "NOT ready" message + hint + `run agentcall doctor when fixed`; exit code 1. Once auth is fixed, calls work without re-running setup (each call spawns a fresh agent). |
| Test depth | Setup: sandboxed spawn check. Doctor: static checks + spawn check + relay self-call (the only check that exercises the launchd environment). |
| Skipping | New `--no-verify` setup flag. `--yes` still verifies. CI/tests use injection seams, never the flag. |

## Architecture

One new module, `packages/cli/src/verify.ts`; `runSetup` and the new
`doctor` command compose checks from it.

```
verify.ts
├── VerifyCheck = { name, ok, detail?, hint? }          // one result row
├── checkAgentBinary(kind)                              // wraps resolveAgentBin
├── checkCodexAuth()                                    // codex only: `codex login status` (free, fast)
├── checkSandboxSpawn(kind, paths, runFn = runAgent)    // real sandboxed spawn
├── classifyAgentFailure(kind, error) -> hint           // stderr/message pattern -> actionable fix
└── checkRelaySelfCall(cfg, paths, callFn = callAgent)  // doctor only
```

`checkSandboxSpawn` calls the existing `runAgent` — the byte-identical spawn
path an inbound call uses (`npx @anthropic-ai/sandbox-runtime@pinned` →
resolved binary → headless flags) — with a 120s timeout and the prompt
`"Reply with exactly: OK"`. A successfully parsed reply is the pass signal;
the reply text is **not** asserted (asserting exact text would flake on
chatty models).

`checkCodexAuth` runs `codex login status` before any paid spawn: it is free
and exits non-zero when logged out, so codex users get an instant "run
`codex login`" without burning a model call. Claude has no free equivalent;
its auth failures are caught by the spawn check.

## Setup integration

In `runSetup`, inside the existing `if (cfg.agent_kind)` block, after
`srt.json` is written and the LaunchAgent installed:

1. Binary check → codex auth pre-check (codex only) → sandbox spawn check.
   Each step runs only if the previous passed (no cascading noise, no wasted
   spawn after a failed pre-check).
2. `--no-verify` skips all verification.
3. Success: current closing message plus
   `✓ agent verified (<kind> answered a sandboxed test call)`.
4. Failure: closing message becomes
   **"agentcall is set up, but your agent is NOT ready to answer calls"**
   with the failing check name, a stderr snippet, the classified hint, and
   "fix it, then run `agentcall doctor` to confirm — calls will start
   working immediately, no setup re-run needed." `process.exitCode = 1`.

Caller-only setups (no `agent_kind`) never verify.

## `agentcall doctor`

Prints one line per check (`✓`/`✗` + hint); exit 0 only if all pass. Ladder
order — each step runs only if the previous passed so the user sees the
first broken layer:

1. **Static:** config exists; callable (`agent_kind` present — otherwise
   report "caller-only — nothing to verify" for the remaining checks and
   stop, exit 0); `srt.json` exists; LaunchAgent loaded (`launchctl list`
   contains the label; darwin-only, skipped elsewhere); relay reachable and
   own handle **online** via the existing `getStatus`. The online-status
   result does not block steps 2–3 (a broken listener shouldn't hide an
   auth problem); it only gates step 4 and the final exit code.
2. **Codex auth** (codex only): `codex login status`.
3. **Sandbox spawn:** same as setup's check.
4. **Relay self-call:** `callAgent` to the agent's own address with message
   `"agentcall doctor self-test: reply briefly"` — through the relay and the
   launchd-spawned listener, catching launchd-env-only failures (fixed PATH,
   locked keychain, missing shell env). Works under the default policy
   because the built-in `ask` task always exists. If step 1 found the handle
   offline, doctor reports that and skips this step rather than waiting out
   the call timeout.

Cost note: doctor makes up to two small LLM calls (spawn + self-call).

## Failure classification

`classifyAgentFailure(kind, error)` matches the `AgentRunError` message
(which already embeds stderr / the parsed error) against per-kind tables:

| Kind | Pattern | Hint |
| --- | --- | --- |
| claude | `Invalid API key`, `Please run /login`, `authentication_error`, `OAuth token has expired` | Log in once: run `claude` interactively and complete `/login` (or `claude setup-token` / set `ANTHROPIC_API_KEY`). |
| codex | `401`, `token_invalidated`, `not logged in`, `codex login` | Run `codex login` (or `codex login --device-auth` on headless machines). |
| either | exit 127 / `command not found` | PATH symlink hint (reuse `warnIfOutsideLaunchdPath` wording). |
| either | `AgentRunError.code === "timeout"` | Agent started but didn't finish — check srt.json's network allowlist / try again. |
| either | no match | Raw stderr snippet, no hint. |

Both kinds already funnel into `AgentRunError`: claude's auth failure exits 0
with `is_error: true` JSON (`parseClaudeJson` throws "claude reported an
error: Invalid API key…"); codex's arrives on stderr with nonzero exit.

## CLI wiring

- `setup`: add `--no-verify` option; new injection seams on `SetupOpts`
  (`verify` fns / `runAgentFn`), same pattern as `installLaunchAgentFn`.
- New `doctor` command in `index.ts`, thin wrapper over `verify.ts` +
  existing `loadConfig`/`getStatus`/`callAgent`.

## Testing (TDD)

- `test/verify.test.ts`:
  - `classifyAgentFailure`: table-driven with real error strings from both
    CLIs (auth, 127, timeout, unknown).
  - `checkSandboxSpawn`: injected fake `runFn` — success, auth error,
    timeout, exit-127.
  - `checkCodexAuth`: injected exec fn — logged in / logged out / binary
    missing.
  - `checkRelaySelfCall`: injected fake `callAgent` — reply, `offline`,
    `agent_error`.
- `test/setup.test.ts` additions:
  - failing verify: config still saved, LaunchAgent still installed,
    NOT-ready message printed, exit code 1.
  - passing verify: success message includes the verified line.
  - `--no-verify` skips; caller-only never verifies.
- No live `claude`/`codex` spawn anywhere in CI.
