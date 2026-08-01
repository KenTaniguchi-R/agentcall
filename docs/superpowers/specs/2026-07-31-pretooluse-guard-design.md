# PreToolUse guard — design

**Date:** 2026-07-31
**Status:** Design approved, not implemented.
**Layer:** #3 of the defence model in
[claude-code-enforcement-surfaces §7](../../research/2026-07-31-claude-code-enforcement-surfaces.md),
the one marked "Gap — the work".
**Also draws on:** [lessons-from-composio](../../research/2026-07-31-lessons-from-composio.md)
§3–§6 — fail-closed inversion, the injected-context contract, and the plugin boundary.

---

## The hole

With the OS sandbox removed on 2026-07-31, the only thing standing between a caller
and the owner's machine is the capability envelope (`runner.ts:30-40`):

```
read:  ["Read","Grep","Glob","LS"]   ← granted on every call, never omitted
write: ["Write","Edit"]
fetch: ["WebFetch","WebSearch"]
exec:  ["Bash"]
```

`read` is unconditional — a task offering nothing but Q&A still permits
`Read ~/.ssh/id_rsa`. That is a wider hole than `exec`, because it is open on every
call rather than only on tasks the owner marked as executing.

`--allowedTools` with `--permission-mode dontAsk` already denies everything *outside*
that list: MCP tools, the Agent tool, and subagent spawns never reach a hook. So this
layer is not about breadth of coverage. It is about depth **inside** the four families
we grant.

## Scope

A **global safety floor**: one fixed guard, identical on every call, independent of
task and caller. It is not a revival of the removed `write_paths`/`network` task fields,
and it does not extend the per-caller `policy.json` vocabulary. Those remain possible
later; they are out of scope here.

## Findings that determined the design

Three live experiments against `claude -p`, not documentation reads. They matter
because two of them contradict what was assumed going in.

**1. `PreToolUse` fires under `--permission-mode dontAsk`, and exit 2 blocks.**
A hook returning exit 2 refused a `Read`, the canary string did not appear in the
result, and the stderr text was surfaced to the model as the reason. The model then
declined to route around it via `cat` or a subagent.

**2. `permissions.deny` rules suppress the hook entirely.**
With a matching deny rule the read was blocked — and the hook never ran. Deny rules do
not sit *beneath* the hook as a backstop; they sit in front of it and short-circuit it.
Any path covered by a deny rule is therefore enforced **silently**, producing no
`calls.log` entry. This is why the guard is hook-only.

**3. Deny-rule path syntax fails silently when wrong.**
`Read(/absolute/path)` did not match; the read succeeded and `permission_denials` was
`[]` — no error, no warning. A control whose misconfiguration is indistinguishable from
success is not a good floor to build on.

**4. The deny reason is relayed to the caller, in the model's own words.**
Whatever the hook returns as its reason is read by the model, and the model is the thing
composing the reply that goes back over the relay. In test 1 the exit-2 stderr text was
quoted verbatim into the answer. The reason string is therefore caller-facing output, not
an internal diagnostic, and has to be written that way.

Structured deny (`permissionDecision: "deny"` with `permissionDecisionReason`, exit 0)
produces a better rendering than exit 2 — "the read was blocked" rather than
"PreToolUse:Read hook error" — so it is the mechanism for ordinary denials.

## Architecture

One catch-all `PreToolUse` hook, registered through inline `--settings` JSON at spawn
time, calling back into the `agentcall` binary.

```
listener.ts  resolveTask() → envelope, call_id
     ↓
runner.ts    buildSpawnSpec() adds:
               --settings '{"hooks":{"PreToolUse":[{"hooks":[…]}]}}'
               env AGENTCALL_CALL_ID=<call_id>
     ↓
claude -p    decides a tool call
     ↓
             hook: `<node> <agentcall> _guard`  ← every tool call, no matcher
     ↓
guard.ts     decide(input, home, realpath) → verdict
     ↓
     allow → exit 0           deny → append calls.log + generic reason, exit 0
                                     ↓
                              model continues, answers without that tool
```

Nothing is installed into `~/.claude`. The settings are a JSON string on the command
line, scoped to the one spawn, gone when the process exits. The owner's own interactive
sessions are untouched.

### Why not the plugin

[lessons-from-composio §6](../../research/2026-07-31-lessons-from-composio.md) proposes a
plugin carrying `hooks.json`, and its action table lists `PreToolUse` among the hooks it
would ship. That is the right vehicle for the *owner-facing* surface — the SessionStart
nudge, `UserPromptSubmit` routing, slash commands — and the wrong one here.

A plugin installs into `~/.claude` and fires on every session the owner runs, including
their own work. This guard is scoped to the agent agentcall spawns to answer somebody
else's call; applying it to the owner's own editing would be both wrong and unwelcome.
Two audiences, two delivery mechanisms, no conflict.

The plugin's own stated principle points the same way — *the plugin stays thin;
capability lives in the CLI*. Keeping `decide()` in `agentcall` is that principle, and it
is why Codex parity later is an adapter rather than a second copy of the policy.

**No `matcher` and no `if` field.** Both narrow which calls reach the hook, and the
matcher parser fails *open* — an argument it cannot evaluate runs the tool anyway. For
a safety floor the gate must not be the thing that can silently disappear. Every tool
call reaches `decide()`; `decide()` alone decides.

## Components

| File | Responsibility |
|---|---|
| `packages/cli/src/guard.ts` **(new)** | `decide()` — pure, agent-agnostic, no I/O. The denied-path table. Plus `runGuard()`, which reads the payload, calls `decide()`, writes the audit line, emits the structured deny on stdout, and returns an exit code. |
| `packages/cli/src/index.ts` | Hidden `_guard` command — a thin wire to `runGuard()`, matching how the other commands stay thin. |
| `packages/cli/src/runner.ts` | `--settings` JSON, `AGENTCALL_CALL_ID` in spawn env, `SpawnSpec.env`. |
| `packages/cli/src/doctor.ts` | Live self-test that the guard actually blocks. |

### `decide()`

```ts
export type GuardInput = { tool_name: string; tool_input: Record<string, unknown> };

// `rule` and `detail` are audit-only — they name the matched rule and the
// resolved path, and MUST NOT reach permissionDecisionReason. The caller-facing
// reason is a single fixed string with no per-denial content; see the reason
// contract below. Keeping it constant is what makes the contract testable.
export type GuardVerdict =
  | { allow: true }
  | { allow: false; rule: string; detail: string };

export function decide(
  input: GuardInput,
  home: string,
  realpath: (p: string) => string,   // injected; fs.realpathSync in production
): GuardVerdict;
```

`realpath` is a parameter rather than an import so the function stays pure and
table-testable, and so symlink evasion (`ln -s ~/.ssh/id_rsa /tmp/x`, then read `/tmp/x`)
is resolved rather than matched textually. `..` traversal normalises the same way.

Agent-agnostic by construction: it takes a tool name and an argument bag, not a Claude
hook payload. Wiring Codex's pre-tool hook to the same function later is an adapter, not
a rewrite.

### The denied set

Read-shaped tools (`Read`, `Grep`, `Glob`, `Write`, `Edit`) expose their target as a
structured argument, so matching is exact:

- `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`, `~/.config/gcloud/**`
- `~/Library/Keychains/**`
- `**/.env`, `**/.env.*`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`
- `**/id_rsa`, `**/id_ed25519`, `**/*.pem`, `**/*.p12`
- `~/.agentcall/**` — holds `config.json` and the relay token; the guard protects its
  own credentials
- `~/.claude/**`, `~/.claude.json` — executable configuration. This is the surface the
  Seatbelt profile used to carve out, and the class of bug behind CVE-2025-59536.

`Bash` is different in kind. Its argument is an opaque command string, so the guard can
only pattern-match it. Denied: any command whose text references a path in the table
above, and four exfiltration shapes — `curl`/`wget` carrying a request body, a pipe into
`sh`/`bash`, `nc`, and `base64` applied to a denied path.

**This is defence-in-depth, not a boundary**, and the spec says so rather than implying
otherwise: obfuscation defeats string matching, and any honest description of `exec` is
that the real control is the owner writing the tasks that grant it.

### Failure behaviour

Two exit paths, deliberately different:

- **Ordinary denial** — exit 0 with `permissionDecision: "deny"`. Reads as a policy
  decision to the model rather than a malfunction.
- **Guard failure** — unparseable stdin, malformed payload, or a throw from `decide()`
  exit **2**, which blocks bluntly. The guard never allows because it failed to decide.

Around the guard, Claude **fails open** in three ways, and each needs its own answer:

| Failure | Result | Answer |
|---|---|---|
| Binary unresolvable | hook never runs, tool proceeds | `doctor` canary check |
| Exit code not 0 or 2 | non-blocking error, tool proceeds | fail-closed exit 2 above |
| **Hook exceeds its timeout** | **abandoned, tool proceeds** | explicit `timeout`, hot path stays cheap |

The timeout case is the one most easily missed. GitHub Copilot CLI has it as a
[documented bug](https://github.com/github/copilot-cli/issues/2893) — under parallel tool
calls the timeout expires, the CLI stops waiting, and the tool executes anyway. A guard
that is merely *slow* is a guard that is not there.

So the hot path is a hard constraint, not a performance goal: `decide()` does no network
I/O, reads no config file, and touches the filesystem only for `realpath`. The hook
registration carries an explicit `timeout`, and a test asserts a decision returns well
inside it. If the guard ever needs state, the Composio split applies — warm a cache on
`SessionStart`, never fetch on the hot path
([lessons-from-composio §3](../../research/2026-07-31-lessons-from-composio.md)).

The binary case is covered at setup time by a `doctor` check that spawns a throwaway
`claude -p` against a canary file and asserts the read is refused. It converts a silent
runtime hole into a loud, diagnosable setup failure — the same job `verify.ts` does for
PATH and auth. Being a live spawn it runs only on the user's machine; per CLAUDE.md no
`claude` process is started in CI.

### Audit record

The guard appends to `calls.log`, matching the existing JSONL shape written by
`listener.ts:37-40`:

```json
{"ts":"2026-07-31T…","type":"tool_denied","call_id":"…","tool":"Read",
 "rule":"ssh-private-keys","detail":"~/.ssh/id_rsa"}
```

`call_id` arrives via `AGENTCALL_CALL_ID`; `AGENTCALL_HOME` is already inherited, so
`getPaths()` resolves correctly with no extra plumbing. Existing call records have no
`type` field, so a reader distinguishes them by its absence — nothing parses `calls.log`
today, so this costs nothing now and is worth fixing whenever one is written.

Denials only. Logging every allowed tool call would bury the signal.

### What the caller learns — the reason is a contract

An earlier draft of this spec claimed the caller sees nothing. That is false, and the
experiments show it: the reason reaches the model, and the model writes the reply that
goes back over the relay. The caller *will* learn a refusal happened.

What is actually achievable is narrower, and it is the thing worth guaranteeing:

> **The guard tells the caller nothing the model did not already know.**

The model knows the filename because it chose the tool call from the caller's own
request; that much is unavoidable and harmless. What must never cross the boundary is
what only the *guard* knows — the resolved absolute path, the rule that matched, or
anything implying the shape of the denied-path table.

So `permissionDecisionReason` is caller-facing output under test, in the manner of
[lessons-from-composio §4](../../research/2026-07-31-lessons-from-composio.md):

- **Required:** states that the action is not permitted by the owner's policy.
- **Forbidden:** any absolute path, any `~/`-prefixed path, any rule identifier, the word
  `.ssh`, or any other denied-path fragment.
- **Bounded:** one sentence.

The specifics stay in `calls.log`, which only the owner reads. A test enforces both
halves — the reason is generic, the audit line is not — because these are exactly the
strings a later edit makes "more helpful" without noticing what it leaks.

## Testing

Test-first, per CLAUDE.md.

- **`test/guard.test.ts` (new)** — table-driven `decide()`: each denied family; symlink
  indirection through a fake `realpath`; `..` traversal; ordinary project paths allowed;
  unknown tool names allowed; malformed input denied. No fs, no spawn.
- **`test/runner.test.ts`** — `buildSpawnSpec` emits `--settings` containing the hook and
  an absolute interpreter path; `AGENTCALL_CALL_ID` reaches `SpawnSpec.env`; codex spawn
  is unchanged. Plus an **exact-hook-set assertion**: the generated settings register
  `PreToolUse` and nothing else, so no hook can be added to a security-carrying payload
  without deliberately editing a test that says so.
- **Reason-text contract** — required phrase present, forbidden fragments absent (no
  absolute path, no `~/`, no rule name, no `.ssh`), one sentence. Asserted over every
  denial case in the table, not on a single hand-picked example.
- **Timeout budget** — a decision returns well inside the registered `timeout`, so the
  fail-open-on-slow path stays unreachable.
- **`test/guard.test.ts`** — also covers `runGuard()` against a temp `AGENTCALL_HOME`:
  exits 0 vs 2, and writes exactly one audit line on deny, none on allow.
- **`test/doctor.test.ts`** — the self-test reports pass/fail correctly against a mocked
  spawn.

`pnpm -r test && pnpm -r typecheck && pnpm -r build` before done. Note that `typecheck`
does not cover `test/`, so a signature change to `buildSpawnSpec` shows up only in the
test run.

## Deliberately not in scope

- Per-task `write_paths`/`network`. Removed on 2026-07-31; not being re-added here.
- Per-caller tool-level policy.
- The `ConfigChange` hook (layer 4). Separate, cheap, and a natural follow-on — the
  `~/.claude/**` read denial above overlaps its territory but does not replace it.
- Codex. `decide()` is agent-agnostic so parity is wiring, but Codex answering agents
  have **no read guard** until it is done, and the README must say so.

## Open questions

1. **Which deny-rule path form actually matches.** Experiment 2 passed `Read(./rel)` and
   `Read(//abs)` together and did not isolate them. Only matters if the deny-rule
   backstop is revisited.
2. **Whether `sandbox.filesystem.denyRead` covers the `Read` tool** or only Bash. It is
   documented with a `denyRead:["~/"] / allowRead:["."]` example, contradicting the
   research doc's `[unverified]` note that native sandboxing is Bash-only. If it does
   cover Read, it is a cheaper floor than this guard and worth measuring before the
   denied-path table grows.
3. **Hook process cost per tool call.** One Node start per call is fine for Q&A, less
   obviously fine for an exec-heavy task. Measure before optimising; the `if` field is
   *not* the fix, for the fails-open reason above.
